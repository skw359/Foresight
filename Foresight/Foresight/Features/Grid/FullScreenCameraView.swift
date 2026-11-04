//
//  FullScreenCameraView.swift
//  Foresight
//
//  Full-screen live view for a single camera. Pins the HIGH simulcast layer,
//  shows health telemetry, and exposes the viewer control set over the LiveKit
//  data channel: torch, lens switch, zoom, quality preset, listen (remote
//  audio), push-to-talk, plus viewer-side snapshot and recording.
//

import SwiftUI
import LiveKit

struct FullScreenCameraView: View {
    @ObservedObject var camera: LiveCamera
    let room: RoomManager
    @ObservedObject var viewModel: HomeGridViewModel

    @Environment(\.dismiss) private var dismiss

    @State private var showControls = true
    @State private var showMore = false
    @State private var isListening = false
    @State private var isTalking = false

    /// True while the user has requested Max (true 4K) on a 4K-capable camera and
    /// we're waiting to see whether the camera actually starts it. If the camera's
    /// broadcast quality comes back as `.p1080`, it fell back and we toast.
    @State private var requested4K = false

    // Snapshot / recording state (viewer-side capture per PROTOCOL §4).
    @State private var grabber: FrameGrabber?
    @State private var recorder: TrackRecorder?
    @State private var isRecording = false
    @State private var statusMessage: String?

    // Digital zoom. While the user drags the slider or pinches we drive the UI
    // from `zoomDraft` for responsiveness and throttle the outgoing setZoom
    // commands; once it settles we fall back to the live `camera.zoom` (kept in
    // sync from the camera's `state` acks).
    @State private var zoomDraft: Double?
    @State private var lastZoomSentAt: Date = .distantPast

    // Local pinch-to-zoom: a purely on-device magnification of the rendered
    // frame, independent of the camera's digital zoom (which the slider drives).
    // `frameZoom` is the committed scale; `pinchScale` is the live gesture delta
    // folded into it on gesture end.
    @State private var frameZoom: CGFloat = 1
    @GestureState private var pinchScale: CGFloat = 1

    // Pan offset for the magnified frame. `frameOffset` is the committed pan;
    // `dragTranslation` is the live drag delta folded into it on gesture end.
    // Clamped to the magnified content's edges, so panning is a no-op at 1×.
    @State private var frameOffset: CGSize = .zero
    @GestureState private var dragTranslation: CGSize = .zero
    @State private var viewSize: CGSize = .zero

    /// Upper bound for the local frame magnification.
    private static let maxFrameZoom: CGFloat = 6

    /// The clamped magnification currently applied to the rendered frame.
    private var effectiveZoom: CGFloat {
        min(max(frameZoom * pinchScale, 1), Self.maxFrameZoom)
    }

    /// The pan offset currently applied, including the in-flight drag, clamped
    /// so the magnified content can't be dragged past its own edges.
    private var liveOffset: CGSize {
        let proposed = CGSize(width: frameOffset.width + dragTranslation.width,
                              height: frameOffset.height + dragTranslation.height)
        return clampedOffset(proposed, zoom: effectiveZoom, in: viewSize)
    }

    // Rename / remove.
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showRemoveConfirm = false

    /// Send at most ~one setZoom every 120ms (~8/s) while a gesture is in flight.
    private static let zoomSendInterval: TimeInterval = 0.12

    /// Digital zoom ceiling reported by the device (1 = no digital headroom).
    private var maxDigitalZoom: Double { max(1, camera.capabilities?.maxDigitalZoom ?? 1) }
    private var supportsDigitalZoom: Bool { maxDigitalZoom > 1 }

    /// Whether the camera reports a true 4K-capable sensor. "Max" streams
    /// single-layer 4K there; elsewhere the camera serves the 1080p ladder, so
    /// there is no 4K start to wait on.
    private var supports4K: Bool {
        guard let res = camera.capabilities?.maxResolution else { return false }
        return res.width >= 3840 || res.height >= 2160
    }

    /// Zoom factor to display: the in-flight draft while interacting, otherwise
    /// the value last acked by the camera.
    private var displayZoom: Double { zoomDraft ?? camera.zoom }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            CameraVideoView(camera: camera, layoutMode: .fit)
                .scaleEffect(effectiveZoom)
                .offset(liveOffset)
                .ignoresSafeArea()
                .background(
                    GeometryReader { proxy in
                        Color.clear
                            .onAppear { viewSize = proxy.size }
                            .onChange(of: proxy.size) { _, newSize in viewSize = newSize }
                    }
                )
                .clipped()
                .gesture(zoomGesture)
                .onTapGesture {
                    withAnimation {
                        showControls.toggle()
                        if !showControls { showMore = false }
                    }
                }

