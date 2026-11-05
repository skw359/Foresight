//
//  AppModel.swift
//  Foresight Camera Client
//
//  Top-level coordinator. Decides whether to show the pairing flow or camera
//  mode, owns the active RealtimeSession, and manages app-wide concerns.
//
//  A saved pairing is hydrated on launch and streaming RESUMES if it was on
//  before: a relaunch after a power cut, jetsam kill or reboot must not leave the
//  camera dark until someone taps "Go Live". Unpairing also removes the camera
//  on the server.
//

import AVFoundation
import Combine
import Foundation
import LiveKit
import UIKit

@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case pairing
        case camera
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var paired: PairedCamera?
    @Published private(set) var session: RealtimeSession?

    /// Set when the existing-camera key migration hits a fatal, non-retryable
    /// error (a 409: the server already holds a DIFFERENT public key for this
    /// camera). Surfaced in camera mode; nil = healthy.
    @Published private(set) var keyRegistrationError: String?

    /// Shown on the pairing screen after an unpair the server couldn't confirm.
    @Published private(set) var unpairNotice: String?

    private var activeObserver: NSObjectProtocol?

    let telemetry = DeviceTelemetry()

    /// The one-shot existing-camera pubkey migration, held so it can be cancelled
    /// on unpair (backoff loop otherwise runs until it succeeds).
    private var keyMigrationTask: Task<Void, Never>?

    init() {
        hydrate()
        // Coming back to the foreground (or the screen waking) is a good moment
        // to retry a dropped stream immediately rather than waiting out backoff.
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.session?.nudge(reason: "app became active") }
        }
    }

    func hydrate() {
        if let stored = PairingStore.load() {
            paired = stored
            let session = RealtimeSession(paired: stored, telemetry: telemetry)
            self.session = session
            phase = .camera
            startKeyMigrationIfNeeded(for: stored)
            if session.wantsStreaming {
                Task { [weak self] in await self?.resumeStreamingAfterLaunch() }
            }
        } else {
            phase = .pairing
        }
    }

    /// Streaming was on when the app last ran: resume without a tap, as long as
    /// the camera permission still stands (iOS can revoke it in Settings).
    private func resumeStreamingAfterLaunch() async {
        guard cameraAuthorized() else {
            print("[Foresight Camera] streaming was on, but camera access is no longer granted")
            return
        }
        await startStreaming()
    }

    // MARK: Existing-camera E2EE migration

    /// A camera paired before E2EE has a deviceSecret but no keypair. On the first
    /// post-update boot it generates one and registers the public key, retrying
    /// with backoff until the server accepts it. Freshly-paired cameras already
    /// registered their key in /pair/claim, so this is a no-op for them.
    private func startKeyMigrationIfNeeded(for paired: PairedCamera) {
        guard !CameraKeyManager.isPubkeyRegistered else { return }
        // Capture only the Sendable String fields, not the non-Sendable PairedCamera.
        let cameraId = paired.cameraId
        let deviceSecret = paired.deviceSecret
        let serverUrl = paired.serverUrl
        keyMigrationTask?.cancel()
        keyMigrationTask = Task { [weak self] in
            await self?.runKeyMigration(cameraId: cameraId, deviceSecret: deviceSecret, serverUrl: serverUrl)
        }
    }

    private func runKeyMigration(cameraId: String, deviceSecret: String, serverUrl: String) async {
        let publicKey = CameraKeyManager.loadOrCreateKeypair()
        let backend = BackendClient(serverUrl: serverUrl)
        var delay: UInt64 = 1_000_000_000        // 1s, doubling
        let maxDelay: UInt64 = 60_000_000_000     // cap at 60s

        while !Task.isCancelled {
            do {
                try await backend.registerCameraPublicKey(cameraId: cameraId,
                                                          deviceSecret: deviceSecret,
                                                          publicKey: publicKey)
                CameraKeyManager.markPubkeyRegistered()
                keyRegistrationError = nil
                return
            } catch BackendError.http(let status, let message) where status == 409 {
                // A DIFFERENT key is already registered for this camera — a real
                // misconfiguration (e.g. restored-from-backup onto a fresh key).
                // Surface it and STOP; retrying would loop forever.
                let detail = message ?? "conflict"
                keyRegistrationError = "This camera's encryption key conflicts with the one on the server (\(detail)). Unpair and pair it again."
                print("[Foresight Camera][E2EE] pubkey registration 409 (fatal): \(detail)")
                return
            } catch {
                print("[Foresight Camera][E2EE] pubkey registration failed, retrying: \(error.localizedDescription)")
                try? await Task.sleep(nanoseconds: delay)
                delay = min(delay * 2, maxDelay)
            }
        }
    }

    func completePairing(_ camera: PairedCamera) {
        PairingStore.save(camera)
        paired = camera
        unpairNotice = nil
        session = RealtimeSession(paired: camera, telemetry: telemetry)
        phase = .camera
    }

    /// Remove the camera from its Home (server-side, authenticated by the
    /// device secret), forget it locally, and return to pairing. If the server
    /// can't be reached the camera is still forgotten here, and the user is told
    /// to remove it from the dashboard so it doesn't linger as an offline camera
    /// with live credentials.
    func unpair() async {
        keyMigrationTask?.cancel()
        keyMigrationTask = nil
        keyRegistrationError = nil
        await session?.stop()
        session?.invalidate()
        if let paired {
            do {
                try await BackendClient(serverUrl: paired.serverUrl)
                    .unpairCamera(cameraId: paired.cameraId, deviceSecret: paired.deviceSecret)
                unpairNotice = nil
            } catch {
                unpairNotice = "Couldn't reach the server to remove \"\(paired.name)\" from your Home — remove it from the dashboard."
            }
        }
        session = nil
        PairingStore.clear()
        CameraKeyManager.clear()   // drop the E2EE keypair so a re-pair starts fresh
        paired = nil
        setKeepAwake(false)
        phase = .pairing
    }

    // MARK: Streaming lifecycle

    func startStreaming() async {
        guard let session else { return }
        setKeepAwake(true)
        await session.start()
    }

    func stopStreaming() async {
        await session?.stop()
        setKeepAwake(false)
    }

    func clearUnpairNotice() {
        unpairNotice = nil
    }

    func setKeepAwake(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on
    }

    // MARK: Permissions

    /// Returns true only if both camera and microphone are granted.
    func requestPermissions() async -> Bool {
        let cam = await AVCaptureDevice.requestAccess(for: .video)
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        return cam && mic
    }

    func cameraAuthorized() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    }
}
