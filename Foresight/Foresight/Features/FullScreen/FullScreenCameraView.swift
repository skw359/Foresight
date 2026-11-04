//
//  FullScreenCameraView.swift
//  Foresight
//
//  The live view: one camera, full-bleed, with controls floating above it.
//
//   - Portrait: the feed sits between the top bar and a thumb-reach control deck.
//   - Landscape: controls move to a rail on the trailing edge and fade after a few
//     seconds so the footage fills the screen.
//   - Tap toggles the controls; double-tap or pinch zooms the frame (on-device only);
//     swipe sideways changes camera; swipe down closes.
//   - The controls are one tap away instead of behind a "More" button. Stream quality
//     and device details, which you rarely need mid-view, live in a sheet that keeps
//     the video visible above it.
//

import SwiftUI
import LiveKit

struct FullScreenCameraView: View {
    @StateObject private var model: LiveViewerModel
    private let viewModel: HomeGridViewModel
    private let onCameraChange: (LiveCamera) -> Void

    init(
        camera: LiveCamera,
        room: RoomManager,
        viewModel: HomeGridViewModel,
        onCameraChange: @escaping (LiveCamera) -> Void = { _ in }
    ) {
        _model = StateObject(wrappedValue: LiveViewerModel(camera: camera, room: room))
        self.viewModel = viewModel
        self.onCameraChange = onCameraChange
    }

    var body: some View {
        LiveViewerContent(
            camera: model.camera,
            model: model,
            viewModel: viewModel,
            onCameraChange: onCameraChange
        )
        // The zoom transition adds system pinch and drag dismissal, which would fire
        // while someone is pinching a magnified frame back to fit. This view handles
        // those gestures itself and closes on a swipe down at 1×.
        .interactiveDismissDisabled()
        .task { model.start() }
        .onAppear {
            // Like the system video player: watching isn't "idle", so don't sleep.
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            model.stop()
        }
    }
}

// MARK: - Content

