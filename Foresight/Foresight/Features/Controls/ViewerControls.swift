//
//  ViewerControls.swift
//  Foresight
//
//  The controls specific to the live view: Talk and the lens + zoom bar.
//

import SwiftUI

// MARK: - Talk

/// Push-to-talk, the hero control. Modeled on a camera shutter: one large coral
/// target, centered and in thumb reach.
///
/// Tracks the press with `GestureState` so the mic also closes if the system cancels
/// the gesture (an incoming call, for example), which `onEnded` wouldn't catch.
struct TalkButton: View {
    let isTalking: Bool
    var diameter: CGFloat = 76
    let onStart: () -> Void
    let onStop: () -> Void

    @GestureState private var isPressing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ringExpanded = false

    var body: some View {
        Image(systemName: isTalking ? "waveform" : "mic.fill")
            .font(.system(size: diameter * 0.36, weight: .semibold))
            .symbolEffect(.variableColor.iterative, isActive: isTalking && !reduceMotion)
            .contentTransition(.symbolEffect(.replace))
            .foregroundStyle(Theme.onAccent)
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
            .accentGlass(in: Circle())
            .background {
                // A ring radiating outward says the mic is open even if you aren't
                // looking directly at the button.
                if isTalking && !reduceMotion {
                    Circle()
                        .stroke(Theme.accent, lineWidth: 2)
                        .scaleEffect(ringExpanded ? 1.5 : 1)
                        .opacity(ringExpanded ? 0 : 0.8)
                        .onAppear {
                            ringExpanded = false
                            withAnimation(.easeOut(duration: 1.1).repeatForever(autoreverses: false)) {
                                ringExpanded = true
                            }
                        }
                }
            }
            .scaleEffect(isTalking ? 1.06 : 1)
            .animation(Theme.Motion.standard, value: isTalking)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($isPressing) { _, state, _ in
                        state = true
                    }
            )
            .onChange(of: isPressing) { _, pressing in
                pressing ? onStart() : onStop()
            }
            .sensoryFeedback(.impact(weight: .medium), trigger: isTalking)
            .accessibilityElement()
            .accessibilityLabel(isTalking ? "Stop Talking" : "Talk")
            .accessibilityHint("Speak through the camera. Hold to talk, or activate to start and activate again to stop.")
            .accessibilityAddTraits(.isButton)
            // Holding isn't available to everyone, so assistive technologies get a
            // toggle: VoiceOver, Voice Control and Switch Control all use this.
            .accessibilityAction {
                isTalking ? onStop() : onStart()
            }
            // No large content viewer here: at accessibility text sizes it claims the
            // long press, which is the gesture that opens the mic.
    }
}

// MARK: - Lens + zoom

/// Optical lenses as direct choices (the Camera app's idiom, replacing a button that
/// cycled blindly), plus digital zoom, which expands into a slider. The two stay
/// separate because they are separate on the camera: a lens switch resets zoom to 1×.
struct LensZoomBar: View {
    let lenses: [Double]
    let currentLens: Double
    let zoom: Double
    let maxZoom: Double
    @Binding var isZoomExpanded: Bool
    let onSelectLens: (Double) -> Void
    let onZoomChange: (Double) -> Void
    let onZoomCommit: () -> Void

    @Namespace private var glassNamespace

    private var supportsZoom: Bool { maxZoom > 1 }
    private var showsLenses: Bool { lenses.count > 1 }

    var body: some View {
        // Same glass ID in both states, so the capsule morphs between them.
        Group {
            if isZoomExpanded && supportsZoom {
                zoomSlider
                    .glassEffectID("lensBar", in: glassNamespace)
            } else if showsLenses || supportsZoom {
                pills
                    .glassEffectID("lensBar", in: glassNamespace)
            }
        }
        // Fixed-size discs: larger text wouldn't fit. Each lens has a large content
        // viewer label instead.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }

    private var pills: some View {
        ChromeCapsule {
            if showsLenses {
                ForEach(lenses, id: \.self) { lens in
                    let isSelected = lens == currentLens
                    Button {
                        onSelectLens(lens)
                    } label: {
                        Text(Self.lensLabel(lens, selected: isSelected))
                            .font(.footnote.weight(.semibold).monospacedDigit())
                            .foregroundStyle(isSelected ? Color.black : Color.white)
                            .frame(width: 40, height: 40)
                            .background {
                                if isSelected {
                                    Circle().fill(.white).padding(2)
                                }
                            }
                            .contentShape(Circle())
                    }
                    .buttonStyle(ChromePressStyle())
                    .accessibilityLabel("\(Self.lensLabel(lens, selected: false)) times lens")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityShowsLargeContentViewer {
                        Text("\(Self.lensLabel(lens, selected: false))× Lens")
                    }
                }
            }

            if supportsZoom {
                Button {
                    withAnimation(Theme.Motion.standard) { isZoomExpanded = true }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus.magnifyingglass")
                        if zoom > 1.01 {
                            Text(Self.zoomLabel(zoom))
                                .monospacedDigit()
                        }
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11)
                    .frame(minWidth: 40, minHeight: 40)
                    .contentShape(Capsule())
                }
                .buttonStyle(ChromePressStyle())
                .accessibilityLabel("Digital Zoom")
                .accessibilityValue(Self.zoomLabel(zoom))
                .accessibilityHint("Shows the zoom slider")
            }
        }
        .sensoryFeedback(.selection, trigger: currentLens)
    }

    private var zoomSlider: some View {
        HStack(spacing: 10) {
            Text(Self.zoomLabel(zoom))
                .font(.footnote.weight(.semibold).monospacedDigit())
                .frame(minWidth: 38, alignment: .trailing)
                .accessibilityHidden(true)

            Slider(
                value: Binding(get: { min(max(zoom, 1), maxZoom) }, set: { onZoomChange($0) }),
                in: 1...maxZoom
            ) { editing in
                if !editing { onZoomCommit() }
            }
            .tint(.white)
            .accessibilityLabel("Digital Zoom")
            .accessibilityValue(Self.zoomLabel(zoom))

            Button {
                withAnimation(Theme.Motion.standard) { isZoomExpanded = false }
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(ChromePressStyle())
            .accessibilityLabel("Hide Zoom Slider")
        }
        .foregroundStyle(.white)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(height: 44)
        .frame(maxWidth: 340)
        .chromeGlass(in: Capsule(), interactive: false)
    }

    /// `.5`, `1×`, `3` — the shorthand the Camera app uses; × marks the active lens.
    static func lensLabel(_ lens: Double, selected: Bool) -> String {
        var text: String
        if lens == lens.rounded() {
            text = String(Int(lens))
        } else {
            text = String(format: "%.1f", lens)
            if text.hasPrefix("0") { text.removeFirst() }
        }
        return selected ? text + "×" : text
    }

    static func zoomLabel(_ zoom: Double) -> String {
        String(format: "%.1f×", zoom)
    }
}
