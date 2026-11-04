//
//  LiveCamera.swift
//  Foresight
//
//  Observable per-camera live model. Combines the REST CameraDTO (identity,
//  capabilities) with realtime data fed in from `state`/`telemetry` messages
//  and the subscribed video track. Drives the grid tiles and full-screen view.
//

import Foundation
import Combine
import LiveKit

@MainActor
final class LiveCamera: ObservableObject, Identifiable {
    let id: String

    /// Last-known REST metadata (name, capabilities, etc.).
    @Published var info: CameraDTO

    /// The remote participant publishing this camera, once present in the room.
    @Published var participant: RemoteParticipant?

    /// The subscribed video track (nil until subscribed / while paused).
    @Published var videoTrack: VideoTrack?

    /// Whether the camera participant is currently connected to the room.
    @Published var isConnected: Bool = false

    /// True when LiveKit reports we can't (yet) decrypt this camera's E2EE frames
    /// (missing/rotating key). Drives the "Decrypting…" overlay instead of black
    /// video (plan §10.3). Cleared once frames decrypt (`.ok`).
    @Published var e2eeDecrypting: Bool = false

    // MARK: Realtime control state (from StateMessage)
    @Published var torchOn: Bool = false
    @Published var lens: Double = 1
    @Published var zoom: Double = 1
    @Published var quality: QualityPreset = .auto
    @Published var recording: Bool = false
    @Published var talking: Bool = false

    // MARK: Telemetry (from TelemetryMessage; overrides stale REST status)
    @Published var battery: Double?
    @Published var charging: Bool?
    @Published var wifi: WifiInfo?
    @Published var thermal: ThermalState?
    @Published var viewerCount: Int = 0

    init(info: CameraDTO) {
        self.id = info.id
        self.info = info
        // Seed from REST status so badges show before the first telemetry tick.
        self.battery = info.status.battery
        self.charging = info.status.charging
        self.wifi = info.status.wifi
        self.thermal = info.status.thermal
    }

    var name: String { info.name }
    var capabilities: CameraCapabilities? { info.capabilities }

    /// LiveKit participant identity for this camera (`camera:<id>`).
    var identity: String { Foresight.cameraIdentity(id) }

    /// Whether the camera is considered online (connected in room OR REST online).
    var isOnline: Bool { isConnected || info.online }

    func apply(_ msg: StateMessage) {
        torchOn = msg.torchOn
        lens = msg.lens
        zoom = msg.zoom
        quality = msg.quality
        recording = msg.recording
        talking = msg.talking
    }

    func apply(_ msg: TelemetryMessage) {
        battery = msg.battery
        charging = msg.charging
        wifi = msg.wifi
        thermal = msg.thermal
        viewerCount = msg.viewerCount
    }

    /// Merge fresh REST metadata (e.g. after rename) without clobbering live data.
    func merge(rest: CameraDTO) {
        info = rest
        if !isConnected { // only trust REST status while the camera is offline
            battery = rest.status.battery
            charging = rest.status.charging
            wifi = rest.status.wifi
            thermal = rest.status.thermal
        }
    }
}
