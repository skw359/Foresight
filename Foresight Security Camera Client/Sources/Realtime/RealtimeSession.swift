//
//  RealtimeSession.swift
//  Foresight Camera Client
//
//  The realtime brain. Owns the LiveKit Room: connects with the /rt/token
//  publisher token, publishes camera + mic, applies and acks inbound `command`
//  messages, broadcasts `state` on every change and `telemetry` every ~5s,
//  routes viewer PTT audio to the loudspeaker, and tracks viewerCount.
//
//  It SUPERVISES the connection: once streaming is wanted, a failed start, an
//  exhausted SDK reconnect, or a server/LiveKit restart is retried with capped
//  exponential backoff (1 s → 60 s, jittered), and a network change or app
//  activation retries immediately. Only an explicit stop() ends it. The intent
//  is persisted, so a relaunch resumes streaming. It also steps capture quality
//  down while the phone is hot.
//
//  The @Published properties drive the camera-mode UI.
//

import Combine
import Foundation
import LiveKit
import Network

enum StreamStatus: Equatable {
    case idle
    case connecting
    case streaming
    case reconnecting
    case offline(String?)   // optional reason

    var label: String {
        switch self {
        case .idle: return "Offline"
        case .connecting: return "Connecting"
        case .streaming: return "Streaming"
        case .reconnecting: return "Reconnecting"
        case .offline: return "Offline"
        }
    }

    /// The `.offline` reason (e.g. "Waiting for key…"), nil otherwise.
    var detail: String? {
        if case .offline(let reason) = self { return reason }
        return nil
    }
}

/// Lets the command handler ack precisely, in particular surfacing the 4K
/// fallback to viewers.
private enum QualityChangeOutcome { case ok, failed, fellBackFrom4K }

@MainActor
final class RealtimeSession: NSObject, ObservableObject {
    // MARK: Published UI state
    @Published private(set) var status: StreamStatus = .idle
    @Published private(set) var viewerCount: Int = 0
    @Published private(set) var viewerSpeaking: Bool = false
    @Published private(set) var lastError: String?

    // Current camera state mirrored to the protocol `state` message.
    @Published private(set) var torchOn: Bool = false
    @Published private(set) var lens: Double = 1.0
    @Published private(set) var zoom: Double = 1.0
    @Published private(set) var quality: QualityPreset = .auto
    @Published private(set) var recording: Bool = false

    /// Exposed so the UI renders a preview that matches exactly what is published.
    @Published private(set) var previewTrack: LocalVideoTrack?

    // MARK: Dependencies / config
    private let paired: PairedCamera
    private let backend: BackendClient
    private let camera: CameraController
    private let telemetry: DeviceTelemetry

    private let room: Room
    private var telemetryTimer: Timer?

    /// The LiveKit shared-key provider while this Home is E2EE-activated (nil for
    /// a plaintext, non-activated Home). Held so rotation can re-apply the key
    /// live (`setKey`) without republishing.
    private var keyProvider: BaseKeyProvider?

    // MARK: Supervisor

    static let wantsStreamingKey = "foresight.camera.wantsStreaming"

    /// Whether streaming is WANTED (persisted). The supervisor keeps retrying
    /// while this is true; only an explicit `stop()` clears it.
    @Published private(set) var wantsStreaming: Bool

    /// nil when no retry is scheduled.
    @Published private(set) var nextRetryAt: Date?

    /// The pending retry (backoff, or the 5 s awaiting-key poll).
    private var retryTask: Task<Void, Never>?
    private var retryAttempt = 0

    /// Wakes the supervisor as soon as a usable network path appears.
    private let pathMonitor = NWPathMonitor()

    /// Periodic E2EE backstop while streaming: re-checks the Home's key epoch
    /// so a missed `rekey` (activation, rotation, disable) still converges.
    private var epochCheckTask: Task<Void, Never>?
    private static let epochCheckInterval: UInt64 = 5 * 60 * 1_000_000_000

    // MARK: Thermal policy

    /// The quality the user/viewers chose, restored once the phone cools down.
    private var qualityBeforeThermalStep: QualityPreset?
    private var thermalObserver: NSObjectProtocol?

    /// Kept so we can unpublish on a publish-mode change (entering/leaving 4K).
    private var videoPublication: LocalTrackPublication?

