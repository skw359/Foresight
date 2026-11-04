//
//  HomeGridView.swift
//  Foresight
//
//  Camera grid for one Home. Connects to the Home's LiveKit room via a viewer
//  rt token, subscribes to each camera's LOW layer, and renders tiles with live
//  video + health badges + viewer count. Tapping a tile opens full-screen.
//

import SwiftUI
import Combine
import LiveKit

@MainActor
final class HomeGridViewModel: ObservableObject {
    let home: HomeDTO
    @Published var room: RoomManager
    @Published var errorMessage: String?
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
        } catch {
            errorMessage = (error as? APIError)?.message ?? error.localizedDescription
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
}

struct HomeGridView: View {
    @EnvironmentObject private var session: Session
    @StateObject private var model: HomeGridViewModel
    @State private var showPairing = false
    @State private var fullScreenCamera: LiveCamera?

    init(home: HomeDTO) {
        // Build against the live session API via the placeholder pattern: the
        // real client is identical (same baseURLProvider + token store) because
        // Session.api is the single shared instance.
        _model = StateObject(wrappedValue: HomeGridViewModel(home: home, api: Session.shared.api))
    }

    private let columns = [GridItem(.adaptive(minimum: 165), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                connectionBanner
                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
                if model.room.cameras.isEmpty && model.didInitialLoad {
                    emptyState
                } else {
                    gridHeader
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(model.room.cameras) { camera in
                            Button { fullScreenCamera = camera } label: {
                                CameraTile(camera: camera, room: model.room)
                            }
                            .buttonStyle(TilePressStyle())
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle(model.home.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showPairing = true } label: {
                    Label("Add Camera", systemImage: "plus.viewfinder")
                }
            }
        }
        .sheet(isPresented: $showPairing) {
            AddCameraView(home: model.home) {
                Task { await model.refreshCameras() }
            }
        }
        .fullScreenCover(item: $fullScreenCamera) { camera in
            FullScreenCameraView(camera: camera, room: model.room, viewModel: model)
        }
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

    /// Section header above the grid: camera count plus a live indicator once
    /// the room is connected.
    private var gridHeader: some View {
        HStack(spacing: 5) {
            if model.room.phase == .connected {
                Circle()
                    .fill(Color.green)
                    .frame(width: 6, height: 6)
            }
            Text(headerText)
                .font(.montserrat(size: 13, weight: .semibold))
                .foregroundStyle(Theme.secondaryText)
            Spacer()
        }
        .padding(.horizontal, 2)
    }

    /// "Connecting to cameras..." while the room is still coming up on first
    /// entry, then the camera count once connected.
    private var headerText: String {
        switch model.room.phase {
        case .idle, .connecting:
            return "Connecting..."
        default:
            return model.room.cameras.count == 1 ? "1 Camera" : "\(model.room.cameras.count) Cameras"
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        switch model.room.phase {
        case .failed(let message):
            statusCard(
                icon: "exclamationmark.triangle.fill",
                iconColor: .orange,
                title: "Can't connect",
                message: message,
                actionTitle: "Retry"
            ) {
                Task { await model.room.connect() }
            }
        case .locked:
            statusCard(
                icon: "lock.shield.fill",
                iconColor: Theme.accent,
                title: "Unlock required",
                message: "This Home's cameras are end-to-end encrypted. Unlock to decrypt them on this device.",
                actionTitle: "Unlock"
            ) {
                Task { await session.ensureIdentityUnlocked() }
            }
        case .awaitingKey:
            statusCard(
                icon: "key.horizontal.fill",
                iconColor: Theme.secondaryText,
                title: "Waiting for access",
                message: "A Home member on the web dashboard needs to grant this device the camera key. This can take a moment.",
                actionTitle: "Check again"
            ) {
                Task { await model.room.connect() }
            }
        default:
            EmptyView()
        }
    }

    private func statusCard(
        icon: String,
        iconColor: Color,
        title: String,
        message: String,
        actionTitle: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 48, height: 48)
                .background(Circle().fill(iconColor.opacity(0.12)))
            VStack(spacing: 6) {
                Text(title)
                    .font(.montserrat(size: 16, weight: .semibold))
                    .foregroundColor(.white)
                Text(message)
                    .font(.montserrat(size: 13))
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            OutlineButton(title: actionTitle, action: action)
                .padding(.top, 2)
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity)
        .darkCard(cornerRadius: 16)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "video.slash")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(Theme.accent)
                .frame(width: 84, height: 84)
                .background(Circle().fill(Theme.accent.opacity(0.12)))
            VStack(spacing: 8) {
                Text("No Cameras")
                    .font(.montserrat(size: 20, weight: .bold))
                    .foregroundColor(.white)
                Text("Add a camera by showing its pairing QR code to a Camera Client iPhone.")
                    .font(.montserrat(size: 14))
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }
            PrimaryButton(title: "Add Camera") { showPairing = true }
                .frame(width: 220)
                .padding(.top, 10)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 72)
    }
}

/// Gently scales a camera tile down while pressed for tactile feedback.
private struct TilePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
