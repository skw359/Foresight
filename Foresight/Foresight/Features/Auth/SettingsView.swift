//
//  SettingsView.swift
//  Foresight
//
//  Configurable API base URL (default http://localhost:3199, reachable from the
//  Simulator). On a physical device, set this to the host's LAN IP.
//

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://localhost:3199", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                } header: {
                    Text("API Base URL")
                        .font(.montserrat(size: 12, weight: .medium))
                        .foregroundStyle(Theme.secondaryText)
                } footer: {
                    Text("The Foresight backend address. Default works from the iOS Simulator. On a real device, use the host's LAN IP (e.g. http://192.168.1.20:3199).")
                        .font(.montserrat(size: 12))
                        .foregroundStyle(Theme.secondaryText)
                }
                .listRowBackground(Theme.cardBackground)

                Section {
                    Button("Reset to Default") {
                        draft = AppConfig.defaultBaseURL
                    }
                }
                .listRowBackground(Theme.cardBackground)

                if session.isAuthenticated {
                    Section {
                        Button("Sign Out", role: .destructive) {
                            Task { await session.signOut(); dismiss() }
                        }
                        .foregroundStyle(Theme.redAction)
                    }
                    .listRowBackground(Theme.cardBackground)
                }
            }
            .font(.montserrat(size: 15))
            .scrollContentBackground(.hidden)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .font(.montserrat(size: 15, weight: .medium))
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        config.apiBaseURLString = trimmed.isEmpty ? AppConfig.defaultBaseURL : trimmed
                        dismiss()
                    }
                    .font(.montserrat(size: 15, weight: .semibold))
                }
            }
            .onAppear { draft = config.apiBaseURLString }
        }
        .presentationBackground(Theme.background)
    }
}
