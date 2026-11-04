//
//  RoomManager.swift
//  Foresight
//
//  Owns the LiveKit connection for one Home room (`home:<homeId>`). Subscribes
//  to camera video tracks, routes control commands over the reliable DATA
//  channel (ForesightCodec + CommandMessage), ingests `state`/`telemetry` data
//  messages to keep the UI live, and manages push-to-talk mic publishing.
//
//  Grid tiles subscribe at the LOW simulcast layer; full-screen pins HIGH/MAX.
//

import Foundation
import Combine
import LiveKit

@MainActor
final class RoomManager: ObservableObject {

    enum ConnectionPhase: Equatable {
        case idle
        case connecting
        case connected
        case failed(String)
        case disconnected
        /// E2EE-activated Home, but our sealed Home Media Key hasn't arrived yet
        /// (a member on the web must grant this device access — plan §10.3).
        case awaitingKey
        /// E2EE-activated Home, but the identity key isn't in memory — the user
        /// must re-unlock (Face ID / password) before we can decrypt (§7.4).
        case locked
    }

    @Published private(set) var phase: ConnectionPhase = .idle
    /// Live cameras keyed by cameraId, ordered for stable grid layout.
    @Published private(set) var cameras: [LiveCamera] = []
    /// True while the local mic is published (push-to-talk active).
    @Published private(set) var isTalking: Bool = false

    private let homeId: String
    private let api: APIClient
    private let room: Room
    private var camerasById: [String: LiveCamera] = [:]

    // MARK: E2EE (plan §7.4)
    /// The session's unlocked identity, used to unseal the Home Media Key.
    private let vault: IdentityVault
    /// Shared-key provider fed to LiveKit. Created once when the Home is E2EE-
    /// activated; the SAME instance is reused across reconnects and rotations so
    /// re-`setKey`-ing it live re-keys the in-flight cryptors.
    private var keyProvider: BaseKeyProvider?
    /// True once we've applied a Home Media Key (i.e. an activated Home).
    private var e2eeActive = false
    /// Server-side epoch bookkeeping — NEVER a LiveKit key index (locked to 0).
    private var currentEpoch = 0
    /// Retries the token fetch while we're activated but not yet keyed.
    private var keyRetryTask: Task<Void, Never>?

    /// Audio playback ("listen") toggle per camera id. When false we mute the
    /// remote audio track locally so the user doesn't hear that camera.
    private var listenEnabled: [String: Bool] = [:]

    /// True while we've asked LiveKit to keep the audio engine warm for playback.
    /// LiveKit's receive path only plays remote audio once the AVAudioEngine is
    /// running; it normally starts only when a *local* track is published (e.g.
    /// push-to-talk), which is why receive-only "listen" stayed silent until the
    /// user pressed Talk. Always-prepared recording starts the engine with the
    /// mic *muted* (no track published) and puts the session in `.playAndRecord`,
    /// so subscribed remote audio plays immediately. See `updateAudioEngine()`.
    private var audioEngineWarm = false

    init(homeId: String, api: APIClient, vault: IdentityVault = Session.shared.vault) {
        self.homeId = homeId
        self.api = api
        self.vault = vault
        self.room = Room()
        room.add(delegate: self)
    }

    // MARK: - Seeding from REST

    /// Seed/refresh the camera list from the REST registry. Live data already
    /// gathered from the room is preserved.
    func setRESTCameras(_ rest: [CameraDTO]) {
        var order: [LiveCamera] = []
        for dto in rest {
            if let existing = camerasById[dto.id] {
                existing.merge(rest: dto)
                order.append(existing)
            } else {
                let cam = LiveCamera(info: dto)
                camerasById[dto.id] = cam
                order.append(cam)
            }
        }
        // Drop cameras that no longer exist in the registry.
        let liveIds = Set(rest.map(\.id))
        for id in camerasById.keys where !liveIds.contains(id) {
            camerasById.removeValue(forKey: id)
        }
        cameras = order
        // Reconcile against any participants already in the room.
        reconcileParticipants()
    }

