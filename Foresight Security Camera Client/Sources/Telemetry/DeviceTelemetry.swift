//
//  DeviceTelemetry.swift
//  Foresight Camera Client
//
//  Samples device health (battery, thermal state, Wi-Fi) for the periodic
//  `telemetry` heartbeat and the on-screen overlay.
//
//  iOS does not expose true RSSI without private API, so Wi-Fi `level` is an
//  approximation: a coarse bar count derived from path constraints.
//  `rssi`/`ssid` are left nil per the contract's optionality.
//

import Foundation
import Network
import UIKit

struct TelemetrySnapshot: Equatable {
    var battery: Double?      // 0.0 ... 1.0, or nil if unknown
    var charging: Bool?
    var wifi: WifiInfo?       // nil when not on Wi-Fi
    var thermal: ThermalState
}

@MainActor
final class DeviceTelemetry: ObservableObject {
    @Published private(set) var snapshot = TelemetrySnapshot(
        battery: nil, charging: nil, wifi: nil, thermal: .nominal
    )

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.foresight.telemetry.path")
    private var latestPath: NWPath?

    init() {
        UIDevice.current.isBatteryMonitoringEnabled = true

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            Task { @MainActor in
                self.latestPath = path
                self.refresh()
            }
        }
        monitor.start(queue: monitorQueue)
        refresh()
    }

    deinit {
        monitor.cancel()
    }

    /// Cheap; safe to call on a timer.
    func refresh() {
        let device = UIDevice.current
        let level = device.batteryLevel            // -1.0 if unknown
        let battery: Double? = level < 0 ? nil : Double(level)

        let charging: Bool?
        switch device.batteryState {
        case .charging, .full: charging = true
        case .unplugged: charging = false
        case .unknown: charging = nil
        @unknown default: charging = nil
        }

        snapshot = TelemetrySnapshot(
            battery: battery,
            charging: charging,
            wifi: wifiInfo(from: latestPath),
            thermal: Self.thermalState()
        )
    }

    // MARK: Helpers

    /// Returns nil when the active path is not Wi-Fi.
    private func wifiInfo(from path: NWPath?) -> WifiInfo? {
        guard let path, path.status == .satisfied, path.usesInterfaceType(.wifi) else {
            return nil
        }
        // No public RSSI API. Approximate bars from path quality signals:
        // a constrained/expensive path implies a weaker/limited link.
        var level = 3 // default to "good" when connected and unconstrained
        if path.isConstrained { level = 1 }
        else if path.isExpensive { level = 2 }
        return WifiInfo(level: level, rssi: nil, ssid: nil)
    }

    static func thermalState() -> ThermalState {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return .nominal
        case .fair: return .fair
        case .serious: return .serious
        case .critical: return .critical
        @unknown default: return .nominal
        }
    }
}
