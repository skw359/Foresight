//
//  HomeGridView.swift
//  Foresight
//
//  The wall: every camera in a Home, live, with nothing between you and the video.
//  Connects to the Home's LiveKit room via a viewer rt token, subscribes to each
//  camera's LOW layer, and opens a tile into the live view with a zoom transition.
//

import SwiftUI
import Combine
import LiveKit

@MainActor
final class HomeGridViewModel: ObservableObject {
    let home: HomeDTO
    @Published var room: RoomManager
    /// A rename or remove the user asked for failed. Stays until acknowledged.
    @Published var errorMessage: String?
    /// The background camera refresh failed. Clears itself on the next success, so
    /// a passing network blip never interrupts someone watching a live view.
    @Published var listError: String?
    @Published var didInitialLoad = false

    private let api: APIClient
    private var pollTask: Task<Void, Never>?
    private var roomObservation: AnyCancellable?

    init(home: HomeDTO, api: APIClient) {
        self.home = home
        self.api = api
        self.room = RoomManager(homeId: home.id, api: api)
        // RoomManager is a nested ObservableObject: SwiftUI only observes this
        // model, so its phase/camera changes never reach the view on their own.
        // Forward them, otherwise the connection banner freezes on "Connecting…"
        // after the room has already connected.
        roomObservation = room.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
    }

    func start() async {
        await refreshCameras()
        didInitialLoad = true
        await room.connect()
        startPolling()
    }

    func stop() async {
        pollTask?.cancel()
        pollTask = nil
        await room.disconnect()
    }

