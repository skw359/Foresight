//
//  UnlockView.swift
//  Foresight
//
//  Cold-launch E2EE re-unlock. Presented at the app root when the JWT survived
//  but the in-memory identity key did not and Face ID / Touch ID was
//  unavailable or declined (plan §7.4, anchor Session.swift:39). Re-derives the
//  identity key from the password so E2EE-activated Homes can decrypt again.
//

import SwiftUI

struct UnlockView: View {
    @EnvironmentObject private var session: Session
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 44))
                        .foregroundStyle(Theme.accent)
                        .padding(.top, 24)

                    VStack(spacing: 8) {
                        Text("Unlock Encrypted Cameras")
                            .font(.montserrat(size: 19, weight: .bold))
                            .foregroundColor(.white)
                        Text("Enter your password to restore your camera keys on this device. Your video stays end-to-end encrypted.")
                            .font(.montserrat(size: 14))
                            .foregroundStyle(Theme.secondaryText)
                            .multilineTextAlignment(.center)
                    }

                    ThemedField(placeholder: "Password", text: $password, isSecure: true)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit { submit() }

                    if let errorMessage {
                        ErrorBanner(message: errorMessage)
                    }

                    PrimaryButton(
                        title: "Unlock",
                        isLoading: isSubmitting,
                        isDisabled: password.isEmpty || isSubmitting
                    ) {
                        submit()
                    }
                }
                .padding(24)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Later") { session.cancelPasswordUnlock() }
                        .font(.montserrat(size: 15, weight: .medium))
                        .tint(Theme.secondaryText)
                }
            }
            .interactiveDismissDisabled(isSubmitting)
        }
        .presentationBackground(Theme.background)
    }

    private func submit() {
        guard !password.isEmpty, !isSubmitting else { return }
        errorMessage = nil
        isSubmitting = true
        let pw = password
        Task {
            let ok = await session.completePasswordUnlock(pw)
            if !ok { errorMessage = "Incorrect password, or your key vault could not be opened." }
            isSubmitting = false
        }
    }
}
