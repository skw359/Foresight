//
//  CameraModeView.swift
//  Foresight Camera Client
//
//  The camera-mode screen: live publisher preview, stream status, camera state
//  read-out, and Go Live / Stop / unpair controls. Commands arrive over LiveKit
//  and are applied by RealtimeSession — this view is a read-out + lifecycle UI.
//
//  Power/heat: a phone streaming 24/7 shouldn't also render a full-screen preview
//  at full brightness for nobody. After `dimAfter` seconds without a touch while
//  streaming, the preview is removed (publishing is unaffected) and the screen
//  dims; a tap brings both back.
//

import Combine
import LiveKit
import SwiftUI
import UIKit

struct CameraModeView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var session: RealtimeSession
    @ObservedObject var telemetry: DeviceTelemetry

    @State private var busy = false
    @State private var showUnpairConfirm = false

    // Power saver.
    @State private var dimmed = false
    @State private var lastInteraction = Date()
    @State private var savedBrightness: CGFloat?
    private let dimAfter: TimeInterval = 120
    private let idleTick = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if !dimmed {
                preview
                    .ignoresSafeArea()
            }

            VStack {
                topBar
                healthBar
                if showThermalWarning {
                    thermalChip
                }
                if let keyError = model.keyRegistrationError {
                    keyRegistrationBanner(keyError)
                }
                Spacer()
                if isStreaming {
                    keepAwakeWarning
                }
                if session.viewerSpeaking {
                    speakingIndicator
                }
                stateReadout
                controls
            }
            .padding()

            if dimmed {
                dimmedOverlay
            }
        }
        // Any touch counts as activity (simultaneous: never steals button taps).
        .simultaneousGesture(TapGesture().onEnded { wake() })
        .onReceive(idleTick) { _ in
            if isStreaming, !dimmed, Date().timeIntervalSince(lastInteraction) > dimAfter {
                dim()
            } else if !isStreaming, dimmed {
                wake()
            }
        }
        .onDisappear { wake() }
        .confirmationDialog(
            "Unpair this camera?",
            isPresented: $showUnpairConfirm,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) {
                Task {
                    busy = true
                    await model.unpair()
                    busy = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The camera will stop streaming and be removed from your Home on the server. You'll need to pair it again.")
        }
    }

    // MARK: Power saver

    private var dimmedOverlay: some View {
        VStack(spacing: 10) {
            Image(systemName: "moon.fill")
                .font(.system(size: 30))
            Text("Streaming — screen dimmed to save power")
                .font(.footnote.weight(.semibold))
            Text("Tap to wake")
                .font(.caption)
                .opacity(0.7)
        }
        .foregroundStyle(.white.opacity(0.55))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { wake() }
    }

    private func dim() {
        dimmed = true
        if savedBrightness == nil { savedBrightness = UIScreen.main.brightness }
        UIScreen.main.brightness = 0.05
    }

    private func wake() {
        lastInteraction = Date()
        guard dimmed else { return }
        dimmed = false
        if let savedBrightness { UIScreen.main.brightness = savedBrightness }
        savedBrightness = nil
    }

    // MARK: Preview

    @ViewBuilder
    private var preview: some View {
        if let track = session.previewTrack {
            SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .off)
        } else {
            VStack(spacing: 12) {
                Image(systemName: isStreaming ? "video.fill" : "video.slash.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.white.opacity(0.5))
                Text(isStreaming ? "Starting preview…" : "Camera offline")
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text(session.cameraName)
                    .font(.headline)
                    .foregroundStyle(.white)
                largeStatus
                // Surfaces the "Waiting for key…" state (and any other offline reason).
                if let detail = session.status.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(2)
                }
            }
            Spacer()
            viewerBadge
        }
        .padding(12)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    private var largeStatus: some View {
        HStack(spacing: 8) {
            if isConnecting {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                Circle()
                    .fill(statusColor)
                    .frame(width: 12, height: 12)
            }
            Text(session.status.label)
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)
        }
    }

    private var viewerBadge: some View {
        Label("\(session.viewerCount)", systemImage: "eye.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.white.opacity(0.12), in: Capsule())
    }

    private var speakingIndicator: some View {
        Label("Viewer is speaking", systemImage: "waveform")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.blue.opacity(0.85), in: Capsule())
            .padding(.bottom, 8)
    }

    // MARK: Device health

    private var snapshot: TelemetrySnapshot { telemetry.snapshot }

    private var healthBar: some View {
        HStack(spacing: 16) {
            batteryChip
            wifiChip
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    private var batteryChip: some View {
        let pct = snapshot.battery.map { Int(($0 * 100).rounded()) }
        let charging = snapshot.charging ?? false
        return Label {
            Text(pct.map { "\($0)%" } ?? "—")
                .font(.caption.weight(.semibold))
        } icon: {
            Image(systemName: charging ? "battery.100.bolt" : batterySymbol(pct))
        }
        .foregroundStyle(batteryColor(pct, charging: charging))
    }

    @ViewBuilder
    private var wifiChip: some View {
        if let wifi = snapshot.wifi {
            Label {
                Text(wifiBars(wifi.level)).font(.caption.weight(.semibold))
            } icon: {
                Image(systemName: "wifi")
            }
            .foregroundStyle(wifi.level <= 1 ? .orange : .white)
        } else {
            Label("No Wi-Fi", systemImage: "wifi.slash")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
        }
    }

    private var showThermalWarning: Bool { snapshot.thermal != .nominal }

    private var thermalChip: some View {
        Label("Device \(thermalLabel(snapshot.thermal))", systemImage: "thermometer.high")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(thermalColor(snapshot.thermal).opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
    }

    /// Fatal E2EE key-registration conflict (a 409 from the pubkey migration).
    private func keyRegistrationBanner(_ message: String) -> some View {
        Label(message, systemImage: "key.slash.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
    }

    private var keepAwakeWarning: some View {
        Label("Keep this iPhone unlocked, plugged in, and the Foresight app open.",
              systemImage: "lock.open.fill")
            .font(.caption.weight(.medium))
            .foregroundStyle(.yellow)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(.bottom, 8)
    }

    // MARK: Health formatting

    private func wifiBars(_ level: Int) -> String {
        let n = max(0, min(4, level))
        return String(repeating: "▮", count: n) + String(repeating: "▯", count: 4 - n)
    }

    private func batterySymbol(_ pct: Int?) -> String {
        switch pct ?? 100 {
        case ..<13: return "battery.0"
        case ..<38: return "battery.25"
        case ..<63: return "battery.50"
        case ..<88: return "battery.75"
        default: return "battery.100"
        }
    }

    private func batteryColor(_ pct: Int?, charging: Bool) -> Color {
        if charging { return .green }
        switch pct ?? 100 {
        case ..<15: return .red
        case ..<30: return .orange
        default: return .white
        }
    }

    private func thermalLabel(_ t: ThermalState) -> String {
        switch t {
        case .nominal: return "Nominal"
        case .fair: return "Warm"
        case .serious: return "Hot"
        case .critical: return "Overheating"
        }
    }

    private func thermalColor(_ t: ThermalState) -> Color {
        switch t {
        case .nominal: return .gray
        case .fair: return .yellow
        case .serious: return .orange
        case .critical: return .red
        }
    }

    // MARK: State read-out

    private var stateReadout: some View {
        HStack(spacing: 18) {
            stateChip(
                title: "Lens",
                value: format(session.lens) + "×",
                systemImage: "camera.aperture"
            )
            stateChip(
                title: "Zoom",
                value: format(session.zoom) + "×",
                systemImage: "plus.magnifyingglass"
            )
            stateChip(
                title: "Quality",
                value: qualityLabel(session.quality),
                systemImage: "rectangle.on.rectangle"
            )
            stateChip(
                title: "Torch",
                value: session.torchOn ? "On" : "Off",
                systemImage: session.torchOn ? "flashlight.on.fill" : "flashlight.off.fill"
            )
            if session.recording {
                stateChip(title: "REC", value: "●", systemImage: "record.circle")
                    .foregroundStyle(.red)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    private func stateChip(title: String, value: String, systemImage: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 16))
            Text(value)
                .font(.caption.weight(.semibold))
            Text(title)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 12) {
            Button {
                Task { await toggleStreaming() }
            } label: {
                // Follows the INTENT: a camera that is live — or offline but
                // retrying on its own — offers Stop, which ends supervision.
                Label(
                    session.wantsStreaming ? "Stop" : "Go Live",
                    systemImage: session.wantsStreaming ? "stop.fill" : "dot.radiowaves.left.and.right"
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(session.wantsStreaming ? .red : .green)
            .disabled(busy || isConnecting)

            Button {
                showUnpairConfirm = true
            } label: {
                Image(systemName: "xmark.circle")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.bordered)
            .tint(.white)
            .disabled(busy)
        }
        .padding(.top, 8)
    }

    // MARK: Actions

    private func toggleStreaming() async {
        busy = true
        defer { busy = false }
        if session.wantsStreaming {
            await model.stopStreaming()
        } else {
            await model.startStreaming()
        }
    }

    // MARK: Derived state

    private var isStreaming: Bool {
        if case .streaming = session.status { return true }
        return false
    }

    private var isConnecting: Bool {
        switch session.status {
        case .connecting, .reconnecting: return true
        default: return false
        }
    }

    private var statusColor: Color {
        switch session.status {
        case .streaming: return .green
        case .connecting, .reconnecting: return .yellow
        case .idle, .offline: return .gray
        }
    }

    private func format(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    private func qualityLabel(_ quality: QualityPreset) -> String {
        switch quality {
        case .auto: return "Auto"
        case .p480: return "480p"
        case .p1080: return "1080p"
        case .max, .pure4k: return "Max"
        }
    }
}