    // MARK: - Connection lifecycle

    func connect() async {
        guard phase == .idle || phase == .disconnected || isFailed
                || phase == .awaitingKey || phase == .locked else { return }
        keyRetryTask?.cancel()
        phase = .connecting
        do {
            let rt = try await api.rtToken(homeId: homeId, role: .viewer)
            let epoch = rt.keyEpoch ?? 0

            if epoch >= 1 {
                // E2EE-activated Home. Set up the key BEFORE connecting so the
                // frame cryptors decrypt from the first frame (plan §3.2, §7.4).

                // 1) The identity key must be in memory. On a cold launch this
                //    triggers the Face ID / password re-unlock path (§7.4).
                guard await Session.shared.ensureIdentityUnlocked() else {
                    phase = .locked
                    return
                }

                // 2) Our sealed HMK rides the token (zero extra round-trips). A
                //    nil copy in an activated Home ⇒ "awaiting key" — never
                //    connect plaintext into an E2EE Home (§6).
                guard let sealed = rt.sealedHomeKey else {
                    phase = .awaitingKey
                    scheduleKeyRetry()
                    return
                }

                // 3) Unseal with our identity, apply as a base64 string @ index 0.
                guard let hmk = await vault.unsealRetained(sealedB64: sealed.ciphertext) else {
                    phase = .failed("Could not unseal the camera key. Try unlocking again.")
                    return
                }
                let provider = applyHomeMediaKey(hmk)
                currentEpoch = sealed.epoch

                let options = mediaOnlyE2EE.roomOptions(keyProvider: provider)
                try await room.connect(url: rt.livekitUrl, token: rt.token, roomOptions: options)
            } else {
                // Not activated (epoch 0/nil): connect exactly as today, no e2ee.
                // adaptiveStream + dynacast let the SFU pause unviewed tiles and
                // pick layers; we still pin quality explicitly per the contract.
                let options = RoomOptions(adaptiveStream: true, dynacast: true)
                try await room.connect(url: rt.livekitUrl, token: rt.token, roomOptions: options)
            }

            phase = .connected
            reconcileParticipants()
        } catch {
            phase = .failed((error as? APIError)?.message ?? error.localizedDescription)
        }
    }

    func disconnect() async {
        keyRetryTask?.cancel()
        keyRetryTask = nil
        listenEnabled.removeAll()
        for cam in camerasById.values { cam.e2eeDecrypting = false }
        await updateAudioEngine()
        await room.disconnect()
        phase = .disconnected
    }

    private var isFailed: Bool { if case .failed = phase { return true }; return false }

    // MARK: - E2EE key application (plan §3.2 — the locked contract)

    /// Build the shared-key provider (once) and apply the Home Media Key.
    ///
    /// LOCKED CONTRACT: the HMK is applied as a base64 STRING (LiveKit's PBKDF2
    /// path), never raw bytes; the key index stays at the Swift default 0 on
    /// every application including rotation; sharedKey/ratchetSalt/
    /// ratchetWindowSize come from ForesightE2EE, never literals.
    @discardableResult
    private func applyHomeMediaKey(_ hmk: Data) -> BaseKeyProvider {
        let provider = keyProvider ?? makeKeyProvider()
        keyProvider = provider
        // base64 string, default index 0 (== ForesightE2EE.keyIndex). Do not pass
        // an index: the SDK default is 0 and stays 0 across rotations.
        provider.setKey(key: hmk.base64EncodedString())
        e2eeActive = true
        return provider
    }

    private func makeKeyProvider() -> BaseKeyProvider {
        // Explicit options sourced from ForesightE2EE (do not rely on the SDK's
        // defaults drifting): shared key, LiveKit ratchet salt, no ratcheting.
        let options = KeyProviderOptions(
            sharedKey: true,
            ratchetSalt: Data(ForesightE2EE.ratchetSalt.utf8),
            ratchetWindowSize: Int32(ForesightE2EE.ratchetWindowSize)
        )
        return BaseKeyProvider(options: options)
    }

