//
//  HealthBadges.swift
//  Foresight
//
//  How camera health is shown. Two levels, driven by LiveCamera's telemetry:
//   - `CameraAlert`: only what needs attention, for the wall. A healthy camera shows
//     nothing, so telemetry never competes with the video.
//   - Battery / Wi-Fi / thermal badges and descriptions: the full picture, for the
//     live view and its details sheet.
//

import SwiftUI

// MARK: - Descriptions

enum CameraHealth {
    static func batterySymbol(level: Double?, charging: Bool?) -> String {
        if charging == true { return "battery.100percent.bolt" }
        guard let level else { return "battery.0percent" }
        switch level {
        case ..<0.13: return "battery.0percent"
        case ..<0.38: return "battery.25percent"
        case ..<0.63: return "battery.50percent"
        case ..<0.88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }

    static func batteryText(level: Double?, charging: Bool?) -> String {
        guard let level else { return "Unknown" }
        let percent = "\(Int(level * 100))%"
        return charging == true ? "\(percent), Charging" : percent
    }

    static func wifiText(_ wifi: WifiInfo?) -> String {
        guard let level = wifi?.level else { return "Unknown" }
        switch level {
        case ..<1: return "No Signal"
        case 1: return "Weak"
        case 2: return "Fair"
        case 3: return "Good"
        default: return "Excellent"
        }
    }

    static func thermalText(_ thermal: ThermalState?) -> String {
        switch thermal {
        case .nominal: return "Normal"
        case .fair: return "Warm"
        case .serious: return "Hot"
        case .critical: return "Critical"
        case nil: return "Unknown"
        }
    }

    static func thermalColor(_ thermal: ThermalState?) -> Color {
        switch thermal {
        case .fair: return .yellow
        case .serious: return Theme.caution
        case .critical: return Theme.critical
        default: return .secondary
        }
    }
}

// MARK: - Alerts (wall)

/// One thing about a camera that deserves attention before it's opened.
struct CameraAlert: Identifiable {
    let id: String
    let systemImage: String
    var text: String?
    let color: Color
    let spokenText: String
}

extension LiveCamera {
    var alerts: [CameraAlert] {
        guard isOnline else { return [] }
        var alerts: [CameraAlert] = []

        if charging != true, let battery, battery < 0.2 {
            let percent = "\(Int(battery * 100))%"
            alerts.append(CameraAlert(
                id: "battery",
                systemImage: "battery.25percent",
                text: percent,
                color: battery < 0.1 ? Theme.critical : Theme.caution,
                spokenText: "Battery low, \(percent)"
            ))
        }
        if thermal == .serious || thermal == .critical {
            alerts.append(CameraAlert(
                id: "thermal",
                systemImage: "thermometer.high",
                color: CameraHealth.thermalColor(thermal),
                spokenText: "Device \(CameraHealth.thermalText(thermal).lowercased())"
            ))
        }
        if let level = wifi?.level, level <= 1 {
            alerts.append(CameraAlert(
                id: "wifi",
                systemImage: "wifi.exclamationmark",
                color: Theme.caution,
                spokenText: "Weak Wi-Fi"
            ))
        }
        return alerts
    }

    /// Summary read by VoiceOver for a tile.
    var spokenStatus: String {
        var parts: [String] = [isOnline ? "Online" : "Offline"]
        if recording { parts.append("Recording") }
        parts.append(contentsOf: alerts.map(\.spokenText))
        return parts.joined(separator: ", ")
    }
}

/// Compact attention chips over a tile. Renders nothing for a healthy camera.
struct CameraAlertChips: View {
    let alerts: [CameraAlert]

    var body: some View {
        if !alerts.isEmpty {
            HStack(spacing: 6) {
                ForEach(alerts) { alert in
                    HStack(spacing: 3) {
                        Image(systemName: alert.systemImage)
                        if let text = alert.text {
                            Text(text).monospacedDigit()
                        }
                    }
                    .foregroundStyle(alert.color)
                }
            }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(.black.opacity(0.55), in: Capsule())
        }
    }
}

// MARK: - Badges (live view)

struct BatteryBadge: View {
    let level: Double?      // 0...1
    let charging: Bool?

    private var tint: Color {
        if charging == true { return Theme.live }
        guard let level else { return .white.opacity(0.7) }
        return level < 0.15 ? Theme.critical : .white
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: CameraHealth.batterySymbol(level: level, charging: charging))
                .foregroundStyle(tint)
            if let level {
                Text("\(Int(level * 100))%").monospacedDigit()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Battery \(CameraHealth.batteryText(level: level, charging: charging))")
    }
}

struct WifiBadge: View {
    let wifi: WifiInfo?

    var body: some View {
        if let level = wifi?.level {
            Group {
                if level < 1 {
                    Image(systemName: "wifi.slash")
                } else {
                    // The wifi symbol supports variable rendering, so the bars
                    // show the actual 1–4 signal level.
                    Image(systemName: "wifi", variableValue: Double(level) / 4)
                }
            }
            .foregroundStyle(level <= 1 ? Theme.caution : .white)
            .accessibilityLabel("Wi-Fi \(CameraHealth.wifiText(wifi))")
        }
    }
}

struct ThermalBadge: View {
    let thermal: ThermalState?

    var body: some View {
        if let thermal, thermal != .nominal {
            HStack(spacing: 3) {
                Image(systemName: "thermometer.high")
                Text(CameraHealth.thermalText(thermal))
            }
            .foregroundStyle(CameraHealth.thermalColor(thermal))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Temperature \(CameraHealth.thermalText(thermal))")
        }
    }
}

struct ViewerCountBadge: View {
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "eye.fill")
            Text("\(count)").monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) people watching")
    }
}

/// The one-line health summary under the live view's title. Viewer count appears
/// only when someone else is watching, which is the case that's worth knowing.
struct HealthStrip: View {
    @ObservedObject var camera: LiveCamera

    var body: some View {
        HStack(spacing: 12) {
            // Nothing to report yet, e.g. a camera that has never connected.
            if camera.battery != nil {
                BatteryBadge(level: camera.battery, charging: camera.charging)
            }
            WifiBadge(wifi: camera.wifi)
            ThermalBadge(thermal: camera.thermal)
            if camera.viewerCount > 1 {
                ViewerCountBadge(count: camera.viewerCount)
            }
        }
        .foregroundStyle(.white)
    }
}

// MARK: - Recording

/// Recording indicator. Pass `startedAt` to show elapsed time for a local recording.
/// In the live view this never hides with the chrome, so it's always clear when a
/// clip is being captured.
struct RecordingBadge: View {
    var startedAt: Date?
    /// The live view's larger size; tiles use the compact one.
    var isProminent: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dimmed = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Theme.recording)
                .frame(width: isProminent ? 10 : 8, height: isProminent ? 10 : 8)
                .opacity(dimmed ? 0.45 : 1)
            if let startedAt {
                Text(startedAt, style: .timer)
                    .monospacedDigit()
            } else {
                Text("REC")
            }
        }
        .font(isProminent ? .footnote.weight(.semibold) : .caption.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: Capsule())
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                dimmed = true
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Recording")
    }
}
