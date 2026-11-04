//
//  SettingsView.swift
//  Foresight
//
//  Account and the configurable API base URL (default http://localhost:3199,
//  reachable from the Simulator). On a physical device, set this to the host's
//  LAN IP.
//

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""
    @State private var confirmingSignOut = false

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasChanges: Bool {
        !trimmedDraft.isEmpty && trimmedDraft != config.apiBaseURLString
    }

    var body: some View {
        NavigationStack {
            Form {
                // currentUser isn't persisted, so after a relaunch there's no name to show.
                if let identifier = session.currentUser?.identifier, !identifier.isEmpty {
                    Section("Account") {
                        LabeledContent("Signed In As", value: identifier)
                    }
                }

                Section {
                    TextField(AppConfig.defaultBaseURL, text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)

                    Button("Reset to Default") {
                        draft = AppConfig.defaultBaseURL
                    }
                    .disabled(trimmedDraft == AppConfig.defaultBaseURL)
                } header: {
                    Text("Server")
                } footer: {
                    Text(verbatim: "The Foresight backend address. The default works from the iOS Simulator. On a real device, use the host's LAN IP (for example, http://192.168.1.20:3199).")
                }

                if session.isAuthenticated {
                    Section {
                        Button("Sign Out", role: .destructive) {
                            confirmingSignOut = true
                        }
                        .foregroundStyle(Theme.critical)
                        .confirmationDialog(
                            "Sign out of Foresight?",
                            isPresented: $confirmingSignOut,
                            titleVisibility: .visible
                        ) {
                            Button("Sign Out", role: .destructive) {
                                Task { await session.signOut(); dismiss() }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("Your camera keys are removed from this iPhone. You'll need your password to view encrypted cameras again.")
                        }
                    }
                }

                brandFooter
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                        .tint(.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", role: .confirm) {
                        config.apiBaseURLString = trimmedDraft.isEmpty ? AppConfig.defaultBaseURL : trimmedDraft
                        dismiss()
                    }
                    .foregroundStyle(hasChanges ? AnyShapeStyle(Theme.onAccent) : AnyShapeStyle(.secondary))
                    .disabled(!hasChanges)
                }
            }
            .onAppear { draft = config.apiBaseURLString }
        }
        .interactiveDismissDisabled(hasChanges)
    }

    private var brandFooter: some View {
        Section {
            EmptyView()
        } footer: {
            VStack(spacing: 6) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityHidden(true)
                Text("Foresight")
                    .font(.wordmark(size: 13, relativeTo: .footnote))
                    .foregroundStyle(.primary)
                if let version {
                    Text(version)
                        .font(.caption2)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
        }
    }

    private var version: String? {
        guard let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            return nil
        }
        return "Version \(short)"
    }
}