    /// Retry the token fetch (which carries the sealed key) while we're activated
    /// but not yet keyed — a member on the web will seal to us shortly (§6/§10.3).
    private func scheduleKeyRetry() {
        keyRetryTask?.cancel()
        keyRetryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard let self, !Task.isCancelled else { return }
            if self.phase == .awaitingKey { await self.connect() }
        }
    }

    // MARK: - Track subscription (grid = low, full-screen = high/max)

    /// Subscribe to a camera's video and request a layer for its current context.
    func subscribeVideo(_ camera: LiveCamera, quality: VideoQuality) async {
        guard let pub = videoPublication(for: camera) else { return }
        do {
            try await pub.set(subscribed: true)
            try await pub.set(enabled: true)
            try await pub.set(videoQuality: quality)
        } catch {
            // Non-fatal; the SFU may retry. Surface nothing to the UI.
        }
    }

    /// Pause a camera's video (grid tile off-screen / left full-screen).
    func pauseVideo(_ camera: LiveCamera) async {
        guard let pub = videoPublication(for: camera) else { return }
        try? await pub.set(enabled: false)
    }

    /// Set the preferred layer for an already-subscribed camera.
    func setVideoQuality(_ camera: LiveCamera, _ quality: VideoQuality) async {
        guard let pub = videoPublication(for: camera) else { return }
        try? await pub.set(videoQuality: quality)
    }

    private func videoPublication(for camera: LiveCamera) -> RemoteTrackPublication? {
        guard let participant = camera.participant else { return nil }
        return participant.videoTracks.first(where: { $0.source == .camera }) as? RemoteTrackPublication
            ?? participant.videoTracks.first as? RemoteTrackPublication
    }

    // MARK: - Listen (remote audio playback)

    /// Toggle whether we hear this camera's audio. Audio tracks auto-subscribe;
    /// we locally mute by disabling the subscription's stream.
    func setListen(_ camera: LiveCamera, enabled: Bool) async {
        listenEnabled[camera.id] = enabled
        await updateAudioEngine()
        await applyListenPreference(to: camera.participant, cameraId: camera.id)
    }

    /// Keep the audio engine warm while any camera is being listened to so remote
    /// audio actually plays, and let it wind down once none are. See
    /// `audioEngineWarm` for why this is needed.
    private func updateAudioEngine() async {
        let wantsAudio = listenEnabled.values.contains(true)
        guard wantsAudio != audioEngineWarm else { return }
        do {
            try await AudioManager.shared.setRecordingAlwaysPreparedMode(wantsAudio)
            audioEngineWarm = wantsAudio
        } catch { /* non-fatal */ }
    }

    /// Reconcile a camera's audio subscription with the stored listen preference.
    /// Called when toggling Listen and again whenever an audio track (re)publishes,
    /// so auto-listen still takes effect if the track arrives after the live view
    /// opened.
    private func applyListenPreference(to participant: RemoteParticipant?, cameraId: String) async {
        guard let participant,
              let audioPub = participant.audioTracks.first as? RemoteTrackPublication else { return }
        let enabled = listenEnabled[cameraId] ?? false
        do {
            try await audioPub.set(subscribed: enabled)
        } catch { /* non-fatal */ }
    }

    func isListening(_ camera: LiveCamera) -> Bool {
        listenEnabled[camera.id] ?? false
    }

    /// When an audio track (re)publishes or auto-subscribes, re-apply the stored
    /// listen preference so the live view's auto-listen wins even if the track
    /// showed up after the view opened.
    private func reconcileListen(for participant: RemoteParticipant,
                                 publication: RemoteTrackPublication) async {
        guard publication.kind == .audio,
              let id = participant.identity?.stringValue,
              let parsed = Foresight.parseIdentity(id), parsed.role == .camera else { return }
        await applyListenPreference(to: participant, cameraId: parsed.id)
    }

    // MARK: - Commands (DATA channel)

    /// Send a command to a specific camera over the reliable data channel,
    /// addressed via destinationIdentities (matches the web dashboard exactly).
    @discardableResult
    func send(_ action: CommandAction, to camera: LiveCamera, args: CommandArgs? = nil) async -> Bool {
        let command = CommandMessage(target: camera.id, action: action, args: args)
        guard let data = ForesightCodec.encode(.command(command)) else { return false }
        let options = DataPublishOptions(
            destinationIdentities: [Participant.Identity(from: camera.identity)],
            reliable: true
        )
        do {
            try await room.localParticipant.publish(data: data, options: options)
            return true
        } catch {
            return false
        }
    }

    // Convenience wrappers mirroring the control set.
    func setTorch(_ camera: LiveCamera, on: Bool) async {
        await send(.torch, to: camera, args: CommandArgs(on: on))
    }
    func switchLens(_ camera: LiveCamera, lens: Double) async {
        await send(.switchLens, to: camera, args: CommandArgs(lens: lens))
    }
    func setZoom(_ camera: LiveCamera, zoom: Double) async {
        await send(.setZoom, to: camera, args: CommandArgs(zoom: zoom))
    }
    func setQuality(_ camera: LiveCamera, quality: QualityPreset) async {
        await send(.setQuality, to: camera, args: CommandArgs(quality: quality))
        // Mirror to the local subscription layer per the preset mapping.
        await setVideoQuality(camera, Self.videoQuality(for: quality))
    }
    func snapshotHint(_ camera: LiveCamera) async {
        await send(.snapshotHint, to: camera)
    }
    func startRecord(_ camera: LiveCamera) async { await send(.startRecord, to: camera) }
    func stopRecord(_ camera: LiveCamera) async { await send(.stopRecord, to: camera) }
    func alarm(_ camera: LiveCamera, on: Bool) async {
        await send(.alarm, to: camera, args: CommandArgs(on: on))
    }

    // MARK: - Push-to-talk

    /// Begin push-to-talk: publish the mic and notify the camera to play it.
    func startTalking(to camera: LiveCamera) async {
        do {
            _ = try await room.localParticipant.setMicrophone(enabled: true)
            isTalking = true
            await send(.talkStart, to: camera)
        } catch {
            isTalking = false
        }
    }

    /// End push-to-talk: notify the camera, then unpublish the mic.
    func stopTalking(to camera: LiveCamera) async {
        await send(.talkStop, to: camera)
        _ = try? await room.localParticipant.setMicrophone(enabled: false)
        isTalking = false
    }

    // MARK: - Preset → simulcast layer mapping (per PROTOCOL §5)

    /// auto → adaptive (we use medium as a sensible default while adaptiveStream
    /// is active), 480p → low, 1080p → high, max → high (highest available).
    /// Max publishes a single (non-simulcast) 4K layer on a 4K-capable camera,
    /// so HIGH is the only/full layer to request; `pure4k` is its legacy alias.
    static func videoQuality(for preset: QualityPreset) -> VideoQuality {
        switch preset {
        case .auto: return .medium
        case .p480: return .low
        case .p1080: return .high
        case .max: return .high
        case .pure4k: return .high
        }
    }

    // MARK: - Participant reconciliation

    private func reconcileParticipants() {
        for (_, participant) in room.remoteParticipants {
            attach(participant)
        }
    }

    private func attach(_ participant: RemoteParticipant) {
        guard let identity = participant.identity?.stringValue,
              let parsed = Foresight.parseIdentity(identity),
              parsed.role == .camera else { return }
        let cameraId = parsed.id
        let cam = camerasById[cameraId] ?? {
            // A camera we don't yet have REST metadata for (newly paired). Create
            // a placeholder; a subsequent REST refresh fills in capabilities/name.
            let placeholder = CameraDTO(
                id: cameraId, homeId: homeId, name: "Camera",
                online: true, status: CameraStatus(), capabilities: nil,
                createdAt: ""
            )
            let new = LiveCamera(info: placeholder)
            camerasById[cameraId] = new
            cameras.append(new)
            return new
        }()
        cam.participant = participant
        cam.isConnected = true
        cam.videoTrack = participant.firstCameraVideoTrack
    }

    private func detach(_ participant: RemoteParticipant) {
        guard let identity = participant.identity?.stringValue,
              let parsed = Foresight.parseIdentity(identity),
              parsed.role == .camera,
              let cam = camerasById[parsed.id] else { return }
        cam.participant = nil
        cam.isConnected = false
        cam.videoTrack = nil
        cam.e2eeDecrypting = false
    }

    private func handleData(_ data: Data) {
        guard let message = ForesightCodec.decode(data) else { return }
        switch message {
        case .state(let s):
            camerasById[s.cameraId]?.apply(s)
        case .telemetry(let t):
            camerasById[t.cameraId]?.apply(t)
        case .rekey(let r):
            // The Home Media Key rotated: re-fetch our sealed copy and re-apply
            // it. Handled deliberately (plan §6, work item 6) — never ignored.
            Task { await self.handleRekey(epoch: r.epoch) }
        case .ack, .command:
            // Viewer doesn't act on acks/commands in v1 (no UI requirement).
            break
        }
    }

    // MARK: - Rotation (plan §6 / §10.2 — sub-second blip accepted)

    /// A `.rekey` arrived. Re-fetch the sealed HMK for the new epoch, unseal, and
    /// re-`setKey` on the SAME provider (still index 0). If the new epoch isn't
    /// sealed to us yet, surface "awaiting key" and retry.
    ///
    /// `epoch` 0 means the owner turned E2EE off. If the server confirms it,
    /// reconnect plaintext: frame encryption is fixed when the room connects.
    private func handleRekey(epoch: Int) async {
        guard e2eeActive, epoch == 0 || epoch > currentEpoch else { return }
        do {
            let resp = try await api.homeKey(homeId: homeId)
            if resp.epoch == 0 {
                // A concurrent rekey may have switched already.
                guard e2eeActive else { return }
                e2eeActive = false
                currentEpoch = 0
                await disconnect()
                await connect()
                return
            }
            guard let sealedB64 = resp.sealedKey else {
                phase = .awaitingKey
                scheduleKeyRetry()
                return
            }
            // Ensure the identity is still available (it should be while connected).
            let unlocked = await vault.isUnlocked
            if !unlocked {
                guard await Session.shared.ensureIdentityUnlocked() else {
                    phase = .locked
                    return
                }
            }
            guard let hmk = await vault.unsealRetained(sealedB64: sealedB64) else { return }
            applyHomeMediaKey(hmk)
            currentEpoch = resp.epoch
        } catch {
            // Keep the current key; a reconnect will reconcile the epoch.
        }
    }

    // MARK: - E2EE decrypt state → "Decrypting…" UI (plan §10.3)

    /// Map a publication (by sid) back to its camera. TrackPublication.participant
    /// is internal, so we match the public sid against each participant's tracks.
    private func camera(forPublicationSid sid: Track.Sid) -> LiveCamera? {
        for (_, p) in room.remoteParticipants {
            let owns = p.videoTracks.contains { $0.sid == sid } || p.audioTracks.contains { $0.sid == sid }
            guard owns,
                  let id = p.identity?.stringValue,
                  let parsed = Foresight.parseIdentity(id), parsed.role == .camera else { continue }
            return camerasById[parsed.id]
        }
        return nil
    }

    private func applyE2EEState(_ state: E2EEState, forPublicationSid sid: Track.Sid) {
        guard let cam = camera(forPublicationSid: sid) else { return }
        // .missing_key / .decryption_failed ⇒ we don't have (yet) the right key:
        // show "Decrypting…" instead of black video. Publisher-side states and
        // .ok clear it.
        cam.e2eeDecrypting = (state == .missing_key || state == .decryption_failed || state == .internal_error)
    }
}

