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

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if isLoading {
                    VStack(spacing: 14) {
                        ProgressView()
                            .tint(Theme.accent)
                            .scaleEffect(1.2)
                        Text("Generating pairing code…")
                            .font(.montserrat(size: 13, weight: .medium))
                            .foregroundStyle(Theme.secondaryText)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let qrImage {
                    qrContent(qrImage)
                } else {
                    Color.clear
                }
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Add Camera")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .font(.montserrat(size: 15, weight: .semibold))
                }
            }
            .task { await generate() }
            .onDisappear { onPaired() }
        }
        .presentationBackground(Theme.background)
    }

    private func qrContent(_ image: UIImage) -> some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 280, maxHeight: 280)
                .padding(16)
                .background(.white, in: RoundedRectangle(cornerRadius: 16))
                .accessibilityLabel("Pairing QR code")

            VStack(spacing: 6) {
                Text("Scan with a Camera Client")
                    .font(.montserrat(size: 17, weight: .bold))
                    .foregroundColor(.white)
                Text("Open the Foresight Camera app on the iPhone you want to use as a camera and scan this code to add it to \(home.name).")
                    .font(.montserrat(size: 14))
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
            }

            // v1 pure-consumer scope (plan §2.3 / §7.4): the iOS app never seals
            // keys. In an E2EE-activated Home a newly-paired camera is granted its
            // key from the web dashboard, so it may show "Waiting for key" briefly.
            if (home.keyEpoch ?? 0) >= 1 {
                Label("This Home is end-to-end encrypted. Grant the new camera its key from the web dashboard.",
                      systemImage: "lock.shield")
                    .font(.montserrat(size: 12))
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
            }

            OutlineButton(title: "New Code") {
                Task { await generate() }
            }

            Spacer(minLength: 0)
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "qrcode")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(Theme.accent)
            Text("Couldn't Create Code")
                .font(.montserrat(size: 18, weight: .bold))
                .foregroundColor(.white)
            Text(message)
                .font(.montserrat(size: 14))
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.center)
            PrimaryButton(title: "Try Again") { Task { await generate() } }
                .frame(width: 220)
                .padding(.top, 8)
        }
        .padding(.horizontal, 32)
    }

    private func generate() async {
        isLoading = true
        errorMessage = nil
        qrImage = nil
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
