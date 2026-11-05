//
//  PairingStore.swift
//  Foresight Camera Client
//
//  Persists the non-secret half of a pairing across launches. The
//  `deviceSecret` itself lives only in the Keychain (see KeychainStore).
//

import Foundation

struct PairedCamera: Equatable {
    var cameraId: String
    var name: String
    var homeId: String
    var serverUrl: String
    var livekitUrl: String
    var deviceSecret: String
    var capabilities: CameraCapabilities
}

enum PairingStore {
    // UserDefaults.standard is documented as thread-safe; the Sendable check is
    // overly conservative here. Suppress it for this immutable shared reference.
    nonisolated(unsafe) private static let defaults = UserDefaults.standard
    private static let key = "foresight.pairing.v1"

    /// Everything *except* the secret.
    private struct Record: Codable {
        var cameraId: String
        var name: String
        var homeId: String
        var serverUrl: String
        var livekitUrl: String
        var capabilities: CameraCapabilities
    }

    static func save(_ camera: PairedCamera) {
        let record = Record(
            cameraId: camera.cameraId,
            name: camera.name,
            homeId: camera.homeId,
            serverUrl: camera.serverUrl,
            livekitUrl: camera.livekitUrl,
            capabilities: camera.capabilities
        )
        if let data = try? JSONEncoder().encode(record) {
            defaults.set(data, forKey: key)
        }
        KeychainStore.saveDeviceSecret(camera.deviceSecret, cameraId: camera.cameraId)
    }

    static func load() -> PairedCamera? {
        guard let data = defaults.data(forKey: key),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              let secret = KeychainStore.loadDeviceSecret(cameraId: record.cameraId)
        else { return nil }

        return PairedCamera(
            cameraId: record.cameraId,
            name: record.name,
            homeId: record.homeId,
            serverUrl: record.serverUrl,
            livekitUrl: record.livekitUrl,
            deviceSecret: secret,
            capabilities: record.capabilities
        )
    }

    static func clear() {
        if let data = defaults.data(forKey: key),
           let record = try? JSONDecoder().decode(Record.self, from: data) {
            KeychainStore.deleteDeviceSecret(cameraId: record.cameraId)
        }
        defaults.removeObject(forKey: key)
    }
}