// MARK: - RoomDelegate

extension RoomManager: RoomDelegate {
    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState,
                          from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .connected: self.phase = .connected
            case .disconnected: if self.phase == .connected { self.phase = .disconnected }
            default: break
            }
        }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor in self.attach(participant) }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor in self.detach(participant) }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didSubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            self.attach(participant)
            await self.reconcileListen(for: participant, publication: publication)
            // A camera video publication can arrive fresh after a republish
            // (the single-layer 4K boundary) or a reconnect. Re-apply the camera's pinned
            // simulcast layer so the pin survives — otherwise the new track
            // defaults to adaptive until the user toggles quality again.
            if publication.kind == .video,
               let id = participant.identity?.stringValue,
               let parsed = Foresight.parseIdentity(id), parsed.role == .camera,
               let cam = self.camerasById[parsed.id] {
                await self.setVideoQuality(cam, Self.videoQuality(for: cam.quality))
            }
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didUnsubscribeTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            // Refresh the track reference (may have lost the video track).
            if let id = participant.identity?.stringValue,
               let parsed = Foresight.parseIdentity(id),
               let cam = self.camerasById[parsed.id] {
                cam.videoTrack = participant.firstCameraVideoTrack
            }
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant,
                          didPublishTrack publication: RemoteTrackPublication) {
        Task { @MainActor in
            self.attach(participant)
            await self.reconcileListen(for: participant, publication: publication)
        }
    }

    nonisolated func room(_ room: Room, participant: Participant,
                          trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        Task { @MainActor in
            if let rp = participant as? RemoteParticipant,
               let id = rp.identity?.stringValue,
               let parsed = Foresight.parseIdentity(id),
               let cam = self.camerasById[parsed.id] {
                cam.videoTrack = rp.firstCameraVideoTrack
            }
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant?,
                          didReceiveData data: Data, forTopic topic: String,
                          encryptionType: EncryptionType) {
        Task { @MainActor in self.handleData(data) }
    }

    /// LiveKit frame-cryptor state per track. Surfaces "Decrypting…" instead of
    /// black video when we can't (yet) decrypt a camera (plan §10.3). This is the
    /// only E2EE observability the Swift SDK exposes (no track.e2eeState property;
    /// verified in E2EE/State.swift + E2EEManager.swift didStateChange).
    nonisolated func room(_ room: Room, trackPublication: TrackPublication,
                          didUpdateE2EEState state: E2EEState) {
        let sid = trackPublication.sid
        Task { @MainActor in self.applyE2EEState(state, forPublicationSid: sid) }
    }
}

