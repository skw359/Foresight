//
//  HomesListView.swift
//  Foresight
//
//  Lists the user's Homes, supports creating a new Home, and opens a Home into
//  its camera grid.
//

import SwiftUI

@MainActor
final class HomesViewModel: ObservableObject {
    @Published var homes: [HomeDTO] = []
    @Published var isLoading = false
    @Published var errorMessage: String?

    /// Bound to the live Session.api once the view appears.
    private var api: APIClient?

    func bind(_ api: APIClient) { self.api = api }

    func load() async {
        guard let api else { return }
        isLoading = true
        errorMessage = nil
        do {
            homes = try await api.listHomes()
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
        }
        isLoading = false
    }

    func create(name: String) async -> Bool {
        guard let api else { return false }
        do {
            let home = try await api.createHome(name: name)
            homes.insert(home, at: 0)
            return true
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            return false
        }
    }
}

struct HomesListView: View {
    @EnvironmentObject private var session: Session
    @StateObject private var model = HomesViewModel()
    @State private var showSettings = false
    @State private var showCreate = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header

                Group {
                    if model.isLoading && model.homes.isEmpty {
                        loadingState
                    } else if model.homes.isEmpty {
                        emptyState
                    } else {
                        list
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showCreate) {
                CreateHomeSheet { name in await model.create(name: name) }
            }
            .task {
                model.bind(session.api)
                await model.load()
            }
        }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 8) {
                Image("Logo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 18, height: 18)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("Foresight")
                    .font(.montserrat(size: 16, weight: .semibold))
                    .foregroundColor(.white)
            }

            Spacer()

            HStack(spacing: 10) {
                GlassCircleButton(systemName: "gearshape", accessibilityText: "Settings") {
                    showSettings = true
                }
                GlassCircleButton(systemName: "plus", accessibilityText: "Add Home") {
                    showCreate = true
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
                ForEach(model.homes) { home in
                    NavigationLink {
                        HomeGridView(home: home)
                    } label: {
                        HomeRow(home: home)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .refreshable { await model.load() }
    }

    private var loadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
                .tint(Theme.accent)
                .scaleEffect(1.2)
            Text("Loading Homes…")
                .font(.montserrat(size: 13, weight: .medium))
                .foregroundStyle(Theme.secondaryText)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "house")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(Theme.accent)
            Text("No Homes Yet")
                .font(.montserrat(size: 18, weight: .bold))
                .foregroundColor(.white)
            Text("Create a Home to start adding cameras.")
                .font(.montserrat(size: 14))
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.center)
            PrimaryButton(title: "Create Home") { showCreate = true }
                .frame(width: 220)
                .padding(.top, 8)
        }
        .padding(.horizontal, 32)
    }
}

private struct HomeRow: View {
    let home: HomeDTO
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "house.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Theme.accent.opacity(0.12))
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(home.name)
                    .font(.montserrat(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Text(home.role.rawValue.capitalized)
                    .font(.montserrat(size: 13))
                    .foregroundStyle(Theme.secondaryText)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.secondaryText)
        }
        .padding(12)
        .darkCard()
    }
}

struct CreateHomeSheet: View {
    let onCreate: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isSubmitting = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                ThemedField(placeholder: "Home name", text: $name)
                    .textInputAutocapitalization(.words)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("New Home")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .font(.montserrat(size: 15, weight: .medium))
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        isSubmitting = true
                        Task {
                            if await onCreate(name.trimmingCharacters(in: .whitespaces)) { dismiss() }
                            isSubmitting = false
                        }
                    }
                    .font(.montserrat(size: 15, weight: .semibold))
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSubmitting)
                }
            }
        }
        .presentationBackground(Theme.background)
    }
}
