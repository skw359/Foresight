//
//  Theme.swift
//  Foresight
//
//  Design tokens and the shared content-layer components. Pure presentation —
//  no state or networking.
//
//  The visual language, in four rules:
//   1. Video is the interface. The canvas is true black so feeds read as windows
//      and the UI recedes (a permanently dark appearance is what the HIG suggests
//      for immersive media apps).
//   2. Coral means "act". It marks the primary action on a screen and Talk — never
//      decoration, and never status.
//   3. Status stays quiet. Semantic system colors appear only when something needs
//      attention; a healthy camera shows no telemetry on the wall.
//   4. Glass is for controls floating over video (see GlassChrome.swift). Lists,
//      tiles and forms live in the content layer and never use it.
//

import SwiftUI

// MARK: - Tokens

enum Theme {
    // MARK: Brand

    /// Foresight coral (#FF644A), with a lighter Increased Contrast variant.
    static let accent = Color("AccentColor")
    /// Foreground on coral: black is 7.2:1, white would be only 2.9:1.
    static let onAccent = Color.black

    // MARK: Surfaces

    static let canvas = Color.black
    static let surface = Color(.secondarySystemBackground)
    /// Fill behind a tile before its first frame arrives.
    static let placeholder = Color(white: 0.08)
    static let hairline = Color.white.opacity(0.1)

    // MARK: Status

    static let live = Color.green
    static let recording = Color.red
    static let caution = Color.orange
    static let critical = Color.red

    // MARK: Metrics

    enum Radius {
        static let tile: CGFloat = 22
        static let compactTile: CGFloat = 16
        static let card: CGFloat = 20
        static let field: CGFloat = 16
    }

    enum Motion {
        static let standard = Animation.spring(response: 0.38, dampingFraction: 0.86)
        static let chrome = Animation.easeInOut(duration: 0.22)
    }
}

// MARK: - Typography

extension Font {
    /// Montserrat is the brand voice, for the wordmark. Past the welcome screen,
    /// everything else uses system text styles so it follows Dynamic Type.
    static func wordmark(size: CGFloat, relativeTo style: Font.TextStyle = .largeTitle) -> Font {
        .custom("Montserrat-Bold", size: size, relativeTo: style)
    }
}

// MARK: - Buttons

/// The one prominent action on a screen: coral capsule, black label.
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(title)
                    .fontWeight(.semibold)
                    .opacity(isLoading ? 0 : 1)
                if isLoading {
                    ProgressView()
                        .tint(Theme.onAccent)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.extraLarge)
        .tint(Theme.accent)
        .foregroundStyle(isDisabled ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.onAccent))
        .disabled(isDisabled || isLoading)
    }
}

extension View {
    /// Styles a compact call to action (empty states, retry) to match `PrimaryButton`.
    func prominentAction() -> some View {
        buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .tint(Theme.accent)
            .foregroundStyle(Theme.onAccent)
    }
}

// MARK: - Fields

/// Groups related inputs into one rounded surface, like a Settings section.
struct InputGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(
                Theme.surface,
                in: RoundedRectangle(cornerRadius: Theme.Radius.field, style: .continuous)
            )
    }
}

extension View {
    /// Row metrics for a field inside an `InputGroup`.
    func inputRow() -> some View {
        padding(.horizontal, 16)
            .frame(minHeight: 52)
    }
}

// MARK: - Feedback

/// Inline explanation directly under the thing that failed.
struct InlineError: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(Theme.critical)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .onAppear {
            AccessibilityNotification.Announcement(message).post()
        }
    }
}

/// A card explaining a state that blocks video, with the one action that resolves
/// it. Sits in the content layer above the wall, so it uses a plain surface.
struct StatusCard: View {
    let systemImage: String
    var tint: Color = .secondary
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 28)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(14)
        .background(
            Theme.surface,
            in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
        )
        .accessibilityElement(children: .contain)
    }
}

/// A live-state dot that also differs by shape, so it never relies on color alone:
/// solid when online, a hollow ring when offline.
struct StatusDot: View {
    let isOnline: Bool

    var body: some View {
        ZStack {
            if isOnline {
                Circle().fill(Theme.live)
            } else {
                Circle().strokeBorder(.white.opacity(0.6), lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

// MARK: - Dates

enum ForesightDate {
    /// Parses the backend's ISO 8601 timestamps (`Date.toISOString()` includes
    /// fractional seconds; tolerate either form).
    static func parse(_ string: String?) -> Date? {
        guard let string else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: string) { return date }
        return ISO8601DateFormatter().date(from: string)
    }
}

// MARK: - Welcome screen

// The welcome screen (AuthView) has its own established look: Montserrat throughout,
// outlined controls and a coral-edged panel. These support it and nothing else.

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3:
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

extension Font {
    static func montserrat(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let weightName: String
        switch weight {
        case .bold: weightName = "Bold"
        case .semibold: weightName = "SemiBold"
        case .medium: weightName = "Medium"
        case .light: weightName = "Light"
        case .thin: weightName = "Thin"
        default: weightName = "Regular"
        }
        return .custom("Montserrat-\(weightName)", size: size)
    }
}

extension Theme {
    static let background = Color.black
    static let cardBackground = Color(hex: "#141416")
    static let fieldBorder = Color(hex: "#2c2c2e")
    static let secondaryText = Color(hex: "#8E8E93")
    static let redAction = Color(hex: "#FF3B30")
}

/// Dark rounded text/secure field: card fill, hairline border, Montserrat.
/// Behavior modifiers (`textContentType`, `submitLabel`, `onSubmit`, …) are
/// applied by the caller and propagate into the wrapped field.
struct ThemedField: View {
    let placeholder: String
    @Binding var text: String
    var isSecure: Bool = false

    var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text, prompt: prompt)
            } else {
                TextField(placeholder, text: $text, prompt: prompt)
            }
        }
        .font(.montserrat(size: 15, weight: .medium))
        .foregroundStyle(.white)
        .tint(Theme.accent)
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.fieldBorder, lineWidth: 1.5)
                )
        )
    }

    private var prompt: Text {
        Text(placeholder)
            .font(.montserrat(size: 15, weight: .medium))
            .foregroundStyle(Theme.secondaryText)
    }
}

/// Floating circular glass icon button (top chrome).
struct GlassCircleButton: View {
    let systemName: String
    var tint: Color = .white
    var accessibilityText: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(tint)
                .frame(width: 42, height: 42)
                .background(
                    Circle()
                        .fill(.ultraThinMaterial)
                        .overlay(
                            Circle()
                                .stroke(Color.white.opacity(0.1), lineWidth: 1)
                        )
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityText ?? systemName)
    }
}