// MARK: - Media-only E2EE room options (plan §2.3)
//
// v1 is media-only E2EE on purpose: LiveKit's replacement `EncryptionOptions`
// also encrypts the data channel, which would break commands/telemetry against
// the camera/web/recorder until all four clients migrate together (deferred to
// v2). `E2EEOptions` is therefore used deliberately. The protocol indirection
// silences just that deprecation warning: a deprecated witness called through
// a non-deprecated protocol requirement does not re-emit it.

private protocol MediaOnlyE2EEConfiguring: Sendable {
    func roomOptions(keyProvider: BaseKeyProvider) -> RoomOptions
}

private struct MediaOnlyE2EEConfigurator: MediaOnlyE2EEConfiguring {
    @available(*, deprecated, message: "Deliberate media-only E2EEOptions until the v2 data-channel rollout (plan §2.3).")
    func roomOptions(keyProvider: BaseKeyProvider) -> RoomOptions {
        RoomOptions(adaptiveStream: true,
                    dynacast: true,
                    e2eeOptions: E2EEOptions(keyProvider: keyProvider, encryptionType: .gcm))
    }
}

/// Warning-free entry point: dispatch through the protocol, not the struct.
private let mediaOnlyE2EE: any MediaOnlyE2EEConfiguring = MediaOnlyE2EEConfigurator()
