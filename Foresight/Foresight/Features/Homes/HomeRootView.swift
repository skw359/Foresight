//
//  HomeRootView.swift
//  Foresight
//
//  The authenticated root. Opens straight onto the wall of the last-viewed Home:
//  Homes are something you switch between, so they live in the title menu rather
//  than on a screen you have to pass through before seeing any video.
//

import SwiftUI

@MainActor
final class HomesViewModel: ObservableObject {
    @Published var homes: [HomeDTO] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var hasLoaded = false

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
        hasLoaded = true
    }

    func create(name: String) async -> HomeDTO? {
        guard let api else { return nil }
        do {
            let home = try await api.createHome(name: name)
            homes.insert(home, at: 0)
            return home
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }
}

struct HomeRootView: View {
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var config: AppConfig
    @StateObject private var model = HomesViewModel()
    @AppStorage("foresight.selectedHomeID") private var selectedHomeID = ""
    @State private var showSettings = false
    @State private var showCreate = false

    private var selectedHome: HomeDTO? {
        model.homes.first { $0.id == selectedHomeID } ?? model.homes.first
    }

    var body: some View {
        NavigationStack {
            Group {
                if let home = selectedHome {
                    // Identity follows the Home: switching tears down this Home's
                    // room and connects to the next one.
                    HomeGridView(
                        home: home,
                        homesError: model.errorMessage,
                        onDismissHomesError: { model.errorMessage = nil },
                        onRefreshHomes: { await model.load() },
                        onOpenSettings: { showSettings = true }
                    )
                    .id(home.id)
                    .toolbar { homeSwitcherItem(current: home) }
                } else {
                    noHomeContent
                        .navigationTitle("Foresight")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button { showSettings = true } label: {
                                    Label("Settings", systemImage: "gearshape")
                                }
                                .tint(.primary)
                            }
                        }
                }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showCreate) {
            CreateHomeSheet { name in
                guard let home = await model.create(name: name) else {
                    let message = model.errorMessage
                    model.errorMessage = nil
                    return message ?? "Couldn't create this Home."
                }
                selectedHomeID = home.id
                return nil
            }
        }
        .task {
            model.bind(session.api)
            await model.load()
        }
        // The server address changed in Settings: everything shown came from the
        // old one, so reload from the new one.
        .onChange(of: config.apiBaseURLString) { _, _ in
            Task { await model.load() }
        }
    }

    // MARK: - Home switcher

    /// The screen's title is also how you change Homes. A bare large title with a
    /// chevron, not a glass button: it names the screen first and acts second.
    private func homeSwitcherItem(current: HomeDTO) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { homeSwitcher(current: current) }
            .sharedBackgroundVisibility(.hidden)
    }

    private func homeSwitcher(current: HomeDTO) -> some View {
        Menu {
            ForEach(model.homes) { home in
                Toggle(isOn: Binding(
                    get: { home.id == current.id },
                    set: { _ in selectedHomeID = home.id }
                )) {
                    Text(home.name)
                    Text(home.role.rawValue.capitalized)
                }
            }
            Divider()
            Button { showCreate = true } label: {
                Label("New Home…", systemImage: "plus")
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(current.name)
                    .font(.title.bold())
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        // A title, not a colored action.
        .tint(.primary)
        .accessibilityLabel(current.name)
        .accessibilityHint("Switches Homes")
    }

    // MARK: - States without a Home

    @ViewBuilder
    private var noHomeContent: some View {
        if !model.hasLoaded {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel("Loading Homes")
        } else if let error = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Homes", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
                    .prominentAction()
            }
        } else {
            ContentUnavailableView {
                Label("Create Your First Home", systemImage: "house")
            } description: {
                Text("A Home groups your cameras together, like one for each place you want to keep an eye on.")
            } actions: {
                Button("Create Home") { showCreate = true }
                    .prominentAction()
            }
        }
    }
}

// MARK: - New Home

struct CreateHomeSheet: View {
    /// Creates the Home, returning an error message on failure.
    let onCreate: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var name = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .focused($isFocused)
                        .onSubmit(submit)
                } footer: {
                    if let errorMessage {
                        InlineError(message: errorMessage)
                    } else {
                        Text("For example, “Home” or “Cabin”.")
                    }
                }
            }
            .navigationTitle("New Home")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { dismiss() }
                        .tint(.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting {
                        ProgressView()
                    } else {
                        Button("Create", role: .confirm, action: submit)
                            .foregroundStyle(trimmedName.isEmpty ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.onAccent))
                            .disabled(trimmedName.isEmpty)
                    }
                }
            }
            .onAppear { isFocused = true }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isSubmitting)
    }

    private func submit() {
        guard !trimmedName.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            if let message = await onCreate(trimmedName) {
                errorMessage = message
            } else {
                dismiss()
            }
            isSubmitting = false
        }
    }
}
