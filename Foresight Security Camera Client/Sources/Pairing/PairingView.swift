//
//  PairingView.swift
//  Foresight Camera Client
//
//  The pairing flow:
//    1. Request camera + mic permission.
//    2. Scan the QR the dashboard shows (a PairingTicket JSON).
//    3. Detect this device's CameraCapabilities.
//    4. Let the user name the camera.
//    5. POST /pair/claim → store deviceSecret + metadata → enter camera mode.
//

import AVFoundation
import SwiftUI

@MainActor
final class PairingViewModel: ObservableObject {
    enum Step: Equatable {
        case permissions
        case scanning
        case naming
        case claiming
        case failed(String)
    }

    @Published var step: Step = .permissions
    @Published var name: String = ""

    private(set) var ticket: PairingTicket?
    private(set) var capabilities: CameraCapabilities?

    /// Ask for AV permissions; advance to scanning if granted.
    func requestPermissions(using model: AppModel) async {
        let granted = await model.requestPermissions()
        step = granted ? .scanning : .failed("Camera and microphone access are required to pair and stream.")
    }

    /// Decode a scanned QR payload into a PairingTicket and detect capabilities.
    func didScan(_ payload: String) {
        guard case .scanning = step else { return }
        guard let data = payload.data(using: .utf8),
              let ticket = try? JSONDecoder().decode(PairingTicket.self, from: data)
        else {
            step = .failed("That QR code isn't a Foresight pairing code. Open Add Camera on the dashboard and try again.")
            return
        }

        let serverComponents = URLComponents(string: ticket.serverUrl)
        let serverHost = serverComponents?.host ?? "(missing host)"
        let serverPort = serverComponents?.port.map { ":\($0)" } ?? ""
        print("[Foresight Camera] Pairing QR server host: \(serverHost)\(serverPort)")
        print("[Foresight Camera] Pairing QR server URL: \(ticket.serverUrl)")

        // Expiry guard (best effort; server is the source of truth).
        if let expiry = ISO8601DateFormatter().date(from: ticket.expiresAt), expiry < Date() {
            step = .failed("This pairing code has expired. Generate a new one on the dashboard.")
            return
        }

        self.ticket = ticket
        self.capabilities = CameraCapabilityDetector.detectCapabilities()
        if name.isEmpty { name = UIDevice.current.name }
        step = .naming
    }

    /// Claim the pairing with the chosen name.
    func claim(using model: AppModel) async {
        guard let ticket, let capabilities else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            step = .failed("Please give this camera a name.")
            return
        }

        step = .claiming
        let backend = BackendClient(serverUrl: ticket.serverUrl)
        do {
            // Generate (or reuse) the camera's E2EE identity BEFORE claiming and
            // send its public key in the claim (plan §6 pair-camera). The private
            // key never leaves the Keychain.
            let cameraPublicKey = CameraKeyManager.loadOrCreateKeypair()
            let response = try await backend.claimPairing(token: ticket.token, name: trimmed,
                                                          capabilities: capabilities,
                                                          cameraPublicKey: cameraPublicKey)
            // The server now holds our pubkey → skip the existing-camera migration,
            // and remember whether the Home is already E2EE-activated.
            CameraKeyManager.markPubkeyRegistered()
            CameraKeyManager.homeKeyPending = response.homeKeyPending ?? false
            let paired = PairedCamera(
                cameraId: response.camera.id,
                name: response.camera.name,
                homeId: ticket.homeId,
                serverUrl: ticket.serverUrl,
                livekitUrl: ticket.livekitUrl,
                deviceSecret: response.deviceSecret,
                capabilities: capabilities
            )
            model.completePairing(paired)
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    func reset() {
        ticket = nil
        capabilities = nil
        step = .scanning
    }
}

struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var vm = PairingViewModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
                .padding()
        }
        .task(id: stepTaskID) {
            if case .permissions = vm.step {
                await vm.requestPermissions(using: model)
            }
        }
    }

    // Drives the .task so permission requests fire once on entry.
    private var stepTaskID: String {
        if case .permissions = vm.step { return "permissions" }
        return "other"
    }

    @ViewBuilder
    private var content: some View {
        switch vm.step {
        case .permissions:
            VStack(spacing: 16) {
                Image(systemName: "camera.viewfinder")
                    .font(.system(size: 56))
                    .foregroundStyle(.white)
                Text("Foresight Camera")
                    .font(.title.bold())
                    .foregroundStyle(.white)
                Text("Requesting camera and microphone access…")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                ProgressView().tint(.white)
            }

        case .scanning:
            scanning

        case .naming:
            naming

        case .claiming:
            VStack(spacing: 16) {
                ProgressView().tint(.white)
                Text("Pairing camera…")
                    .foregroundStyle(.white)
            }

        case .failed(let message):
            VStack(spacing: 20) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.yellow)
                Text("Pairing failed")
                    .font(.title2.bold())
                    .foregroundStyle(.white)
                Text(message)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    vm.step = .scanning
                } label: {
                    Text("Try again")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var scanning: some View {
        VStack(spacing: 0) {
            ZStack {
                QRScannerView { code in
                    vm.didScan(code)
                }
                .ignoresSafeArea()

                // Reticle overlay.
                RoundedRectangle(cornerRadius: 24)
                    .stroke(Color.white.opacity(0.9), lineWidth: 3)
                    .frame(width: 240, height: 240)

                VStack {
                    Spacer()
                    Text("Scan the QR code from\nAdd Camera on your dashboard")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding()
                        .background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
                        .padding(.bottom, 60)
                }
            }
        }
    }

    private var naming: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.green)
            Text("Camera detected")
                .font(.title2.bold())
                .foregroundStyle(.white)

            if let caps = vm.capabilities {
                CapabilitySummary(capabilities: caps)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Name this camera")
                    .font(.headline)
                    .foregroundStyle(.white)
                TextField("e.g. Front Door", text: $vm.name)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
            }
            .padding(.horizontal)

            Button {
                Task { await vm.claim(using: model) }
            } label: {
                Text("Pair Camera")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal)
            .disabled(vm.name.trimmingCharacters(in: .whitespaces).isEmpty)

            Button("Rescan") { vm.reset() }
                .tint(.white)

            Spacer()
        }
    }
}

/// Compact read-out of detected capabilities shown during naming.
private struct CapabilitySummary: View {
    let capabilities: CameraCapabilities

    var body: some View {
        VStack(spacing: 6) {
            Label(lensText, systemImage: "camera.aperture")
            Label("Up to \(capabilities.maxResolution.width)×\(capabilities.maxResolution.height)", systemImage: "rectangle.on.rectangle")
            HStack(spacing: 16) {
                Label(capabilities.torch ? "Flash" : "No flash", systemImage: "flashlight.on.fill")
                Label("Zoom \(String(format: "%.0f", capabilities.maxDigitalZoom))×", systemImage: "plus.magnifyingglass")
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .padding()
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }

    private var lensText: String {
        let factors = capabilities.lenses.map { f -> String in
            f == f.rounded() ? "\(Int(f))×" : "\(f)×"
        }
        return "Lenses: " + factors.joined(separator: ", ")
    }
}
