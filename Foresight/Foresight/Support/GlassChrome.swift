//
//  GlassChrome.swift
//  Foresight
//
//  The controls that float over live video. This is the only place the app applies
//  Liquid Glass by hand; bars, sheets and menus get it from the system. Per the HIG:
//   - Glass belongs to the control layer, never to content such as camera tiles.
//   - Components over media use the clear variant, dimmed so they stay legible over
//     bright footage. `ChromeScrim` does the same for text that has no glass behind it.
//   - Custom glass is combined in a `GlassEffectContainer` to keep rendering cost down
//     while video is decoding.
//

import SwiftUI

// MARK: - Glass

extension View {
    /// Clear Liquid Glass for a control floating over video, dimmed by the 35% the HIG
    /// suggests for bright content. Dimming the glass itself rather than relying only
    /// on a scrim keeps icons legible wherever the control sits over the footage.
    func chromeGlass<S: Shape>(in shape: S, interactive: Bool = true) -> some View {
        let glass = Glass.clear.tint(.black.opacity(0.35))
        return glassEffect(interactive ? glass.interactive() : glass, in: shape)
    }

    /// Coral glass for Talk, the one tinted control in the viewer. Not interactive:
    /// glass brightens under a finger, and holding is exactly when Talk has to stay
    /// unmistakably coral. `TalkButton` provides its own press response.
    func accentGlass<S: Shape>(in shape: S) -> some View {
        glassEffect(Glass.regular.tint(Theme.accent), in: shape)
    }
}

// MARK: - Scrim

/// The dimming layer behind chrome. Over the black bars around a letterboxed feed
/// it's invisible; over a bright full-frame feed it keeps controls readable.
struct ChromeScrim: View {
    let edge: Edge
    /// Height for top/bottom, width for leading/trailing.
    let extent: CGFloat

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let peak = contrast == .increased ? 0.75 : 0.5
        let gradient = LinearGradient(
            stops: [
                .init(color: .black.opacity(peak), location: 0),
                .init(color: .black.opacity(peak * 0.45), location: 0.55),
                .init(color: .black.opacity(0), location: 1),
            ],
            startPoint: start,
            endPoint: end
        )
        Group {
            switch edge {
            case .top, .bottom: gradient.frame(height: extent)
            case .leading, .trailing: gradient.frame(width: extent)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var start: UnitPoint {
        switch edge {
        case .top: return .top
        case .bottom: return .bottom
        case .leading: return .leading
        case .trailing: return .trailing
        }
    }

    private var end: UnitPoint {
        switch edge {
        case .top: return .bottom
        case .bottom: return .top
        case .leading: return .trailing
        case .trailing: return .leading
        }
    }
}

// MARK: - Buttons

/// Dims while pressed. Glass responds to touch as a whole, so this is what tells you
/// which segment of a shared capsule you're on.
struct ChromePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
    }
}

/// A circular icon control. The active state is the same everywhere in the viewer:
/// a white disc with a black glyph, like Control Center.
struct ChromeIconButton: View {
    let systemImage: String
    let label: String
    var isActive: Bool = false
    var size: CGFloat = 50
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.38, weight: .medium))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(isActive ? Color.black : Color.white)
                .frame(width: size, height: size)
                .background {
                    if isActive {
                        Circle()
                            .fill(.white)
                            .padding(3)
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(ChromePressStyle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        // Icon-only controls stay a fixed size, so large-text users get the
        // long-press HUD the system uses for bar items.
        .accessibilityShowsLargeContentViewer {
            Label(label, systemImage: systemImage)
        }
    }
}

/// Related controls sharing a single glass capsule, following the HIG's toolbar
/// grouping: light + sound on one side of Talk, capture on the other.
struct ChromeCapsule<Content: View>: View {
    var axis: Axis = .horizontal
    @ViewBuilder var content: Content

    var body: some View {
        let layout = axis == .horizontal
            ? AnyLayout(HStackLayout(spacing: 0))
            : AnyLayout(VStackLayout(spacing: 0))
        layout { content }
            .padding(2)
            .chromeGlass(in: Capsule())
    }
}