    /// Whether the *currently published* track is the 4K single (non-simulcast)
    /// layer. We only unpublish/republish when this is about to change — switching
    /// among the simulcast presets (auto/480/1080/Max) keeps the same publication
    /// and just reconfigures the live capturer, so viewers never lose their feed.
    private var isPublishingSingleLayer = false

    private var subscribedViewerAudio: Set<Track.Sid> = []

    /// Identities of viewers currently in push-to-talk with THIS camera. A
    /// viewer's mic is subscribed only while their identity is in this set, so a
    /// viewer talking to a different camera is never played here. (All cameras
    /// share one room, so the SFU offers every viewer's mic to every camera —
    /// this set is what actually enforces per-camera targeting.)
    private var talkingViewerIdentities: Set<String> = []

    /// The most recently queued gate pass; each new pass awaits it so passes
    /// never overlap (see `scheduleAudioGate`).
    private var gateTask: Task<Void, Never>?

    init(paired: PairedCamera, telemetry: DeviceTelemetry) {
        self.paired = paired
        self.backend = BackendClient(serverUrl: paired.serverUrl)
        self.camera = CameraController(capabilities: paired.capabilities)
        self.telemetry = telemetry
        self.room = Room()
        self.wantsStreaming = UserDefaults.standard.bool(forKey: Self.wantsStreamingKey)
        super.init()

        self.lens = camera.activeLens
        self.room.add(delegate: self)

        // A network path coming back (router reboot, Wi-Fi rejoin) retries now
        // instead of waiting out the backoff. Delivered on the MAIN queue: this
        // closure is formed in a @MainActor initializer, and Swift 6 traps if a
        // main-actor-isolated closure is invoked from a background queue.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in self?.nudge(reason: "network available") }
        }
        pathMonitor.start(queue: .main)

        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.applyThermalPolicy() }
        }
    }

    /// Release the network monitor + observers (the session is being discarded).
    func invalidate() {
        pathMonitor.cancel()
        if let thermalObserver { NotificationCenter.default.removeObserver(thermalObserver) }
        thermalObserver = nil
        retryTask?.cancel()
        retryTask = nil
        epochCheckTask?.cancel()
        epochCheckTask = nil
    }

    var cameraId: String { paired.cameraId }
    var cameraName: String { paired.name }
    var capabilities: CameraCapabilities { paired.capabilities }

    // MARK: Lifecycle

    /// Go live and KEEP going: remember that streaming is wanted (persisted
    /// across launches), then connect. Failures are retried by the supervisor.
    func start() async {
        setWantsStreaming(true)
        cancelRetry()
        retryAttempt = 0
        await connect()
    }

    /// Explicit stop: the ONLY thing that ends supervision.
    func stop() async {
        setWantsStreaming(false)
        cancelRetry()
        await disconnect()
    }

    /// Something suggests a retry could succeed now (network back, app became
    /// active, relaunch): skip the rest of the backoff.
    func nudge(reason: String) {
        guard wantsStreaming else { return }
        switch status {
        case .streaming, .connecting, .reconnecting: return
        case .idle, .offline: break
        }
        print("[Foresight Camera] supervisor nudge: \(reason)")
        cancelRetry()
        retryAttempt = 0
        Task { await self.connect() }
    }

    private func setWantsStreaming(_ on: Bool) {
        wantsStreaming = on
        UserDefaults.standard.set(on, forKey: Self.wantsStreamingKey)
    }

    private func cancelRetry() {
        retryTask?.cancel()
        retryTask = nil
        nextRetryAt = nil
    }

    /// 1, 2, 4 … 60 s, ±20 % jitter so a fleet of cameras doesn't reconnect in lockstep.
    static func backoffDelay(attempt: Int) -> TimeInterval {
        let base = min(60.0, pow(2.0, Double(min(max(attempt, 0), 6))))
        return base * Double.random(in: 0.8...1.2)
    }

    private func scheduleRetry(reason: String?, fixedDelay: TimeInterval? = nil) {
        guard wantsStreaming else { return }
        retryTask?.cancel()
        let delay = fixedDelay ?? Self.backoffDelay(attempt: retryAttempt)
        if fixedDelay == nil { retryAttempt += 1 }
        let fireAt = Date().addingTimeInterval(delay)
        nextRetryAt = fireAt
        let retryText = "retrying in \(Int(delay.rounded()))s"
        status = .offline([reason, retryText].compactMap { $0 }.joined(separator: " — "))
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.retryTask = nil
            self.nextRetryAt = nil
            await self.connect()
        }
    }

    private func connect() async {
        guard wantsStreaming else { return }
        guard status != .streaming, status != .connecting else { return }
        status = .connecting
        lastError = nil

        do {
            let rt = try await backend.realtimeToken(homeId: paired.homeId, deviceSecret: paired.deviceSecret)

            // E2EE gate. keyEpoch is the discriminator; sealedHomeKey/keyEpoch/
            // SealedKey.epoch are server bookkeeping and NEVER a LiveKit key
            // index (that stays 0).
            let epoch = rt.keyEpoch ?? 0
            if epoch >= 1 {
                guard let sealed = rt.sealedHomeKey else {
                    // Activated Home, but our sealed copy isn't ready yet. NEVER
                    // publish plaintext into an activated Home — poll every 5 s.
                    keyProvider = nil
                    scheduleRetry(reason: "Waiting for key…", fixedDelay: 5)
                    return
                }
                // Unseal the HMK and apply it to a shared-key provider BEFORE we
                // connect/publish. Applied as the base64 STRING at key index 0.
                let hmk = try CameraKeyManager.unseal(sealed.ciphertext)
                let provider = Self.makeKeyProvider()
                provider.setKey(key: hmk.base64EncodedString(), index: Int32(ForesightE2EE.keyIndex))
                keyProvider = provider
            } else {
                // Home not activated → plaintext.
                keyProvider = nil
            }

            // See the configurator at the bottom of this file for why `E2EEOptions`
            // is deliberate. E2EE is off for a non-activated Home (nil provider).
            let roomOptions = mediaOnlyE2EE.roomOptions(
                defaultVideoPublishOptions: camera.publishOptions(for: quality),
                keyProvider: keyProvider
            )
            let connectOptions = ConnectOptions(
                // Do NOT auto-subscribe: in a shared Home room that would pull in
                // every other camera's audio (cameras hearing each other) and
                // every viewer's mic regardless of target. We manually subscribe
                // a viewer's mic only while they're talking to us — see the PTT
                // gate (`applyAudioGate`).
                autoSubscribe: false,
                reconnectAttempts: 30
            )

            try await room.connect(
                url: rt.livekitUrl,
                token: rt.token,
                connectOptions: connectOptions,
                roomOptions: roomOptions
            )

            // Participants already in the room arrive with the join and never
            // fire didPublishTrack, so gate their tracks now (see applyAudioGate).
            scheduleAudioGate()

            try await publishTracks()
            startTelemetry()
            startEpochCheck()
            recomputeViewerCount()
            status = .streaming
            retryAttempt = 0
            nextRetryAt = nil
            broadcastState()
            await applyThermalPolicy()
        } catch {
            lastError = error.localizedDescription
            // Leave the half-open room cleanly before the next attempt.
            await room.disconnect()
            previewTrack = nil
            scheduleRetry(reason: error.localizedDescription)
        }
    }

    /// Tear down publishing and disconnect (does NOT change the streaming intent).
    private func disconnect() async {
        // Mark idle FIRST so the delegate's .disconnected callback for this
        // intentional teardown isn't mistaken for a dropped connection.
        status = .idle
        stopTelemetry()
        stopEpochCheck()
        await room.disconnect()
        previewTrack = nil
        keyProvider = nil
        status = .idle
    }

    /// Reconnect (e.g. E2EE switched on/off: frame encryption is fixed per connection).
    private func restart() async {
        await disconnect()
        await connect()
    }

    // MARK: E2EE (locked contract)

    /// Build the shared-key provider with EXPLICIT options sourced from the locked
    /// contract constants — never trusting SDK defaults. This is the explicit form
    /// of `BaseKeyProvider(isSharedKey: true)`: sharedKey true, ratchetSalt
    /// "LKFrameEncryptionKey", ratchetWindowSize 0. keyDerivationAlgorithm stays
    /// .pbkdf2 (the base64-string cross-platform path) and keyRingSize/failure
    /// tolerance keep the SDK defaults, which match the contract.
    private static func makeKeyProvider() -> BaseKeyProvider {
        let options = KeyProviderOptions(
            sharedKey: true,
            ratchetSalt: Data(ForesightE2EE.ratchetSalt.utf8),
            ratchetWindowSize: Int32(ForesightE2EE.ratchetWindowSize)
        )
        return BaseKeyProvider(options: options)
    }

    /// A `rekey` arrived (from the server, or the rotating owner's client): the
    /// Home's key state changed. Re-fetch our sealed copy and converge.
    private func handleRekey(_ rekey: RekeyMessage) async {
        _ = rekey   // `epoch` is a hint; the server's /rt/token answer is the truth
        await reconcileKeyState()
    }

    /// Converge this session on the Home's CURRENT key state (rekey handler and
    /// the periodic backstop):
    ///  - plaintext session, Home now activated → reconnect encrypted (E2EE-01:
    ///    otherwise a connected camera keeps streaming plaintext for days);
    ///  - encrypted session, Home turned off → reconnect plaintext;
    ///  - encrypted session, key rotated → re-apply the new key live at index 0
    ///    (no republish). `epoch` is server bookkeeping, never a key index.
    private func reconcileKeyState() async {
        guard status == .streaming else { return }
        let provider = keyProvider
        for attempt in 0 ..< 5 {
            do {
                let rt = try await backend.realtimeToken(homeId: paired.homeId, deviceSecret: paired.deviceSecret)
                // A concurrent rekey (or a stop) already moved this session on.
                guard status == .streaming, keyProvider === provider else { return }
                let epoch = rt.keyEpoch ?? 0
                guard let provider else {
                    if epoch >= 1 {
                        print("[Foresight Camera][E2EE] Home activated while streaming plaintext — reconnecting encrypted")
                        await restart()
                    }
                    return
                }
                if epoch == 0 {
                    // Claim the switch before suspending so a concurrent rekey
                    // bails at the guard above instead of restarting again.
                    keyProvider = nil
                    await restart()
                    return
                }
                if let sealed = rt.sealedHomeKey {
                    let hmk = try CameraKeyManager.unseal(sealed.ciphertext)
                    provider.setKey(key: hmk.base64EncodedString(), index: Int32(ForesightE2EE.keyIndex))
                    return
                }
            } catch {
                lastError = "Rekey failed: \(error.localizedDescription)"
            }
            // Our new sealed copy may land a moment after the rotation commits.
            try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 2_000_000_000)
        }
    }

    private func startEpochCheck() {
        epochCheckTask?.cancel()
        epochCheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.epochCheckInterval)
                guard let self, !Task.isCancelled else { return }
                await self.reconcileKeyState()
            }
        }
    }

    private func stopEpochCheck() {
        epochCheckTask?.cancel()
        epochCheckTask = nil
    }

    // MARK: Thermal policy

    /// Step the encode down while the phone is hot and restore it once it cools:
    /// `.serious` caps at 1080p (drops 4K/Max), `.critical` drops to 480p. A
    /// phone that throttles itself into a shutdown is a dead camera, and
    /// sustained heat on a permanently-charging phone ages the battery.
    private func applyThermalPolicy() async {
        guard status == .streaming else { return }
        let thermal = ProcessInfo.processInfo.thermalState
        let cap: QualityPreset?
        switch thermal {
        case .critical: cap = .p480
        case .serious: cap = (quality == .max || quality == .pure4k) ? .p1080 : nil
        default: cap = nil
        }
        if let cap {
            guard quality != cap else { return }
            if qualityBeforeThermalStep == nil { qualityBeforeThermalStep = quality }
            print("[Foresight Camera] thermal \(thermal.rawValue): stepping quality down to \(cap.rawValue)")
            _ = await applyQuality(cap)
            broadcastState()
        } else if let restore = qualityBeforeThermalStep, thermal == .nominal || thermal == .fair {
            qualityBeforeThermalStep = nil
            print("[Foresight Camera] cooled down: restoring quality \(restore.rawValue)")
            _ = await applyQuality(restore)
            broadcastState()
        }
    }

    private func publishTracks() async throws {
        let tracks = camera.makeTracks(quality: quality)
        previewTrack = tracks.video

        let local = room.localParticipant
        videoPublication = try await local.publish(videoTrack: tracks.video, options: camera.publishOptions(for: quality))
        _ = try await local.publish(audioTrack: tracks.audio)

        torchOn = camera.torchOn
        lens = camera.activeLens
        zoom = camera.activeZoom
    }

    // MARK: Command handling

    private func handle(command: CommandMessage, from sender: Participant?) async {
        // Authorization: only obey commands targeted at us from a VIEWER peer.
        // Sender-less data (which only the server API can produce) and other
        // cameras are refused — the role comes from server-signed metadata.
        guard command.target == paired.cameraId else { return }
        guard let sender, isViewer(sender) else { return }

        var ok = true
        var ackError: String?

        switch command.action {
        case .torch:
            let on = command.args?.on ?? false
            ok = camera.setTorch(on: on)
            if ok { torchOn = on } else { ackError = "Torch unavailable" }

        case .switchLens:
            if let factor = command.args?.lens {
                ok = await camera.switchLens(toFactor: factor, quality: quality)
                if ok { lens = camera.activeLens; zoom = camera.activeZoom }
                else { ackError = "Lens \(factor)x unavailable" }
            } else { ok = false; ackError = "Missing lens" }

        case .setZoom:
            if let z = command.args?.zoom {
                ok = camera.setZoom(z)
                if ok { zoom = camera.activeZoom } else { ackError = "Zoom failed" }
            } else { ok = false; ackError = "Missing zoom" }

        case .setQuality:
            if let q = command.args?.quality {
                // An explicit choice replaces any thermal step-down memory.
                qualityBeforeThermalStep = nil
                switch await applyQuality(q) {
                case .ok:
                    ok = true
                case .failed:
                    ok = false; ackError = "Quality change failed"
                case .fellBackFrom4K:
                    // The viewers display this verbatim; the broadcast state
                    // (quality = 1080p) is what moves their selection back.
                    ok = false; ackError = "An error occurred while starting 4K streaming."
                }
            } else { ok = false; ackError = "Missing quality" }

        case .talkStart:
            setViewer(sender, speaking: true)

        case .talkStop:
            setViewer(sender, speaking: false)

        case .startRecord:
            // Recording is viewer-side: just track + ack.
            recording = true

        case .stopRecord:
            recording = false

        case .snapshotHint:
            // Advisory only; nothing to do on-device.
            break

        case .alarm:
            let on = command.args?.on ?? true
            if on { AlarmPlayer.shared.play() } else { AlarmPlayer.shared.stop() }
        }

        await sendAck(commandId: command.id, ok: ok, error: ackError)

        switch command.action {
        case .snapshotHint: break
        default: broadcastState()
        }
    }

    private func applyQuality(_ q: QualityPreset) async -> QualityChangeOutcome {
        if camera.publishesSingleLayer(for: q) {
            // "Max" on a 4K-capable device is a single non-simulcast 4K layer, so
            // it needs a republish (the publish *structure* changes). If the
            // capture reconfigure or the publish fails, fall back to the reliable
            // 1080p simulcast so the viewer always gets video back, and report
            // the fallback so the UI can show the preset it landed on.
            quality = q
            if await camera.applyQuality(q) {
                do {
                    try await republishVideo(for: q)
                    isPublishingSingleLayer = true
                    return .ok
                } catch {
                    lastError = "4K publish failed: \(error.localizedDescription)"
                }
            } else {
                lastError = "4K capture unavailable"
            }
            quality = .p1080
            _ = await camera.applyQuality(.p1080)
            try? await republishVideo(for: .p1080)
            isPublishingSingleLayer = false
            return .fellBackFrom4K
        }

        // Switching among the simulcast presets (auto/480/1080, and Max on a
        // camera with no 4K sensor): re-dimension the LIVE capturer and DO NOT
        // unpublish/republish. The simulcast ladder stays up, viewers pin their
        // own layer, and dynacast pauses unused layers. Unpublishing here dropped
        // every viewer to "Connecting feed…": a re-published, already-unpublished
        // track instance does not reliably re-propagate to subscribers.
        quality = q
        let captureOK = await camera.applyQuality(q)

        // Exception: leaving single-layer 4K back to a simulcast preset changes
        // the publish structure, so republish once with a fresh track.
        if isPublishingSingleLayer {
            do {
                try await republishVideo(for: q)
                isPublishingSingleLayer = false
            } catch {
                lastError = "Quality republish failed: \(error.localizedDescription)"
                try? await republishVideo(for: q)
                isPublishingSingleLayer = false
            }
        }
        return captureOK ? .ok : .failed
    }

    /// Unpublish the current video track and publish a FRESH one. Used ONLY when
    /// crossing the single-layer 4K boundary (simulcast ↔ single layer).
    ///
    /// A fresh track is built because re-publishing an already-unpublished
    /// `LocalVideoTrack` does not reliably re-propagate to subscribers. Throws if
    /// the publish fails so callers can recover (e.g. the 4K → 1080p fallback).
    private func republishVideo(for preset: QualityPreset) async throws {
        let local = room.localParticipant
        if let publication = videoPublication {
            try? await local.unpublish(publication: publication, notify: true)
            videoPublication = nil
        }
        let fresh = await camera.rebuildVideoTrack(quality: preset)
        previewTrack = fresh
        videoPublication = try await local.publish(videoTrack: fresh, options: camera.publishOptions(for: preset))
        // Device-tied controls must be re-applied to the new capture device.
        _ = camera.setZoom(zoom)
        if torchOn { _ = camera.setTorch(on: torchOn) }
    }

    // MARK: PTT (push-to-talk)
    //
    // All cameras in a Home share ONE room, so the SFU makes a viewer's mic
    // available to EVERY camera. Targeting is therefore enforced here, on the
    // camera: we manually subscribe a viewer's audio ONLY while that viewer is in
    // push-to-talk with *this* camera. `viewerSpeaking` (UI + `state.talking`) is
    // "is `talkingViewerIdentities` non-empty". Viewers publish their mic on the
    // first press and only MUTE it on release, so the track usually outlives the
    // talk; the gate is what keeps it silent here. We (re)gate when a command
    // arrives, when we (re)connect, and whenever a remote track is published or
    // subscribed.

    /// `sender` must be the viewer peer that sent the talkStart/talkStop — we
    /// scope the audio subscription to exactly that viewer.
    private func setViewer(_ sender: Participant?, speaking: Bool) {
        guard let sender, isViewer(sender),
              let identity = sender.identity?.stringValue else { return }
        if speaking {
            talkingViewerIdentities.insert(identity)
            // Keep playback routed to the loudspeaker so the viewer is heard in the room.
            AudioManager.shared.isSpeakerOutputPreferred = true
        } else {
            talkingViewerIdentities.remove(identity)
        }
        viewerSpeaking = !talkingViewerIdentities.isEmpty
        scheduleAudioGate()
    }

    private func isTalkingViewer(_ participant: Participant) -> Bool {
        guard let identity = participant.identity?.stringValue else { return false }
        return talkingViewerIdentities.contains(identity)
    }

    /// The only remote media this camera ever plays: the mic of a viewer who is
    /// in push-to-talk with us. Everything else — other cameras' mic and video,
    /// viewer mics aimed at a different camera — stays unsubscribed.
    private func shouldSubscribe(_ publication: RemoteTrackPublication, of participant: RemoteParticipant) -> Bool {
        publication.kind == .audio && isTalkingViewer(participant)
    }

    /// Queue a gate pass behind any pass already in flight. Passes run one at a
    /// time and each reads the talking set when it starts, so a quick
    /// talkStart → talkStop can't interleave two `set(subscribed:)` calls and
    /// leave a mic subscribed after the talk ended.
    private func scheduleAudioGate() {
        let previous = gateTask
        gateTask = Task { [weak self] in
            await previous?.value
            await self?.applyAudioGate()
        }
    }

    /// Give EVERY remote publication an explicit subscription decision.
    ///
    /// Explicit matters: the SDK treats a publication we never called
    /// `set(subscribed:)` on as wanted, and on a quick reconnect (resume) it asks
    /// the SFU to subscribe all of them — autoSubscribe off notwithstanding.
    /// Gating only viewer mics left every other camera's mic in that set, so a
    /// Wi-Fi blip made this camera play the other cameras out of its loudspeaker,
    /// and cameras within earshot of each other fed back.
    private func applyAudioGate() async {
        for participant in room.remoteParticipants.values {
            for case let publication as RemoteTrackPublication in participant.trackPublications.values {
                await gate(publication, on: shouldSubscribe(publication, of: participant))
            }
        }
    }

    /// Apply the playback gate to one remote publication. With autoSubscribe
    /// off, the subscription IS the gate: subscribing delivers the track (enabled
    /// by default) so it plays out the speaker; unsubscribing clears it so playback
    /// stops immediately. We deliberately do NOT call `set(enabled:)` — it throws
    /// until the track is actually subscribed (and `set(subscribed:)` returns
    /// before delivery completes), so subscribe/unsubscribe alone is both correct
    /// and race-free for momentary PTT.
    private func gate(_ publication: RemoteTrackPublication, on: Bool) async {
        do {
            try await publication.set(subscribed: on)
            if on {
                subscribedViewerAudio.insert(publication.sid)
            } else {
                subscribedViewerAudio.remove(publication.sid)
            }
        } catch {
            if on {
                lastError = "Viewer audio subscribe failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: Outbound messages

    private func sendAck(commandId: String, ok: Bool, error: String?) async {
        let ack = AckMessage(commandId: commandId, ok: ok, error: error)
        await publish(.ack(ack), reliable: true, to: [])
    }

    func broadcastState() {
        let state = StateMessage(
            cameraId: paired.cameraId,
            torchOn: torchOn,
            lens: lens,
            zoom: zoom,
            quality: quality,
            recording: recording,
            talking: viewerSpeaking
        )
        Task { await publish(.state(state), reliable: true, to: []) }
    }

    private func sendTelemetry() {
        telemetry.refresh()
        let snap = telemetry.snapshot
        let msg = TelemetryMessage(
            cameraId: paired.cameraId,
            battery: snap.battery,
            charging: snap.charging,
            wifi: snap.wifi,
            thermal: snap.thermal,
            viewerCount: viewerCount
        )
        Task { await publish(.telemetry(msg), reliable: true, to: []) }
    }

    private func publish(_ message: DataMessage, reliable: Bool, to identities: [String]) async {
        guard let data = ForesightCodec.encode(message) else { return }
        let options = DataPublishOptions(
            destinationIdentities: identities.map { Participant.Identity(from: $0) },
            reliable: reliable
        )
        do {
            try await room.localParticipant.publish(data: data, options: options)
        } catch {
            // Non-fatal: telemetry/state will resend on the next tick/change.
        }
    }

    // MARK: Telemetry timer

    private func startTelemetry() {
        stopTelemetry()
        sendTelemetry()
        let timer = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sendTelemetry() }
        }
        RunLoop.main.add(timer, forMode: .common)
        telemetryTimer = timer
    }

    private func stopTelemetry() {
        telemetryTimer?.invalidate()
        telemetryTimer = nil
    }

    // MARK: Viewer accounting

    private func isViewer(_ participant: Participant) -> Bool {
        guard let metadata = participant.metadata,
              let data = metadata.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(ParticipantMetadata.self, from: data)
        else {
            // Metadata absent: fall back to identity prefix parsing.
            if let id = participant.identity?.stringValue {
                return Foresight.parseIdentity(id)?.role == .viewer
            }
            return false
        }
        return parsed.role == .viewer
    }

    private func recomputeViewerCount() {
        let count = room.remoteParticipants.values.filter { isViewer($0) }.count
        if count != viewerCount {
            viewerCount = count
        }
    }
}

