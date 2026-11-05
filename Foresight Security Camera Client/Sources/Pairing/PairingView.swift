//
//  PairingView.swift
//  Foresight Camera Client
//
//  The pairing flow: permissions → scan the dashboard's QR (a PairingTicket JSON)
//  → detect capabilities → name the camera AND confirm the server → claim.
//
//  The camera trusts the QR's server URL permanently (every later token mint
//  sends its device secret there), so the user must explicitly confirm that
//  server before claiming — a QR pointing somewhere unexpected is the one thing
//  that would hand this camera's credentials and video to someone else.
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
    /// The user confirmed the server shown on screen is theirs (required to pair).
    @Published var serverConfirmed = false

    /// "host:port" of the ticket's server, shown for confirmation.
    var serverDisplay: String {
        guard let url = ticket.flatMap({ URLComponents(string: $0.serverUrl) }) else { return "—" }
        let host = url.host ?? "—"
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// True when the pairing (and every later request) would travel unencrypted
    /// beyond a private LAN address.
    var serverIsCleartextPublic: Bool {
        guard let url = ticket.flatMap({ URLComponents(string: $0.serverUrl) }),
              url.scheme == "http", let host = url.host else { return false }
        return !Self.isPrivateHost(host)
    }

    static func isPrivateHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        switch (octets[0], octets[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, let b) where (16...31).contains(b): return true
        case (100, let b) where (64...127).contains(b): return true   // CGNAT / Tailscale
        default: return false
        }
    }

    private(set) var ticket: PairingTicket?
    private(set) var capabilities: CameraCapabilities?

    func requestPermissions(using model: AppModel) async {
        let granted = await model.requestPermissions()
        step = granted ? .scanning : .failed("Camera and microphone access are required to pair and stream.")
    }

    func didScan(_ payload: String) {
        guard case .scanning = step else { return }
        guard let data = payload.data(using: .utf8),
              let ticket = try? JSONDecoder().decode(PairingTicket.self, from: data)
        else {
            step = .failed("That QR code isn't a Foresight pairing code. Open Add Camera on the dashboard and try again.")
            return
        }

        let serverComponents = URLComponents(string: ticket.serverUrl)
        guard let scheme = serverComponents?.scheme?.lowercased(), scheme == "http" || scheme == "https",
              serverComponents?.host?.isEmpty == false
        else {
            step = .failed("This pairing code has an invalid server address. Generate a new one on the dashboard.")
            return
        }
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

    func claim(using model: AppModel) async {
        guard let ticket, let capabilities, serverConfirmed else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            step = .failed("Please give this camera a name.")
            return
        }

        step = .claiming
        let backend = BackendClient(serverUrl: ticket.serverUrl)
        do {
            // Generate (or reuse) the camera's E2EE identity BEFORE claiming and
            // send its public key in the claim. The private key never leaves the
            // Keychain.
            let cameraPublicKey = CameraKeyManager.loadOrCreateKeypair()
            let response = try await backend.claimPairing(token: ticket.token, name: trimmed,
                                                          capabilities: capabilities,
                                                          cameraPublicKey: cameraPublicKey)
            // The server now holds our pubkey → skip the existing-camera migration.
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
        serverConfirmed = false
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
            if let notice = model.unpairNotice {
                Label(notice, systemImage: "info.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color.orange.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.bottom, 8)
                    .onTapGesture { model.clearUnpairNotice() }
            }
            ZStack {
                QRScannerView { code in
                    vm.didScan(code)
                }
                .ignoresSafeArea()

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

            // The camera will trust this server permanently — make the user
            // look at it. A QR that points somewhere unexpected must not pair.
            VStack(alignment: .leading, spacing: 8) {
                Text("Server")
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(vm.serverDisplay)
                    .font(.body.monospaced())
                    .foregroundStyle(.white)
                if vm.serverIsCleartextPublic {
                    Label("This server isn't on your local network and the connection isn't encrypted (http).",
                          systemImage: "exclamationmark.shield.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                Toggle(isOn: $vm.serverConfirmed) {
                    Text("This is my Foresight server")
                        .font(.subheadline)
                        .foregroundStyle(.white)
                }
                .tint(.green)
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
            .disabled(vm.name.trimmingCharacters(in: .whitespaces).isEmpty || !vm.serverConfirmed)

            Button("Rescan") { vm.reset() }
                .tint(.white)

            Spacer()
        }
    }
}

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
