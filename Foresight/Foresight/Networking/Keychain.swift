//
//  Keychain.swift
//  Foresight
//
//  Minimal Keychain wrapper for persisting the auth JWT securely. Generic
//  password items, scoped to this app, accessible after first unlock.
//

import Foundation
import LocalAuthentication
import Security

enum Keychain {
    private static let service = "com.foresight.viewer.auth"

    enum Item: String {
        case authToken = "authToken"
    }

    /// Account for the biometric-gated E2EE identity key cache (see below).
    private static let identityAccount = "e2eeIdentityKey"
    /// Non-secret hint: whether a biometric identity item was cached, so the UI
    /// can offer Face ID vs. going straight to a password prompt WITHOUT probing
    /// the (biometric-gated) Keychain item, which would prompt.
    private static let identityCachedFlag = "e2ee.hasCachedIdentity"

    static func set(_ value: String, for item: Item) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
        ]
        // Replace any existing value atomically.
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func get(_ item: Item) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func remove(_ item: Item) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.rawValue,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Biometric E2EE identity cache (plan §7.4 / anchor Keychain.swift:15)
    //
    // Caches the DECRYPTED identity keypair (publicKey(32) || privateKey(32))
    // behind Face ID / Touch ID with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
    // + a `.biometryCurrentSet` access control, so a cold launch (JWT restored but
    // the in-memory key gone — Session.swift:39 region) can restore the identity
    // without re-typing the password. Wiped on sign-out / session expiry.

    /// Store the raw identity payload behind biometrics. Best-effort: if the
    /// device has no biometrics / secure enclave, the item simply isn't created
    /// and the app falls back to a password re-unlock.
    static func cacheIdentityKey(_ data: Data) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: identityAccount,
        ]
        SecItemDelete(base as CFDictionary)

        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .biometryCurrentSet,
            nil
        ) else { return }

        var attributes = base
        attributes[kSecValueData as String] = data
        // With an access control object, DO NOT also set kSecAttrAccessible.
        attributes[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(attributes as CFDictionary, nil)
        UserDefaults.standard.set(status == errSecSuccess, forKey: identityCachedFlag)
    }

    /// Read the biometric-cached identity payload, prompting for Face ID / Touch
    /// ID. Runs off the calling actor because the biometric prompt blocks the
    /// thread. Returns nil if absent, denied, or unavailable (→ password path).
    static func loadIdentityKey(reason: String) async -> Data? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let context = LAContext()
                context.localizedReason = reason
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service,
                    kSecAttrAccount as String: identityAccount,
                    kSecReturnData as String: true,
                    kSecMatchLimit as String: kSecMatchLimitOne,
                    kSecUseAuthenticationContext as String: context,
                ]
                var result: AnyObject?
                let status = SecItemCopyMatching(query as CFDictionary, &result)
                if status == errSecSuccess, let data = result as? Data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    /// True when a biometric identity item was cached (non-secret hint, no
    /// prompt). If the item was later invalidated (biometrics changed), the
    /// Face ID read simply fails and the caller falls back to the password path.
    static func hasIdentityKey() -> Bool {
        UserDefaults.standard.bool(forKey: identityCachedFlag)
    }

    static func removeIdentityKey() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: identityAccount,
        ]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.set(false, forKey: identityCachedFlag)
    }
}