            if showControls {
                overlay
                    .transition(.opacity)
            }

            if let statusMessage {
                statusToast(statusMessage)
            }
        }
        .statusBarHidden()
        .onChange(of: camera.quality) { _, newQuality in
            // We asked for Max (true 4K); the camera tells us what actually started.
            guard requested4K else { return }
            if newQuality == .max || newQuality == .pure4k {
                requested4K = false                // 4K started cleanly
            } else if newQuality == .p1080 {
                requested4K = false                // camera fell back to 1080p
                flash("An error occurred while starting 4K streaming.")
            }
        }
        .task {
            // Full-screen pins the HIGH layer for the best available quality.
            await room.subscribeVideo(camera, quality: .high)
            // Auto-start audio: opening a live camera should sound live too,
            // without a separate Listen tap. iOS has no browser-style autoplay
            // gate, so playback can begin immediately. The Listen button below
            // stays available as a mute toggle.
            if camera.capabilities?.supportsAudio == true {
                await room.setListen(camera, enabled: true)
            }
            isListening = room.isListening(camera)
        }
        .onDisappear {
            Task {
                if isTalking { await room.stopTalking(to: camera) }
                if isRecording { stopRecording() }
                // Stop audio on the way out so the grid stays quiet.
                if room.isListening(camera) { await room.setListen(camera, enabled: false) }
                // Max is a single, non-simulcast 4K layer meant for solo
                // full-screen viewing. Left active, the grid tile has no smaller
                // layer to fall back to and would decode the full 3840×2160 stream
                // into a thumbnail — needless memory load that can OOM the app.
                // Restore the simulcast ladder (1080p) so the grid can use LOW.
                if camera.quality == .max || camera.quality == .pure4k {
                    await room.setQuality(camera, quality: .p1080)
                }
                // Drop back to the LOW layer so the grid tile stays cheap.
                await room.subscribeVideo(camera, quality: .low)
            }
        }
        .alert("Rename Camera", isPresented: $showRename) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                Task { await viewModel.rename(camera, to: trimmed) }
            }
        }
        .confirmationDialog(
            "Remove \(camera.name)?",
            isPresented: $showRemoveConfirm,
            titleVisibility: .visible
        ) {
            Button("Remove Camera", role: .destructive) {
                Task {
                    await viewModel.remove(camera)
                    // Only leave full-screen if the removal actually succeeded;
                    // otherwise stay so the surfaced error remains visible.
                    if viewModel.errorMessage == nil { dismiss() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This unpairs the camera from this Home. You can pair it again later.")
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { viewModel.errorMessage != nil },
                set: { if !$0 { viewModel.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { viewModel.errorMessage = nil }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    // MARK: - Overlay

    private var overlay: some View {
        VStack {
            topBar
            Spacer()
            HealthStrip(camera: camera)
                .padding(.horizontal)
            controlBar
        }
        .padding(.vertical, 12)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.down")
                    .font(.headline)
                    .padding(10)
                    .background(.black.opacity(0.4), in: Circle())
            }
            HStack(spacing: 7) {
                OnlineDot(online: camera.isOnline)
                Text(camera.name).font(.headline)
            }
            Spacer()
            if isRecording { RecordingDot() }
            cameraMenu
        }
        .foregroundStyle(.white)
        .padding(.horizontal)
    }

    /// Top-bar overflow menu: rename or remove this camera.
    private var cameraMenu: some View {
        Menu {
            Button {
                renameText = camera.name
                showRename = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button(role: .destructive) {
                showRemoveConfirm = true
            } label: {
                Label("Remove Camera", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.headline)
                .padding(10)
                .background(.black.opacity(0.4), in: Circle())
        }
        .accessibilityLabel("Camera options")
    }

    private var controlBar: some View {
        VStack(spacing: 14) {
            // Secondary controls live behind "More" so the default surface stays
            // focused on the few actions reached for most often.
            if showMore {
                moreControls
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Primary controls: flashlight, listen, and the More toggle.
            HStack(spacing: 28) {
                if camera.capabilities?.torch == true {
                    controlButton(
                        systemImage: camera.torchOn ? "flashlight.on.fill" : "flashlight.off.fill",
                        label: "Flashlight",
                        active: camera.torchOn
                    ) {
                        Task { await room.setTorch(camera, on: !camera.torchOn) }
                    }
                }

                if camera.capabilities?.supportsAudio == true {
                    controlButton(
                        systemImage: isListening ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        label: "Listen",
                        active: isListening
                    ) {
                        let next = !isListening
                        isListening = next
                        Task { await room.setListen(camera, enabled: next) }
                    }
                }

                controlButton(
                    systemImage: showMore ? "chevron.down" : "ellipsis",
                    label: showMore ? "Less" : "More",
                    active: showMore
                ) {
                    withAnimation(.easeInOut(duration: 0.2)) { showMore.toggle() }
                }
            }
            .frame(maxWidth: .infinity)

            // Push-to-talk: the hero control, always within thumb reach.
            if camera.capabilities?.supportsAudio == true {
                talkButton
            }
        }
        .padding()
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 20))
        .padding(.horizontal)
    }

    /// Expanded secondary controls (quality, zoom, lens, snapshot, record),
    /// revealed by "More" so they don't clutter the default view.
    private var moreControls: some View {
        VStack(spacing: 14) {
            qualityPicker

            if supportsDigitalZoom {
                zoomControl
            }

            HStack(spacing: 28) {
                if let lenses = camera.capabilities?.lenses, lenses.count > 1 {
                    controlButton(systemImage: "arrow.triangle.2.circlepath.camera", label: "Lens") {
                        Task { await room.switchLens(camera, lens: nextLens(in: lenses)) }
                    }
                }

                controlButton(systemImage: "camera.fill", label: "Snapshot") {
                    takeSnapshot()
                }

                controlButton(
                    systemImage: isRecording ? "stop.circle.fill" : "record.circle",
                    label: isRecording ? "Stop" : "Record",
                    active: isRecording
                ) {
                    isRecording ? stopRecording() : startRecording()
                }
            }
            .frame(maxWidth: .infinity)

            Divider().overlay(.white.opacity(0.2))
        }
    }

    private var qualityPicker: some View {
        VStack(spacing: 6) {
            // Four presets. "Max" is single-layer true 4K on a 4K-capable camera
            // (`pure4k` is the legacy wire value for the same thing, so a camera
            // reporting it still shows Max selected); "1080p" is the crisp 1080p
            // simulcast ladder.
            Picker("Quality", selection: Binding(
                get: { camera.quality == .pure4k ? .max : camera.quality },
                set: { preset in
                    requested4K = supports4K && preset == .max
                    Task { await room.setQuality(camera, quality: preset) }
                }
            )) {
                Text("Auto").tag(QualityPreset.auto)
                Text("480p").tag(QualityPreset.p480)
                Text("1080p").tag(QualityPreset.p1080)
                Text("Max").tag(QualityPreset.max)
            }
            .pickerStyle(.segmented)

            if supports4K {
                HStack(spacing: 6) {
                    Image(systemName: "4k.tv")
                    Text("Max streams true 4K on this camera.")
                }
                .font(.caption)
                .foregroundStyle(.white.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Digital zoom slider with a live factor label. Distinct from the optical
    /// lens switcher (which steps through fixed physical lenses).
    private var zoomControl: some View {
        HStack(spacing: 12) {
            Image(systemName: "minus.magnifyingglass")
                .foregroundStyle(.white.opacity(0.7))
            Slider(
                value: Binding(
                    get: { displayZoom.clamped(to: 1...maxDigitalZoom) },
                    set: { newValue in
                        zoomDraft = newValue
                        sendZoom(newValue, force: false)
                    }
                ),
                in: 1...maxDigitalZoom
            ) { editing in
                if !editing { commitZoom() }
            }
            Image(systemName: "plus.magnifyingglass")
                .foregroundStyle(.white.opacity(0.7))
            Text(String(format: "%.1f×", displayZoom))
                .font(.caption.weight(.semibold).monospacedDigit())
                .frame(width: 44, alignment: .trailing)
        }
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Digital zoom")
        .accessibilityValue(String(format: "%.1f times", displayZoom))
    }

    /// Pinch-to-zoom and drag-to-pan that magnify and reposition the rendered
    /// frame on-device, like zooming into and panning a picture in a web
    /// browser. Purely view-side transforms — nothing is sent to the camera, so
    /// this is independent of the digital-zoom slider.
    private var zoomGesture: some Gesture {
        let pinch = MagnificationGesture()
            .updating($pinchScale) { value, state, _ in
                state = value
            }
            .onEnded { value in
                frameZoom = min(max(frameZoom * value, 1), Self.maxFrameZoom)
                // Re-clamp the pan in case zooming out exposed an edge.
                frameOffset = clampedOffset(frameOffset, zoom: frameZoom, in: viewSize)
            }

        let pan = DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                let proposed = CGSize(width: frameOffset.width + value.translation.width,
                                      height: frameOffset.height + value.translation.height)
                frameOffset = clampedOffset(proposed, zoom: effectiveZoom, in: viewSize)
            }

        return pinch.simultaneously(with: pan)
    }

    /// Clamp a pan offset to the overflow the magnified frame creates, so its
    /// content can't be dragged past its own edges. Zero overflow at 1×.
    private func clampedOffset(_ offset: CGSize, zoom: CGFloat, in size: CGSize) -> CGSize {
        let maxX = max(0, size.width * (zoom - 1) / 2)
        let maxY = max(0, size.height * (zoom - 1) / 2)
        return CGSize(width: offset.width.clamped(to: -maxX...maxX),
                      height: offset.height.clamped(to: -maxY...maxY))
    }

    private var talkButton: some View {
        HStack(spacing: 7) {
            Image(systemName: isTalking ? "mic.fill" : "mic")
                .font(.subheadline.weight(.semibold))
            Text("Hold to Talk")
                .font(.subheadline.weight(.medium))
        }
        .foregroundStyle(.white)
        .padding(.vertical, 9)
        .padding(.horizontal, 22)
        .background(isTalking ? Color.red : Color.white.opacity(0.15),
                   in: Capsule())
        .contentShape(Capsule())
        .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !isTalking else { return }
                        isTalking = true
                        Task { await room.startTalking(to: camera) }
                    }
                    .onEnded { _ in
                        guard isTalking else { return }
                        isTalking = false
                        Task { await room.stopTalking(to: camera) }
                    }
            )
            .accessibilityLabel("Push to talk")
    }

    private func controlButton(systemImage: String, label: String, active: Bool = false,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .frame(width: 44, height: 44)
                    .background(active ? Color.accentColor : Color.white.opacity(0.15), in: Circle())
                Text(label).font(.caption2)
            }
            .foregroundStyle(.white)
        }
    }

    private func statusToast(_ message: String) -> some View {
        VStack {
            Spacer()
            Text(message)
                .font(.callout.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(.black.opacity(0.7), in: Capsule())
                .padding(.bottom, 120)
        }
        .transition(.opacity)
    }

    // MARK: - Zoom command throttling

    /// Rate-limit setZoom while a gesture is in flight. `force` bypasses the
    /// limiter so the final settled value always lands on gesture end.
    private func sendZoom(_ value: Double, force: Bool) {
        let now = Date()
        if !force && now.timeIntervalSince(lastZoomSentAt) < Self.zoomSendInterval { return }
        lastZoomSentAt = now
        let target = value.clamped(to: 1...maxDigitalZoom)
        Task { await room.setZoom(camera, zoom: target) }
    }

    /// Flush the final zoom value and hand control back to the live `camera.zoom`.
    private func commitZoom() {
        if let draft = zoomDraft {
            sendZoom(draft, force: true)
        }
        zoomDraft = nil
    }

    // MARK: - Helpers

    private func nextLens(in lenses: [Double]) -> Double {
        let sorted = lenses.sorted()
        guard let idx = sorted.firstIndex(of: camera.lens) else { return sorted.first ?? 1 }
        return sorted[(idx + 1) % sorted.count]
    }

    private func flash(_ message: String) {
        withAnimation { statusMessage = message }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation { statusMessage = nil }
        }
    }

    // MARK: - Snapshot

    private func takeSnapshot() {
        guard let track = camera.videoTrack else {
            flash("No video to capture")
            return
        }
        // Hint the camera so it can persist a high-res still on its side too.
        Task { await room.snapshotHint(camera) }
        grabber = FrameGrabber(track: track) { image in
            Task { @MainActor in
                self.grabber = nil
                guard let image else { self.flash("Snapshot failed"); return }
                do {
                    try await PhotoSaver.save(image: image)
                    self.flash("Saved to Photos")
                } catch {
                    self.flash(error.localizedDescription)
                }
            }
        }
    }

    // MARK: - Recording

    private func startRecording() {
        guard let track = camera.videoTrack else {
            flash("No video to record")
            return
        }
        let recorder = TrackRecorder(track: track)
        self.recorder = recorder
        recorder.start()
        isRecording = true
        Task { await room.startRecord(camera) }
        flash("Recording…")
    }

    private func stopRecording() {
        isRecording = false
        Task { await room.stopRecord(camera) }
        guard let recorder else { return }
        self.recorder = nil
        recorder.stop { url in
            Task { @MainActor in
                guard let url else { self.flash("Recording failed"); return }
                do {
                    try await PhotoSaver.saveVideo(at: url)
                    self.flash("Saved to Photos")
                } catch {
                    self.flash(error.localizedDescription)
                }
            }
        }
    }
}

private extension Comparable {
    /// Clamp a value into a closed range.
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