// MARK: - RoomDelegate

extension RealtimeSession: RoomDelegate {
    nonisolated func room(_ room: Room, didUpdateConnectionState state: ConnectionState, from oldValue: ConnectionState) {
        Task { @MainActor in
            switch state {
            case .connected:
                if self.status != .streaming { self.status = .streaming }
            case .reconnecting:
                self.status = .reconnecting
            case .disconnected:
                // A LIVE session dropped (the SDK gave up reconnecting, the
                // server or LiveKit restarted, the network vanished). An
                // intentional teardown set status to .idle first, so it never
                // lands here. The supervisor brings the camera back.
                if self.status == .streaming || self.status == .reconnecting {
                    self.stopTelemetry()
                    self.stopEpochCheck()
                    self.previewTrack = nil
                    self.scheduleRetry(reason: "Connection lost")
                }
            case .connecting:
                self.status = .connecting
            case .disconnecting:
                // Teardown in progress; `.disconnected` follows and decides
                // whether to surface offline.
                break
            @unknown default:
                break
            }
        }
    }

    nonisolated func roomDidReconnect(_ room: Room) {
        Task { @MainActor in
            self.status = .streaming
            // A reconnect drops any in-flight PTT (the talkStart won't be
            // resent), so clear the gate and require a fresh talkStart. This also
            // unsubscribes any viewer audio that lingered across the blip, and
            // gates the publications a full reconnect rebuilt from scratch.
            self.talkingViewerIdentities.removeAll()
            self.viewerSpeaking = false
            self.scheduleAudioGate()
            // Viewers resync after a blip.
            self.broadcastState()
            self.recomputeViewerCount()
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor in
            // Retry scheduling happens in the .disconnected state transition
            // above (it knows whether the drop was intentional); just record why.
            if let error { self.lastError = error.localizedDescription }
        }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor in self.recomputeViewerCount() }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor in
            // If a viewer drops mid-talk (no talkStop), clear their gate so
            // `viewerSpeaking` / `state.talking` don't get stuck on.
            if let id = participant.identity?.stringValue,
               self.talkingViewerIdentities.remove(id) != nil {
                self.viewerSpeaking = !self.talkingViewerIdentities.isEmpty
                self.broadcastState()
            }
            self.recomputeViewerCount()
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didPublishTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            // Any new track — a viewer's mic, another camera's mic or video —
            // gets an explicit decision right away: subscribed only if it's the
            // mic of a viewer talking to us. autoSubscribe off is NOT enough on
            // its own; an undecided track is re-subscribed on resume.
            self.scheduleAudioGate()
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didUnpublishTrack publication: RemoteTrackPublication) {
        Task { @MainActor in _ = self.subscribedViewerAudio.remove(publication.sid) }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didSubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            // Backstop: if a track we didn't ask for got subscribed anyway (a
            // resume, or a talkStop that raced the subscribe), drop it before
            // it plays out of the loudspeaker.
            guard !self.shouldSubscribe(publication, of: participant) else { return }
            self.scheduleAudioGate()
        }
    }

    nonisolated func room(_ room: Room, participant: Participant, didUpdateMetadata metadata: String?) {
        Task { @MainActor in self.recomputeViewerCount() }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        Task { @MainActor in
            // A camera consumes only `command` and `rekey`; ack/state/telemetry
            // are outbound-only for it. Decode validates shape + protocol
            // version; the sender rule is shared with every other client
            // (Foresight.isAuthorizedSender).
            guard let message = ForesightCodec.decode(data),
                  Foresight.isAuthorizedSender(message, senderIdentity: participant?.identity?.stringValue)
            else { return }
            switch message {
            case .command(let command):
                await self.handle(command: command, from: participant)
            case .rekey(let rekey):
                await self.handleRekey(rekey)
            case .ack, .state, .telemetry:
                break
            }
        }
    }
}

