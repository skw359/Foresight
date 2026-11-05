//
//  LiveViewerModel.swift
//  Foresight
//
//  Session state for the live view: audio, push-to-talk, digital zoom, quality, and
//  viewer-side snapshot and recording (per PROTOCOL §4). Every action goes through
//  the existing RoomManager commands.
//
//  Lives in a model rather than the view so one screen can move between cameras.
//  Leaving a camera and opening the next run strictly in order, because RoomManager's
//  audio engine bookkeeping is shared: letting them overlap could leave the new
//  camera silent.
//

import SwiftUI
import LiveKit

@MainActor
final class LiveViewerModel: ObservableObject {
    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let systemImage: String
    }

    let room: RoomManager

    @Published private(set) var camera: LiveCamera
    @Published private(set) var isListening = false
    @Published private(set) var isTalking = false
    @Published private(set) var isRecording = false
    @Published private(set) var recordingStartedAt: Date?
    @Published private(set) var toast: Toast?
    /// Increments each time a snapshot is taken; drives the shutter flash and haptic.
    @Published private(set) var snapshotCount = 0
    /// Why the last quality change didn't take effect, shown under the picker.
    @Published private(set) var qualityNotice: String?

    /// While the user drags the slider we drive the UI from this for responsiveness
    /// and throttle the outgoing setZoom commands; once it settles we fall back to
    /// the live `camera.zoom` (kept in sync from the camera's `state` acks).
    @Published private(set) var zoomDraft: Double?

    /// True while the user has requested Max (true 4K) on a 4K-capable camera and
    /// we're waiting to see whether the camera actually starts it. If the camera's
    /// broadcast quality comes back as `.p1080`, it fell back and we say so.
    private var requested4K = false

    private var grabber: FrameGrabber?
    private var recorder: TrackRecorder?
    private var lastZoomSentAt: Date = .distantPast
    private var lifecycle: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?

    /// Send at most ~one setZoom every 120ms (~8/s) while a gesture is in flight.
    private static let zoomSendInterval: TimeInterval = 0.12

    init(camera: LiveCamera, room: RoomManager) {
        self.camera = camera
        self.room = room
    }

    // MARK: - Capabilities

    /// Digital zoom ceiling reported by the device (1 = no digital headroom).
    var maxDigitalZoom: Double { max(1, camera.capabilities?.maxDigitalZoom ?? 1) }
    var supportsDigitalZoom: Bool { maxDigitalZoom > 1 }
    var supportsTorch: Bool { camera.capabilities?.torch == true }
    var supportsAudio: Bool { camera.capabilities?.supportsAudio == true }
    var lenses: [Double] { (camera.capabilities?.lenses ?? []).sorted() }

    /// Whether the camera reports a true 4K-capable sensor. "Max" streams
    /// single-layer 4K there; elsewhere the camera serves the 1080p ladder, so
    /// there is no 4K start to wait on.
    var supports4K: Bool {
        guard let res = camera.capabilities?.maxResolution else { return false }
        return res.width >= 3840 || res.height >= 2160
    }

    /// Zoom factor to display: the in-flight draft while interacting, otherwise
    /// the value last acked by the camera.
    var displayZoom: Double { zoomDraft ?? camera.zoom }

    // MARK: - Lifecycle

    func start() {
        enqueue { [self] in await activate(camera) }
    }

    func stop() {
        let leaving = camera
        let wasTalking = releaseLocalState()
        enqueue { [self] in await deactivate(leaving, wasTalking: wasTalking) }
    }

    func select(_ next: LiveCamera) {
        guard next.id != camera.id else { return }
        let leaving = camera
        let wasTalking = releaseLocalState()
        camera = next
        enqueue { [self] in
            await deactivate(leaving, wasTalking: wasTalking)
            // Skip if the user has already moved on again.
            if camera.id == next.id { await activate(next) }
        }
    }

    /// Runs lifecycle work one step at a time, in the order it was requested.
    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = lifecycle
        lifecycle = Task {
            await previous?.value
            await work()
        }
    }

    private func activate(_ camera: LiveCamera) async {
        // Full-screen pins the HIGH layer for the best available quality.
        await room.subscribeVideo(camera, quality: .high)
        // Auto-start audio: opening a live camera should sound live too, without a
        // separate Listen tap. iOS has no browser-style autoplay gate, so playback
        // can begin immediately. The sound control stays available as a mute toggle.
        if camera.capabilities?.supportsAudio == true {
            await room.setListen(camera, enabled: true)
        }
        if self.camera.id == camera.id {
            isListening = room.isListening(camera)
        }
    }

    /// Clears anything tied to the current camera. Returns whether Talk was active.
    private func releaseLocalState() -> Bool {
        let wasTalking = isTalking
        isTalking = false
        if isRecording { stopRecording() }
        requested4K = false
        qualityNotice = nil
        zoomDraft = nil
        isListening = false
        return wasTalking
    }

    private func deactivate(_ camera: LiveCamera, wasTalking: Bool) async {
        if wasTalking { await room.stopTalking(to: camera) }
        // Stop audio on the way out so the grid stays quiet.
        if room.isListening(camera) { await room.setListen(camera, enabled: false) }
        // Max is a single, non-simulcast 4K layer meant for solo full-screen viewing.
        // Left active, the grid tile has no smaller layer to fall back to and would
        // decode the full 3840×2160 stream into a thumbnail — needless memory load
        // that can OOM the app. Restore the simulcast ladder (1080p) so the grid can
        // use LOW.
        if camera.quality == .max || camera.quality == .pure4k {
            await room.setQuality(camera, quality: .p1080)
        }
        // Drop back to the LOW layer so the grid tile stays cheap.
        await room.subscribeVideo(camera, quality: .low)
    }

    // MARK: - Device controls

    func toggleTorch() {
        let target = camera
        Task { await room.setTorch(target, on: !target.torchOn) }
    }

    func toggleListen() {
        let next = !isListening
        isListening = next
        let target = camera
        Task { await room.setListen(target, enabled: next) }
    }

    func switchLens(to lens: Double) {
        let target = camera
        Task { await room.switchLens(target, lens: lens) }
    }

    // MARK: - Push-to-talk

    func startTalking() {
        guard !isTalking else { return }
        isTalking = true
        let target = camera
        Task { await room.startTalking(to: target) }
    }

    func stopTalking() {
        guard isTalking else { return }
        isTalking = false
        let target = camera
        Task { await room.stopTalking(to: target) }
    }

    // MARK: - Quality

    /// Quality shown as selected. `pure4k` is the legacy wire value for the same
    /// thing as Max, so a camera reporting it still shows Max.
    var displayQuality: QualityPreset {
        camera.quality == .pure4k ? .max : camera.quality
    }

    func setQuality(_ preset: QualityPreset) {
        qualityNotice = nil
        requested4K = supports4K && preset == .max
        let target = camera
        Task { await room.setQuality(target, quality: preset) }
    }

    /// We asked for Max (true 4K); the camera tells us what actually started.
    func qualityDidChange(to newQuality: QualityPreset) {
        guard requested4K else { return }
        if newQuality == .max || newQuality == .pure4k {
            requested4K = false                // 4K started cleanly
        } else if newQuality == .p1080 {
            requested4K = false                // camera fell back to 1080p
            let message = "Couldn't start 4K. Streaming at 1080p."
            qualityNotice = message
            flash(message, systemImage: "exclamationmark.triangle.fill")
        }
    }

    // MARK: - Digital zoom

    func updateZoom(_ value: Double) {
        zoomDraft = value
        sendZoom(value, force: false)
    }

    /// Flush the final zoom value and hand control back to the live `camera.zoom`.
    func commitZoom() {
        if let draft = zoomDraft {
            sendZoom(draft, force: true)
        }
        zoomDraft = nil
    }

    /// Rate-limit setZoom while a gesture is in flight. `force` bypasses the limiter
    /// so the final settled value always lands on gesture end.
    private func sendZoom(_ value: Double, force: Bool) {
        let now = Date()
        if !force && now.timeIntervalSince(lastZoomSentAt) < Self.zoomSendInterval { return }
        lastZoomSentAt = now
        let target = min(max(value, 1), maxDigitalZoom)
        let camera = camera
        Task { await room.setZoom(camera, zoom: target) }
    }

    // MARK: - Snapshot

    func takeSnapshot() {
        guard let track = camera.videoTrack else {
            flash("No video to capture", systemImage: "video.slash.fill")
            return
        }
        snapshotCount += 1
        // Hint the camera so it can persist a high-res still on its side too.
        let target = camera
        Task { await room.snapshotHint(target) }
        grabber = FrameGrabber(track: track) { image in
            Task { @MainActor in
                self.grabber = nil
                guard let image else {
                    self.flash("Snapshot failed", systemImage: "exclamationmark.triangle.fill")
                    return
                }
                do {
                    try await PhotoSaver.save(image: image)
                    self.flash("Saved to Photos", systemImage: "checkmark.circle.fill")
                } catch {
                    self.flash(error.localizedDescription, systemImage: "exclamationmark.triangle.fill")
                }
            }
        }
    }

    // MARK: - Recording

    func toggleRecording() {
        isRecording ? stopRecording() : startRecording()
    }

    private func startRecording() {
        guard let track = camera.videoTrack else {
            flash("No video to record", systemImage: "video.slash.fill")
            return
        }
        let recorder = TrackRecorder(track: track)
        self.recorder = recorder
        recorder.start()
        isRecording = true
        recordingStartedAt = Date()
        let target = camera
        Task { await room.startRecord(target) }
    }

    private func stopRecording() {
        isRecording = false
        recordingStartedAt = nil
        let target = camera
        Task { await room.stopRecord(target) }
        guard let recorder else { return }
        self.recorder = nil
        recorder.stop { url in
            Task { @MainActor in
                guard let url else {
                    self.flash("Recording failed", systemImage: "exclamationmark.triangle.fill")
                    return
                }
                do {
                    try await PhotoSaver.saveVideo(at: url)
                    self.flash("Saved to Photos", systemImage: "checkmark.circle.fill")
                } catch {
                    self.flash(error.localizedDescription, systemImage: "exclamationmark.triangle.fill")
                }
            }
        }
    }

    // MARK: - Toast

    private func flash(_ text: String, systemImage: String) {
        toastTask?.cancel()
        withAnimation(Theme.Motion.chrome) {
            toast = Toast(text: text, systemImage: systemImage)
        }
        AccessibilityNotification.Announcement(text).post()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            withAnimation(Theme.Motion.chrome) { toast = nil }
        }
    }
}
