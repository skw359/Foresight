//
//  KeychainStore.swift
//  Foresight Camera Client
//
//  Tiny wrapper around the iOS Keychain for the one secret we must protect:
//  the camera's long-lived `deviceSecret`. Stored as a generic password keyed
//  by camera id so re-pairing a different camera never collides.
//
//  Items are `…AfterFirstUnlockThisDeviceOnly`: readable after the first unlock
//  following a reboot (an unattended camera must reconnect on its own), but
//  never included in backups or migrated to another device — a restored
//  backup must not carry this camera's credentials to a different phone.
//

import Foundation
import Security

enum KeychainStore {
    /// Service namespace for all Foresight items.
    private static let service = "com.foresight.cameraclient.deviceSecret"

    /// Store (or overwrite) the device secret for a camera.
    @discardableResult
    static func saveDeviceSecret(_ secret: String, cameraId: String) -> Bool {
        guard let data = secret.data(using: .utf8) else { return false }

        // Delete any existing item first so we always upsert cleanly.
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: cameraId,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        // Available after first unlock (survives reboots, fits an always-on
        // camera) but bound to THIS device: excluded from backups.
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    /// Items written by earlier versions used `…AfterFirstUnlock` (backed up);
    /// tighten them in place to `…ThisDeviceOnly`.
    static func tightenAccessibility(service: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let update: [String: Any] = [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemUpdate(query as CFDictionary, update as CFDictionary)
    }

    /// Read the device secret for a camera, if present.
    static func loadDeviceSecret(cameraId: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: cameraId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let secret = String(data: data, encoding: .utf8)
        else { return nil }
        tightenAccessibility(service: service, account: cameraId)
        return secret
    }

    /// Remove the device secret for a camera (used on unpair).
    static func deleteDeviceSecret(cameraId: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: cameraId,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