// MARK: - Media-only E2EE room options
//
// Media-only E2EE on purpose: LiveKit's replacement `EncryptionOptions` also
// encrypts the data channel, which would break commands/state/rekey against the
// viewer/web/recorder until all four clients migrate together (deferred to v2 —
// same reasoning as the viewer app's RoomManager).
// `E2EEOptions` is therefore used deliberately. The protocol indirection
// silences just that deprecation warning: a deprecated witness called through
// a non-deprecated protocol requirement does not re-emit it.

private protocol MediaOnlyE2EEConfiguring: Sendable {
    func roomOptions(defaultVideoPublishOptions: VideoPublishOptions,
                     keyProvider: BaseKeyProvider?) -> RoomOptions
}

private struct MediaOnlyE2EEConfigurator: MediaOnlyE2EEConfiguring {
    @available(*, deprecated, message: "Deliberate media-only E2EEOptions until the v2 data-channel rollout.")
    func roomOptions(defaultVideoPublishOptions: VideoPublishOptions,
                     keyProvider: BaseKeyProvider?) -> RoomOptions
    {
        // One PeerConnection is fine for publish-only; enable dynacast so the
        // SFU pauses layers no viewer is watching.
        RoomOptions(
            defaultVideoPublishOptions: defaultVideoPublishOptions,
            adaptiveStream: false,        // we are the publisher; viewers adapt
            dynacast: true,               // SFU pauses layers no one is watching
            stopLocalTrackOnUnpublish: false,  // keep capture alive across quality republish
            suspendLocalVideoTracksInBackground: false,  // a security camera keeps streaming
            e2eeOptions: keyProvider.map { E2EEOptions(keyProvider: $0, encryptionType: .gcm) }
        )
    }
}

/// Dispatch through the protocol, not the struct, to avoid the deprecation warning.
private let mediaOnlyE2EE: any MediaOnlyE2EEConfiguring = MediaOnlyE2EEConfigurator()
