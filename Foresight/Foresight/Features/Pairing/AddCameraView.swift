//
//  AddCameraView.swift
//  Foresight
//
//  QR pairing sheet. Requests a one-time PairingTicket from the backend and
//  renders it as a QR code for a Camera Client iPhone to scan (mirrors the web
//  pairing flow). When the sheet is dismissed we refresh the camera list via
//  `onPaired` so a freshly-claimed camera appears.
//

import SwiftUI

struct AddCameraView: View {
    let home: HomeDTO
    /// Called on dismiss so the grid can refresh and pick up the new camera.
    let onPaired: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var ticket: PairingTicket?
    @State private var qrImage: UIImage?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isExpired = false

    private var expiry: Date? { ForesightDate.parse(ticket?.expiresAt) }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Generating pairing code…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let qrImage {
                    qrContent(qrImage)
                } else {
                    Color.clear
                }
            }
            .navigationTitle("Add Camera")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .tint(.primary)
                }
            }
            .task { await generate() }
            .onDisappear { onPaired() }
            // Flip to the expired state exactly when the code stops working.
            .task(id: expiry) {
                guard let expiry else { return }
                let remaining = expiry.timeIntervalSinceNow
                if remaining > 0 {
                    try? await Task.sleep(for: .seconds(remaining))
                    guard !Task.isCancelled else { return }
                }
                isExpired = true
            }
        }
    }

    private func qrContent(_ image: UIImage) -> some View {
        ScrollView {
            VStack(spacing: 24) {
                qrCode(image)
                steps

                // v1 pure-consumer scope (plan §2.3 / §7.4): the iOS app never seals
                // keys. In an E2EE-activated Home a newly-paired camera is granted its
                // key from the web dashboard, so it may show "Waiting for key" briefly.
                if (home.keyEpoch ?? 0) >= 1 {
                    Label("This Home is end-to-end encrypted. Grant the new camera its key from the web dashboard.",
                          systemImage: "lock.shield")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
    }

    private func qrCode(_ image: UIImage) -> some View {
        VStack(spacing: 14) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 260, maxHeight: 260)
                .padding(16)
                .background(.white, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .opacity(isExpired ? 0.25 : 1)
                .overlay {
                    if isExpired {
                        Label("Code Expired", systemImage: "clock.badge.exclamationmark")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.8), in: Capsule())
                    }
                }
                .accessibilityLabel(isExpired ? "Expired pairing QR code" : "Pairing QR code")

            HStack(spacing: 12) {
                if !isExpired, let expiry, expiry > .now {
                    Text("Expires in \(Text(timerInterval: Date.now...expiry, countsDown: true))")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Button("New Code") {
                    Task { await generate() }
                }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(.primary)
            }
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 14) {
            step(1, "Open Foresight Camera on the iPhone you want to use as a camera.")
            step(2, "Scan this code, then give the camera a name.")
            step(3, "It appears in \(home.name) as soon as it connects.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 16)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't Create Code", systemImage: "qrcode")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again") { Task { await generate() } }
                .prominentAction()
        }
    }

    private func generate() async {
        isLoading = true
        errorMessage = nil
        qrImage = nil
        isExpired = false
        defer { isLoading = false }
        do {
            let ticket = try await Session.shared.api.pairCamera(homeId: home.id)
            self.ticket = ticket
            self.qrImage = QRCode.image(from: ticket.qrPayload())
            if qrImage == nil {
                errorMessage = "Could not render the pairing QR code."
            }
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
