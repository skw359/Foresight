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
    @FocusState private var isFocused: Bool
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 10) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(Theme.accent)
                            .accessibilityHidden(true)
                        Text("Unlock Encrypted Cameras")
                            .font(.title3.weight(.semibold))
                            .multilineTextAlignment(.center)
                        Text("Enter your password to restore your camera keys on this device. Your video stays end-to-end encrypted.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    VStack(spacing: 12) {
                        InputGroup {
                            SecureField("Password", text: $password)
                                .textContentType(.password)
                                .submitLabel(.go)
                                .focused($isFocused)
                                .onSubmit(submit)
                                .inputRow()
                        }

                        if let errorMessage {
                            InlineError(message: errorMessage)
                        }

                        PrimaryButton(
                            title: "Unlock",
                            isLoading: isSubmitting,
                            isDisabled: password.isEmpty && !isSubmitting,
                            action: submit
                        )
                    }
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 24)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Later") { session.cancelPasswordUnlock() }
                        .tint(.primary)
                }
            }
            .interactiveDismissDisabled(isSubmitting)
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium, .large])
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
