//
//  HealthBadges.swift
//  Foresight
//
//  Reusable SwiftUI badges for camera health: online, battery, charging, Wi-Fi,
//  thermal, viewer count. Driven by LiveCamera's realtime telemetry.
//

import SwiftUI

struct OnlineDot: View {
    let online: Bool
    var body: some View {
        Circle()
            .fill(online ? Color.green : Color.gray)
            .frame(width: 9, height: 9)
            .overlay(Circle().stroke(.black.opacity(0.25), lineWidth: 0.5))
            .accessibilityLabel(online ? "Online" : "Offline")
    }
}

struct BatteryBadge: View {
    let level: Double?      // 0...1
    let charging: Bool?

    private var symbol: String {
        guard let level else { return "battery.0percent" }
        switch level {
        case ..<0.13: return "battery.0percent"
        case ..<0.38: return "battery.25percent"
        case ..<0.63: return "battery.50percent"
        case ..<0.88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }

    private var tint: Color {
        if charging == true { return .green }
        guard let level else { return .secondary }
        return level < 0.15 ? .red : .primary
    }

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: charging == true ? "battery.100percent.bolt" : symbol)
            if let level { Text("\(Int(level * 100))%") }
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(tint)
        .accessibilityLabel("Battery \(level.map { "\(Int($0 * 100)) percent" } ?? "unknown")\(charging == true ? ", charging" : "")")
    }
}

struct WifiBadge: View {
    let wifi: WifiInfo?
    var body: some View {
        let level = wifi?.level ?? 0
        Image(systemName: symbol(for: level))
            .font(.caption2)
            .foregroundStyle(level <= 1 ? Color.orange : .primary)
            .accessibilityLabel("Wi-Fi signal \(level) of 4")
    }
    private func symbol(for level: Int) -> String {
        // SF Symbols wifi has no per-bar variant; approximate with dotted states.
        switch level {
        case ..<1: return "wifi.slash"
        case 1: return "wifi.exclamationmark"
        default: return "wifi"
        }
    }
}

struct ThermalBadge: View {
    let thermal: ThermalState?
    var body: some View {
        if let thermal, thermal != .nominal {
            Image(systemName: "thermometer.high")
                .font(.caption2)
                .foregroundStyle(color(thermal))
                .accessibilityLabel("Thermal state \(thermal.rawValue)")
        }
    }
    private func color(_ t: ThermalState) -> Color {
        switch t {
        case .nominal: return .secondary
        case .fair: return .yellow
        case .serious: return .orange
        case .critical: return .red
        }
    }
}

struct ViewerCountBadge: View {
    let count: Int
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "eye.fill")
            Text("\(count)")
        }
        .font(.caption2.weight(.medium))
        .accessibilityLabel("\(count) viewers")
    }
}

/// Compact horizontal strip of health badges for a grid tile.
struct HealthStrip: View {
    @ObservedObject var camera: LiveCamera
    var body: some View {
        HStack(spacing: 8) {
            BatteryBadge(level: camera.battery, charging: camera.charging)
            WifiBadge(wifi: camera.wifi)
            ThermalBadge(thermal: camera.thermal)
            Spacer(minLength: 0)
            ViewerCountBadge(count: camera.viewerCount)
        }
        .foregroundStyle(.white)
        .shadow(radius: 2)
    }
}
