//
//  Theme.swift
//  Foresight
//
//  Design tokens and shared styled components. Pure presentation — no state
//  or networking. The visual language: pure-black background, coral accent,
//  Montserrat type, dark hairline-bordered cards, and translucent glass chrome.
//

import SwiftUI

// MARK: - Color helpers

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

// MARK: - Typography

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

// MARK: - Tokens

enum Theme {
    static let accent = Color(hex: "#FF644A")
    static let background = Color.black
    static let cardBackground = Color(hex: "#141416")
    static let cardBorder = Color(hex: "#1E1E20")
    static let fieldBorder = Color(hex: "#2c2c2e")
    static let secondaryText = Color(hex: "#8E8E93")
    static let redAction = Color(hex: "#FF3B30")
}

// MARK: - Cards

extension View {
    /// Dark hairline-bordered card surface used for rows, banners, and panels.
    func darkCard(cornerRadius: CGFloat = 14) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(Theme.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .stroke(Theme.cardBorder, lineWidth: 1)
                )
        )
    }
}

// MARK: - Fields

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

// MARK: - Buttons

/// Full-width accent-filled primary action button with a loading state.
struct PrimaryButton: View {
    let title: String
    var isLoading: Bool = false
    var isDisabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView().tint(.white)
                }
                Text(title)
                    .font(.montserrat(size: 16, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(Theme.accent)
                    .opacity(isDisabled ? 0.35 : 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
    }
}

/// Small outlined secondary action (Journey's "Scan QR Code" idiom).
struct OutlineButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.montserrat(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.fieldBorder, lineWidth: 1.5)
                )
        }
        .buttonStyle(.plain)
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

/// Glass capsule chrome (brand pill, status pills).
struct GlassPill<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 8) { content }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(
                        Capsule()
                            .stroke(Color.white.opacity(0.1), lineWidth: 1)
                    )
            )
    }
}

// MARK: - Feedback

/// Inline error surface replacing bare red text.
struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.redAction)
            Text(message)
                .font(.montserrat(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .darkCard(cornerRadius: 10)
    }
}