private struct LiveViewerContent: View {
    @ObservedObject var camera: LiveCamera
    @ObservedObject var model: LiveViewerModel
    @ObservedObject var viewModel: HomeGridViewModel
    let onCameraChange: (LiveCamera) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.scenePhase) private var scenePhase

    @State private var showControls = true
    @State private var showDetails = false
    @State private var isZoomExpanded = false
    @State private var hideTask: Task<Void, Never>?
    @State private var shutterVisible = false
    /// The edge the next camera slides in from.
    @State private var incomingEdge: Edge = .trailing

    // Local pinch-to-zoom: a purely on-device magnification of the rendered frame,
    // independent of the camera's digital zoom (which the slider drives). `frameZoom`
    // is the committed scale; `pinchScale` is the live gesture delta folded into it
    // on gesture end.
    @State private var frameZoom: CGFloat = 1
    @GestureState private var pinchScale: CGFloat = 1

    // Pan offset for the magnified frame. `frameOffset` is the committed pan;
    // `dragTranslation` is the live drag delta folded into it on gesture end. Clamped
    // to the magnified content's edges, so panning is a no-op at 1×.
    @State private var frameOffset: CGSize = .zero
    @GestureState private var dragTranslation: CGSize = .zero
    @State private var viewSize: CGSize = .zero

    /// Upper bound for the local frame magnification.
    private static let maxFrameZoom: CGFloat = 6

    private var isLandscape: Bool { verticalSizeClass == .compact }
    private var cameras: [LiveCamera] { viewModel.room.cameras }

    /// The clamped magnification currently applied to the rendered frame.
    private var effectiveZoom: CGFloat {
        min(max(frameZoom * pinchScale, 1), Self.maxFrameZoom)
    }

    /// The pan offset currently applied, including the in-flight drag, clamped so the
    /// magnified content can't be dragged past its own edges.
    private var liveOffset: CGSize {
        let proposed = CGSize(width: frameOffset.width + dragTranslation.width,
                              height: frameOffset.height + dragTranslation.height)
        return clampedOffset(proposed, zoom: effectiveZoom, in: viewSize)
    }

    /// At 1× a drag can't pan, so the frame follows the finger a little to preview
    /// the swipe it's about to trigger.
    private var swipePreviewOffset: CGSize {
        guard effectiveZoom <= 1, !reduceMotion else { return .zero }
        let isHorizontal = abs(dragTranslation.width) > abs(dragTranslation.height)
        return CGSize(
            width: isHorizontal && cameras.count > 1 ? dragTranslation.width * 0.4 : 0,
            height: !isHorizontal ? max(0, dragTranslation.height) * 0.4 : 0
        )
    }

    /// With the details sheet up in portrait, the feed moves into the space above it.
    private var sheetLift: CGFloat {
        showDetails && !isLandscape ? -viewSize.height * 0.25 : 0
    }

    var body: some View {
        ZStack {
            Theme.canvas.ignoresSafeArea()

            videoLayer
            shutterLayer
            gestureLayer

            if showControls {
                chrome
                    .transition(.opacity)
            } else {
                alwaysVisibleIndicators
                    .transition(.opacity)
            }

            toastLayer
        }
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { viewSize = proxy.size }
                    .onChange(of: proxy.size) { _, newSize in viewSize = newSize }
            }
            .ignoresSafeArea()
        }
        .statusBarHidden()
        .persistentSystemOverlays(showControls ? .automatic : .hidden)
        .onAppear { rescheduleAutoHide() }
        .onChange(of: camera.quality) { _, newQuality in
            model.qualityDidChange(to: newQuality)
        }
        .onChange(of: camera.id) { _, _ in
            frameZoom = 1
            frameOffset = .zero
            isZoomExpanded = false
            onCameraChange(camera)
        }
        .onChange(of: verticalSizeClass) { _, _ in
            frameOffset = clampedOffset(frameOffset, zoom: frameZoom, in: viewSize)
            withAnimation(Theme.Motion.chrome) { showControls = true }
            rescheduleAutoHide()
        }
        .onChange(of: voiceOverEnabled) { _, enabled in
            if enabled {
                hideTask?.cancel()
                withAnimation(Theme.Motion.chrome) { showControls = true }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Never leave the mic open behind the user's back.
            if phase != .active { model.stopTalking() }
        }
        .animation(Theme.Motion.chrome, value: showDetails)
        .onChange(of: model.snapshotCount) { _, _ in fireShutter() }
        .sensoryFeedback(.impact(weight: .light), trigger: model.snapshotCount)
        .sheet(isPresented: $showDetails) {
            CameraDetailsSheet(
                camera: camera,
                model: model,
                viewModel: viewModel,
                onRemoved: { dismiss() }
            )
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { viewModel.errorMessage != nil && !showDetails },
                set: { if !$0 { viewModel.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { viewModel.errorMessage = nil }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    // MARK: - Video

    private var videoLayer: some View {
        ZStack {
            CameraVideoView(camera: camera, layoutMode: .fit, roomIssue: viewModel.roomIssue)
                .id(camera.id)
                .transition(cameraTransition)
        }
        .scaleEffect(effectiveZoom)
        .offset(
            x: liveOffset.width + swipePreviewOffset.width,
            y: liveOffset.height + swipePreviewOffset.height + sheetLift
        )
        .animation(Theme.Motion.standard, value: showDetails)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Live video from \(camera.name)")
        .accessibilityValue(camera.spokenStatus)
        .accessibilityAddTraits(.isImage)
    }

    private var cameraTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let outgoingEdge: Edge = incomingEdge == .trailing ? .leading : .trailing
        return .asymmetric(
            insertion: .move(edge: incomingEdge),
            removal: .move(edge: outgoingEdge)
        )
    }

    /// A brief white flash confirms a snapshot, like a shutter.
    private var shutterLayer: some View {
        Color.white
            .opacity(shutterVisible ? 0.7 : 0)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func fireShutter() {
        guard !reduceMotion else { return }
        shutterVisible = true
        withAnimation(.easeOut(duration: 0.28)) { shutterVisible = false }
    }

    // MARK: - Gestures

    /// A dedicated layer so the black bars around a letterboxed feed respond too.
    private var gestureLayer: some View {
        Color.clear
            .contentShape(Rectangle())
            .ignoresSafeArea()
            .gesture(frameGesture)
            .onTapGesture(count: 2) { toggleFrameZoom() }
            .onTapGesture { toggleControls() }
            .accessibilityHidden(true)
    }

    /// Pinch-to-zoom and drag-to-pan that magnify and reposition the rendered frame
    /// on-device, like zooming into a picture in a web browser. Purely view-side
    /// transforms: nothing is sent to the camera, so this is independent of the
    /// digital-zoom slider. At 1× the same drag changes camera or closes the view.
    private var frameGesture: some Gesture {
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
                guard frameZoom <= 1 else {
                    let proposed = CGSize(width: frameOffset.width + value.translation.width,
                                          height: frameOffset.height + value.translation.height)
                    frameOffset = clampedOffset(proposed, zoom: frameZoom, in: viewSize)
                    return
                }
                handleSwipe(value)
            }

        return pinch.simultaneously(with: pan)
    }

    private func handleSwipe(_ value: DragGesture.Value) {
        let translation = value.translation
        let predicted = value.predictedEndTranslation
        if abs(translation.width) > abs(translation.height) {
            guard abs(predicted.width) > 110, cameras.count > 1 else { return }
            selectAdjacentCamera(forward: translation.width < 0)
        } else if translation.height > 0, predicted.height > 180 {
            dismiss()
        }
    }

    private func selectAdjacentCamera(forward: Bool) {
        guard let index = cameras.firstIndex(where: { $0.id == camera.id }) else { return }
        let offset = forward ? 1 : -1
        let next = cameras[(index + offset + cameras.count) % cameras.count]
        select(next, from: forward ? .trailing : .leading)
    }

    private func select(_ next: LiveCamera, from edge: Edge) {
        incomingEdge = edge
        withAnimation(Theme.Motion.standard) {
            model.select(next)
        }
        rescheduleAutoHide()
    }

    private func toggleFrameZoom() {
        withAnimation(Theme.Motion.standard) {
            frameZoom = frameZoom > 1 ? 1 : 2
            frameOffset = .zero
        }
    }

    private func toggleControls() {
        withAnimation(Theme.Motion.chrome) {
            showControls.toggle()
            if !showControls { isZoomExpanded = false }
        }
        rescheduleAutoHide()
    }

    /// Clamp a pan offset to the overflow the magnified frame creates, so its content
    /// can't be dragged past its own edges. Zero overflow at 1×.
    private func clampedOffset(_ offset: CGSize, zoom: CGFloat, in size: CGSize) -> CGSize {
        let maxX = max(0, size.width * (zoom - 1) / 2)
        let maxY = max(0, size.height * (zoom - 1) / 2)
        return CGSize(width: min(max(offset.width, -maxX), maxX),
                      height: min(max(offset.height, -maxY), maxY))
    }

    /// In landscape the controls sit over the footage, so they fade when not in use.
    /// In portrait they sit beside it, so they stay until you hide them.
    private func rescheduleAutoHide() {
        hideTask?.cancel()
        guard isLandscape, showControls, !voiceOverEnabled, !showDetails else { return }
        hideTask = Task {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            if model.isTalking || isZoomExpanded {
                rescheduleAutoHide()
            } else {
                withAnimation(Theme.Motion.chrome) { showControls = false }
            }
        }
    }

    /// Runs a control's action and keeps the controls on screen a little longer.
    private func perform(_ action: () -> Void) {
        action()
        rescheduleAutoHide()
    }

    // MARK: - Chrome

    @ViewBuilder
    private var chrome: some View {
        ZStack {
            VStack(spacing: 0) {
                ChromeScrim(edge: .top, extent: isLandscape ? 120 : 170)
                Spacer(minLength: 0)
                ChromeScrim(edge: .bottom, extent: isLandscape ? 120 : 250)
            }
            .ignoresSafeArea()

            if isLandscape {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    ChromeScrim(edge: .trailing, extent: 190)
                }
                .ignoresSafeArea()
            }

            if isLandscape {
                landscapeChrome
            } else {
                portraitChrome
            }
        }
    }

    private var portraitChrome: some View {
        VStack(spacing: 0) {
            GlassEffectContainer(spacing: 10) { topBar }
            // The details sheet shows all of this, and the raised feed needs the room.
            if !showDetails {
                statusStrip
                    .padding(.top, 10)
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
            // Hidden under the details sheet, where the coral would otherwise glow
            // through the glass behind its text.
            if !showDetails {
                GlassEffectContainer(spacing: 14) {
                    VStack(spacing: 12) {
                        lensBar
                        controlDeck
                    }
                    .frame(maxWidth: 560)
                }
                .opacity(camera.isConnected ? 1 : 0.4)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private var landscapeChrome: some View {
        ZStack {
            VStack(spacing: 0) {
                GlassEffectContainer(spacing: 10) {
                    HStack(spacing: 10) {
                        closeButton
                        cameraSwitcher
                        statusStrip
                            .padding(.leading, 4)
                        Spacer(minLength: 0)
                        detailsButton
                    }
                }
                Spacer(minLength: 0)
                HStack {
                    GlassEffectContainer(spacing: 10) { lensBar }
                        .opacity(camera.isConnected ? 1 : 0.4)
                    Spacer(minLength: 0)
                }
            }
            HStack {
                Spacer(minLength: 0)
                GlassEffectContainer(spacing: 10) { controlRail }
                    .opacity(camera.isConnected ? 1 : 0.4)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            closeButton
            Spacer(minLength: 0)
            cameraSwitcher
            Spacer(minLength: 0)
            detailsButton
        }
    }

    private var closeButton: some View {
        ChromeIconButton(systemImage: "chevron.down", label: "Close", size: 44) {
            dismiss()
        }
        .chromeGlass(in: Circle())
    }

    private var detailsButton: some View {
        ChromeIconButton(systemImage: "slider.horizontal.3", label: "Camera Details", size: 44) {
            showDetails = true
            hideTask?.cancel()
        }
        .chromeGlass(in: Circle())
    }

    /// The title doubles as the camera switcher, so there's a visible alternative to
    /// the swipe.
    @ViewBuilder
    private var cameraSwitcher: some View {
        if cameras.count > 1 {
            Menu {
                Picker("Camera", selection: Binding(
                    get: { camera.id },
                    set: { id in
                        guard let next = cameras.first(where: { $0.id == id }) else { return }
                        let current = cameras.firstIndex { $0.id == camera.id } ?? 0
                        let target = cameras.firstIndex { $0.id == id } ?? 0
                        select(next, from: target >= current ? .trailing : .leading)
                    }
                )) {
                    ForEach(cameras) { option in
                        Label(
                            option.name,
                            systemImage: option.isOnline ? "video.fill" : "video.slash.fill"
                        )
                        .tag(option.id)
                    }
                }
                .pickerStyle(.inline)
            } label: {
                titleLabel(showsChevron: true)
            }
            .tint(.primary)
            .chromeGlass(in: Capsule())
            .accessibilityLabel("Camera: \(camera.name)")
            .accessibilityHint("Switches to another camera")
        } else {
            titleLabel(showsChevron: false)
                .chromeGlass(in: Capsule(), interactive: false)
        }
    }

    private func titleLabel(showsChevron: Bool) -> some View {
        HStack(spacing: 7) {
            StatusDot(isOnline: camera.isOnline)
            Text(camera.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(height: 44)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    /// Health at a glance; tapping it opens the full readout.
    private var statusStrip: some View {
        Button {
            showDetails = true
            hideTask?.cancel()
        } label: {
            HStack(spacing: 10) {
                recordingIndicator
                HealthStrip(camera: camera)
            }
            .font(.footnote.weight(.medium))
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(ChromePressStyle())
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows camera details")
    }

    @ViewBuilder
    private var recordingIndicator: some View {
        if model.isRecording {
            RecordingBadge(startedAt: model.recordingStartedAt, isProminent: true)
        } else if camera.recording {
            RecordingBadge(isProminent: true)
        }
    }

    /// States that must stay visible even when the controls are hidden: whether a
    /// clip is being captured and whether the mic is open.
    @ViewBuilder
    private var alwaysVisibleIndicators: some View {
        VStack {
            HStack(spacing: 8) {
                recordingIndicator
                if model.isTalking {
                    Label("Talking", systemImage: "mic.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Theme.accent, in: Capsule())
                }
            }
            Spacer()
        }
        .padding(.top, 10)
        .allowsHitTesting(false)
    }

    private var lensBar: some View {
        LensZoomBar(
            lenses: model.lenses,
            currentLens: camera.lens,
            zoom: model.displayZoom,
            maxZoom: model.maxDigitalZoom,
            isZoomExpanded: $isZoomExpanded,
            onSelectLens: { lens in perform { model.switchLens(to: lens) } },
            onZoomChange: { value in perform { model.updateZoom(value) } },
            onZoomCommit: { model.commitZoom() }
        )
        .disabled(!camera.isConnected)
    }

    // MARK: - Controls

    /// Portrait: light + sound, then Talk, then capture. Talk stays centered and the
    /// groups keep their sides even when a camera lacks some capabilities. The caption
    /// hangs below Talk so the capsules line up with the button itself.
    private var controlDeck: some View {
        HStack(alignment: .center, spacing: 8) {
            deviceControls(axis: .horizontal)
                .frame(maxWidth: .infinity)
            if model.supportsAudio {
                talkButton(diameter: 76)
                    .overlay(alignment: .bottom) {
                        Text(model.isTalking ? "Talking…" : "Hold to Talk")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(0.8))
                            .lineLimit(1)
                            .dynamicTypeSize(...DynamicTypeSize.xLarge)
                            .fixedSize()
                            .alignmentGuide(.bottom) { $0[.top] - 10 }
                            .accessibilityHidden(true)
                    }
            }
            captureControls(axis: .horizontal)
                .frame(maxWidth: .infinity)
        }
        .padding(.bottom, model.supportsAudio ? 20 : 0)
    }

    /// Landscape: the same groups stacked along the edge.
    private var controlRail: some View {
        VStack(spacing: 10) {
            deviceControls(axis: .vertical)
            if model.supportsAudio {
                talkButton(diameter: 60)
            }
            captureControls(axis: .vertical)
        }
    }

    private func talkButton(diameter: CGFloat) -> some View {
        TalkButton(
            isTalking: model.isTalking,
            diameter: diameter,
            onStart: { perform { model.startTalking() } },
            onStop: { perform { model.stopTalking() } }
        )
        .disabled(!camera.isConnected)
    }

    private var controlSize: CGFloat { isLandscape ? 42 : 48 }

    @ViewBuilder
    private func deviceControls(axis: Axis) -> some View {
        if model.supportsTorch || model.supportsAudio {
            ChromeCapsule(axis: axis) {
                if model.supportsTorch {
                    ChromeIconButton(
                        systemImage: camera.torchOn ? "flashlight.on.fill" : "flashlight.off.fill",
                        label: "Flashlight",
                        isActive: camera.torchOn,
                        size: controlSize
                    ) {
                        perform { model.toggleTorch() }
                    }
                    .sensoryFeedback(.selection, trigger: camera.torchOn)
                }
                if model.supportsAudio {
                    ChromeIconButton(
                        systemImage: model.isListening ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        label: model.isListening ? "Mute Camera Audio" : "Unmute Camera Audio",
                        size: controlSize
                    ) {
                        perform { model.toggleListen() }
                    }
                }
            }
            .disabled(!camera.isConnected)
        }
    }

    private func captureControls(axis: Axis) -> some View {
        ChromeCapsule(axis: axis) {
            ChromeIconButton(systemImage: "camera.fill", label: "Take Snapshot", size: controlSize) {
                perform { model.takeSnapshot() }
            }
            recordButton
        }
        .disabled(!camera.isConnected)
    }

    /// Red ring and dot at rest, a red stop square while recording: the record button
    /// people already know from the Camera app.
    private var recordButton: some View {
        Button {
            perform { model.toggleRecording() }
        } label: {
            ZStack {
                Circle()
                    .strokeBorder(.white, lineWidth: 2)
                    .frame(width: 24, height: 24)
                RoundedRectangle(cornerRadius: model.isRecording ? 2.5 : 8, style: .continuous)
                    .fill(Theme.recording)
                    .frame(
                        width: model.isRecording ? 11 : 16,
                        height: model.isRecording ? 11 : 16
                    )
            }
            .animation(Theme.Motion.standard, value: model.isRecording)
            .frame(width: controlSize, height: controlSize)
            .contentShape(Circle())
        }
        .buttonStyle(ChromePressStyle())
        .sensoryFeedback(.impact(weight: .medium), trigger: model.isRecording)
        .accessibilityLabel(model.isRecording ? "Stop Recording" : "Record")
        .accessibilityAddTraits(model.isRecording ? .isSelected : [])
        .accessibilityShowsLargeContentViewer {
            Label(model.isRecording ? "Stop Recording" : "Record", systemImage: "record.circle")
        }
    }

    // MARK: - Toast

    @ViewBuilder
    private var toastLayer: some View {
        if let toast = model.toast {
            VStack {
                if !isLandscape { Spacer() }
                Label(toast.text, systemImage: toast.systemImage)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.horizontal, 24)
                if isLandscape { Spacer() }
            }
            .padding(.top, isLandscape ? 60 : 0)
            // Clears the control deck in portrait.
            .padding(.bottom, isLandscape ? 0 : 190)
            .allowsHitTesting(false)
            .transition(.opacity)
            .id(toast.id)
        }
    }
}
