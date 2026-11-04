//
//  CameraDetailsSheet.swift
//  Foresight
//
//  Everything about a camera that doesn't need to be on screen while watching: full
//  health readout, stream quality, rename and remove. Rests at half height with the
//  background left interactive, so the feed stays live and visible above it and a
//  quality change can be judged as it happens.
//

import SwiftUI

struct CameraDetailsSheet: View {
    @ObservedObject var camera: LiveCamera
    @ObservedObject var model: LiveViewerModel
    @ObservedObject var viewModel: HomeGridViewModel
    let onRemoved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var renameTarget: LiveCamera?
    @State private var removeTarget: LiveCamera?

    var body: some View {
        NavigationStack {
            Form {
                // First, so it's on screen at half height: the point of keeping the
                // video visible is to see a quality change take effect.
                streamSection
                statusSection
                manageSection
            }
            .navigationTitle(camera.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .tint(.primary)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .modifier(CameraRenameAlert(viewModel: viewModel, renameTarget: $renameTarget))
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

    // MARK: - Status

    private var statusSection: some View {
        Section("Status") {
            statusRow(
                "Connection",
                systemImage: camera.isOnline ? "video.fill" : "video.slash.fill",
                value: connectionText
            )
            statusRow(
                "Battery",
                systemImage: CameraHealth.batterySymbol(level: camera.battery, charging: camera.charging),
                value: CameraHealth.batteryText(level: camera.battery, charging: camera.charging),
                tint: batteryTint
            )
            statusRow(
                "Wi-Fi",
                systemImage: (camera.wifi?.level ?? 0) < 1 ? "wifi.slash" : "wifi",
                value: wifiText,
                tint: (camera.wifi?.level ?? 2) <= 1 ? Theme.caution : .secondary
            )
            statusRow(
                "Temperature",
                systemImage: "thermometer.medium",
                value: CameraHealth.thermalText(camera.thermal),
                tint: CameraHealth.thermalColor(camera.thermal)
            )
            statusRow("Watching Now", systemImage: "eye", value: "\(camera.viewerCount)")

            if viewModel.isEncrypted {
                statusRow(
                    "Encryption",
                    systemImage: "lock.fill",
                    value: camera.e2eeDecrypting ? "Waiting for Key" : "End-to-End"
                )
            }
        }
    }

    /// Icons stay neutral unless the value needs attention, so color carries meaning.
    private func statusRow(
        _ title: String,
        systemImage: String,
        value: String,
        tint: Color = .secondary
    ) -> some View {
        LabeledContent {
            Text(value)
                .monospacedDigit()
        } label: {
            Label {
                Text(title)
            } icon: {
                Image(systemName: systemImage)
                    .foregroundStyle(tint)
            }
        }
    }

    private var batteryTint: Color {
        if camera.charging == true { return Theme.live }
        guard let battery = camera.battery else { return .secondary }
        if battery < 0.1 { return Theme.critical }
        return battery < 0.2 ? Theme.caution : .secondary
    }

    private var connectionText: String {
        if camera.isOnline { return "Online" }
        if let lastSeen = ForesightDate.parse(camera.info.status.lastSeen) {
            return "Seen \(lastSeen.formatted(.relative(presentation: .named)))"
        }
        return "Offline"
    }

    /// Signal in plain language, then the network name when the camera reports it.
    private var wifiText: String {
        let signal = CameraHealth.wifiText(camera.wifi)
        if let ssid = camera.wifi?.ssid, !ssid.isEmpty {
            return "\(signal), \(ssid)"
        }
        return signal
    }

    // MARK: - Stream

    private var streamSection: some View {
        Section {
            // Four presets. "Max" is single-layer true 4K on a 4K-capable camera;
            // "1080p" is the crisp 1080p simulcast ladder.
            Picker("Quality", selection: Binding(
                get: { model.displayQuality },
                set: { model.setQuality($0) }
            )) {
                Text("Auto").tag(QualityPreset.auto)
                Text("480p").tag(QualityPreset.p480)
                Text("1080p").tag(QualityPreset.p1080)
                Text("Max").tag(QualityPreset.max)
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .disabled(!camera.isConnected)
        } header: {
            Text("Stream Quality")
        } footer: {
            // Failure replaces the hint. The toast alone would be behind this sheet.
            if let notice = model.qualityNotice {
                InlineError(message: notice)
            } else if model.supports4K {
                Text("Max streams true 4K on this camera.")
            }
        }
    }

    // MARK: - Manage

    private var manageSection: some View {
        Section {
            Button {
                renameTarget = camera
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(.primary)

            Button(role: .destructive) {
                removeTarget = camera
            } label: {
                Label("Remove Camera", systemImage: "trash")
            }
            .foregroundStyle(Theme.critical)
            .modifier(CameraRemoveConfirmation(
                camera: camera,
                viewModel: viewModel,
                removeTarget: $removeTarget,
                onRemoved: onRemoved
            ))
        }
    }
}