    func refreshCameras() async {
        do {
            let cams = try await api.listCameras(homeId: home.id)
            room.setRESTCameras(cams)
            listError = nil
        } catch {
            listError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Periodically refresh the REST registry so newly-paired cameras and
    /// offline status changes appear even without a realtime event.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if Task.isCancelled { break }
                await self?.refreshCameras()
            }
        }
    }

    func rename(_ camera: LiveCamera, to name: String) async {
        do {
            let updated = try await api.renameCamera(cameraId: camera.id, name: name)
            camera.merge(rest: updated)
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func remove(_ camera: LiveCamera) async {
        do {
            try await api.removeCamera(cameraId: camera.id)
            await refreshCameras()
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Presentation

    var isEncrypted: Bool { (home.keyEpoch ?? 0) >= 1 }

    /// Why no camera in this Home can show video right now, for the tile
    /// placeholders. Nil while the room is healthy or still coming up.
    var roomIssue: String? {
        switch room.phase {
        case .failed, .disconnected: return "Not connected"
        case .locked: return "Locked"
        case .awaitingKey: return "Waiting for key"
        case .idle, .connecting, .connected: return nil
        }
    }
}

/// How the wall arranges cameras. A presentation preference only.
enum WallLayout: String, CaseIterable, Identifiable {
    case large, grid

    var id: String { rawValue }

    var title: String {
        switch self {
        case .large: return "Large"
        case .grid: return "Grid"
        }
    }

    var systemImage: String {
        switch self {
        case .large: return "rectangle.grid.1x2"
        case .grid: return "square.grid.2x2"
        }
    }
}

struct HomeGridView: View {
    @EnvironmentObject private var session: Session
    @StateObject private var model: HomeGridViewModel
    @AppStorage("foresight.wallLayout") private var layout: WallLayout = .large

    /// A problem refreshing the list of Homes, surfaced above the wall.
    private let homesError: String?
    private let onDismissHomesError: () -> Void
    private let onRefreshHomes: () async -> Void
    private let onOpenSettings: () -> Void

    @State private var showPairing = false
    @State private var fullScreenCamera: LiveCamera?
    /// The tile the live view zooms back to; follows camera switches.
    @State private var viewerSourceID = ""
    @State private var renameTarget: LiveCamera?
    @State private var removeTarget: LiveCamera?
    @Namespace private var viewerTransition

    init(
        home: HomeDTO,
        homesError: String? = nil,
        onDismissHomesError: @escaping () -> Void = {},
        onRefreshHomes: @escaping () async -> Void = {},
        onOpenSettings: @escaping () -> Void = {}
    ) {
        // Build against the live session API via the placeholder pattern: the
        // real client is identical (same baseURLProvider + token store) because
        // Session.api is the single shared instance.
        _model = StateObject(wrappedValue: HomeGridViewModel(home: home, api: Session.shared.api))
        self.homesError = homesError
        self.onDismissHomesError = onDismissHomesError
        self.onRefreshHomes = onRefreshHomes
        self.onOpenSettings = onOpenSettings
    }

    private var cameras: [LiveCamera] { model.room.cameras }

    private var columns: [GridItem] {
        // Portrait iPhones get one full-width column in Large; landscape and iPad
        // fit more without shrinking the video.
        let minimum: CGFloat = layout == .large ? 320 : 165
        return [GridItem(.adaptive(minimum: minimum), spacing: layout == .large ? 12 : 8)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                statusRow
                notices

                if !model.didInitialLoad {
                    skeleton
                } else if !cameras.isEmpty {
                    wall
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .overlay {
            if model.didInitialLoad && cameras.isEmpty && model.listError == nil {
                emptyState
            }
        }
        .background(Theme.canvas.ignoresSafeArea())
        .refreshable {
            await onRefreshHomes()
            await model.refreshCameras()
            await retryConnectionIfNeeded()
        }
        // The title is drawn by the Home switcher in HomeRootView; this keeps the
        // Home's name available to the system without showing it twice.
        .navigationTitle(model.home.name)
        .toolbarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .toolbar { toolbarContent }
        .sheet(isPresented: $showPairing) {
            AddCameraView(home: model.home) {
                Task { await model.refreshCameras() }
            }
        }
        .fullScreenCover(item: $fullScreenCamera) { camera in
            FullScreenCameraView(camera: camera, room: model.room, viewModel: model) { current in
                viewerSourceID = current.id
            }
            .navigationTransition(.zoom(sourceID: viewerSourceID, in: viewerTransition))
        }
        .modifier(CameraRenameAlert(viewModel: model, renameTarget: $renameTarget))
        .task { await model.start() }
        .onDisappear { Task { await model.stop() } }
        // When the E2EE identity finishes unlocking (Face ID or password), a Home
        // that was held in `.locked` can connect and decrypt.
        .onChange(of: session.unlockPhase) { _, newValue in
            if newValue == .unlocked, model.room.phase == .locked {
                Task { await model.room.connect() }
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { showPairing = true } label: {
                Label("Add Camera", systemImage: "plus")
            }
            .tint(.primary)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Layout", selection: $layout) {
                    ForEach(WallLayout.allCases) { option in
                        Label(option.title, systemImage: option.systemImage).tag(option)
                    }
                }
                .pickerStyle(.inline)

                Button(action: onOpenSettings) {
                    Label("Settings", systemImage: "gearshape")
                }
            } label: {
                Label("More", systemImage: "ellipsis")
            }
            .tint(.primary)
        }
    }

    // MARK: - Status

    /// One line that answers "is everything OK?" so individual tiles don't have to.
    private var statusRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                statusLabel
                Spacer(minLength: 8)
                if model.isEncrypted { encryptionLabel }
            }
            VStack(alignment: .leading, spacing: 4) {
                statusLabel
                if model.isEncrypted { encryptionLabel }
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var statusLabel: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            switch model.room.phase {
            case .idle, .connecting:
                ProgressView().controlSize(.mini)
            case .connected:
                if cameras.isEmpty {
                    StatusDot(isOnline: true)
                } else if onlineCount == 0 {
                    StatusDot(isOnline: false)
                } else {
                    Circle()
                        .fill(isEverythingHealthy ? Theme.live : Theme.caution)
                        .frame(width: 8, height: 8)
                }
            default:
                StatusDot(isOnline: false)
            }
            Text(statusText)
        }
    }

    private var encryptionLabel: some View {
        Label("End-to-end encrypted", systemImage: "lock.fill")
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
    }

    private var onlineCount: Int { cameras.filter(\.isOnline).count }

    private var isEverythingHealthy: Bool {
        onlineCount == cameras.count && cameras.allSatisfy(\.alerts.isEmpty)
    }

    private var statusText: String {
        switch model.room.phase {
        case .idle, .connecting: return "Connecting…"
        case .locked: return "Locked"
        case .awaitingKey: return "Waiting for access"
        case .failed, .disconnected: return "Not connected"
        case .connected: break
        }

        let total = cameras.count
        guard total > 0 else { return "Connected" }

        var text: String
        if onlineCount == total {
            text = total == 1 ? "Live" : "All \(total) cameras live"
        } else {
            text = "\(onlineCount) of \(total) cameras online"
        }
        let needAttention = cameras.filter { !$0.alerts.isEmpty }.count
        if needAttention > 0 {
            text += " · \(needAttention) \(needAttention == 1 ? "needs" : "need") attention"
        }
        return text
    }

    @ViewBuilder
    private var notices: some View {
        connectionNotice

        if let error = model.errorMessage {
            StatusCard(
                systemImage: "exclamationmark.triangle.fill",
                tint: Theme.caution,
                title: "Something went wrong",
                message: error,
                onDismiss: { model.errorMessage = nil }
            )
        }
        // Both of these usually share one cause, so show one card rather than two.
        if let error = model.listError {
            StatusCard(
                systemImage: "wifi.exclamationmark",
                tint: Theme.caution,
                title: "Couldn't update cameras",
                message: error,
                actionTitle: cameras.isEmpty ? "Try Again" : nil,
                action: cameras.isEmpty ? { Task { await model.refreshCameras() } } : nil
            )
        } else if let homesError {
            StatusCard(
                systemImage: "exclamationmark.triangle.fill",
                tint: Theme.caution,
                title: "Couldn't refresh Homes",
                message: homesError,
                onDismiss: onDismissHomesError
            )
        }
    }

    @ViewBuilder
    private var connectionNotice: some View {
        switch model.room.phase {
        case .failed(let message):
            StatusCard(
                systemImage: "exclamationmark.triangle.fill",
                tint: Theme.caution,
                title: "Can't connect",
                message: message,
                actionTitle: "Retry"
            ) {
                Task { await model.room.connect() }
            }
        case .disconnected:
            StatusCard(
                systemImage: "wifi.slash",
                title: "Disconnected",
                message: "Live video stopped because the connection to this Home was lost.",
                actionTitle: "Reconnect"
            ) {
                Task { await model.room.connect() }
            }
        case .locked:
            StatusCard(
                systemImage: "lock.shield.fill",
                tint: Theme.accent,
                title: "Unlock required",
                message: "This Home's cameras are end-to-end encrypted. Unlock to decrypt them on this device.",
                actionTitle: "Unlock"
            ) {
                Task { await session.ensureIdentityUnlocked() }
            }
        case .awaitingKey:
            StatusCard(
                systemImage: "key.horizontal.fill",
                title: "Waiting for access",
                message: "A Home member on the web dashboard needs to grant this device the camera key. This can take a moment.",
                actionTitle: "Check Again"
            ) {
                Task { await model.room.connect() }
            }
        default:
            EmptyView()
        }
    }

    private func retryConnectionIfNeeded() async {
        switch model.room.phase {
        case .failed, .disconnected, .awaitingKey:
            await model.room.connect()
        default:
            break
        }
    }

    // MARK: - Wall

    private var wall: some View {
        LazyVGrid(columns: columns, spacing: layout == .large ? 12 : 8) {
            ForEach(cameras) { camera in
                Button {
                    open(camera)
                } label: {
                    CameraTile(
                        camera: camera,
                        room: model.room,
                        style: layout == .large ? .large : .compact,
                        roomIssue: model.roomIssue
                    )
                }
                .buttonStyle(TilePressStyle())
                .matchedTransitionSource(id: camera.id, in: viewerTransition) { source in
                    source.clipShape(RoundedRectangle(
                        cornerRadius: layout == .large ? Theme.Radius.tile : Theme.Radius.compactTile,
                        style: .continuous
                    ))
                }
                .contextMenu {
                    Button {
                        renameTarget = camera
                    } label: {
                        Label {
                            Text("Rename")
                        } icon: {
                            Image(systemName: "pencil")
                                .tint(.primary)
                        }
                    }
                    .tint(.primary)
                    Button(role: .destructive) {
                        removeTarget = camera
                    } label: {
                        Label("Remove Camera", systemImage: "trash")
                    }
                } preview: {
                    CameraPeek(camera: camera)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(camera.name)
                .accessibilityValue(camera.spokenStatus)
                .accessibilityHint("Opens live view")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { open(camera) }
                // On the tile, so the dialog points at the camera it's about.
                .modifier(CameraRemoveConfirmation(
                    camera: camera,
                    viewModel: model,
                    removeTarget: $removeTarget
                ))
            }
        }
    }

    private func open(_ camera: LiveCamera) {
        viewerSourceID = camera.id
        fullScreenCamera = camera
    }

    private var skeleton: some View {
        LazyVGrid(columns: columns, spacing: layout == .large ? 12 : 8) {
            ForEach(0..<(layout == .large ? 3 : 6), id: \.self) { _ in
                TileSkeleton(style: layout == .large ? .large : .compact)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading cameras")
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Cameras Yet", systemImage: "video.badge.plus")
        } description: {
            Text("Turn a spare iPhone into a camera for \(model.home.name) by pairing it with a QR code.")
        } actions: {
            Button("Add Camera") { showPairing = true }
                .prominentAction()
        }
    }
}

// MARK: - Rename / remove

/// The rename prompt, shared by the wall's context menu and the details sheet.
struct CameraRenameAlert: ViewModifier {
    @ObservedObject var viewModel: HomeGridViewModel
    @Binding var renameTarget: LiveCamera?

    @State private var renameText = ""

    func body(content: Content) -> some View {
        content
            .onChange(of: renameTarget?.id) { _, _ in
                renameText = renameTarget?.name ?? ""
            }
            .alert(
                "Rename Camera",
                isPresented: Binding(
                    get: { renameTarget != nil },
                    set: { if !$0 { renameTarget = nil } }
                ),
                presenting: renameTarget
            ) { camera in
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    Task { await viewModel.rename(camera, to: trimmed) }
                }
            }
    }
}

/// The remove confirmation. Attach it to the control that asked, so the dialog
/// originates from it.
struct CameraRemoveConfirmation: ViewModifier {
    let camera: LiveCamera
    @ObservedObject var viewModel: HomeGridViewModel
    @Binding var removeTarget: LiveCamera?
    /// Called after a removal succeeds.
    var onRemoved: () -> Void = {}

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Remove \(camera.name)?",
                isPresented: Binding(
                    get: { removeTarget?.id == camera.id },
                    set: { if !$0 { removeTarget = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove Camera", role: .destructive) {
                    Task {
                        await viewModel.remove(camera)
                        // Only move on if the removal actually succeeded; otherwise
                        // stay so the surfaced error remains visible.
                        if viewModel.errorMessage == nil { onRemoved() }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This unpairs the camera from this Home. You can pair it again later.")
            }
    }
}
