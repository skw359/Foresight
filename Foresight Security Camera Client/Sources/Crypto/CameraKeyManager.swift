//
//  CameraKeyManager.swift
//  Foresight Camera Client
//
//  The camera's E2EE identity (E2EE_MODEL_B_PLAN.md §7.3). On-device X25519
//  keypair used to receive the Home Media Key (HMK): a logged-in member seals
//  the HMK to this camera's public key, and only the private key here can
//  unseal it (crypto_box_seal / crypto_box_seal_open, via swift-sodium).
//
//  Storage (deliberate, per plan §7.3 / §13 row 6):
//    - PRIVATE key  → its own Keychain item, kSecAttrAccessibleAfterFirstUnlock
//      (a security camera must stream unattended after a reboot). It is NOT
//      wrapped under `deviceSecret`: both live in the same Keychain protection
//      class, so wrapping adds complexity with no adversary benefit.
//    - PUBLIC key   → UserDefaults (non-secret), alongside the pairing metadata.
//
//  A device hosts exactly one camera, and the keypair is generated BEFORE the
//  server assigns a cameraId (at /pair/claim), so storage is keyed by a fixed
//  account rather than by cameraId.
//
//  This type is a stateless namespace (like PairingStore / KeychainStore):
//  the Keychain + UserDefaults are the source of truth, so it is trivially
//  Sendable and safe to call from any isolation domain.
//

import Foundation
import Security
import Sodium

enum CameraKeyError: LocalizedError {
    case malformedSealedKey
    case missingPrivateKey
    case missingPublicKey
    case unsealFailed

    var errorDescription: String? {
        switch self {
        case .malformedSealedKey: return "The sealed key is not valid base64."
        case .missingPrivateKey: return "This camera has no encryption private key."
        case .missingPublicKey: return "This camera has no encryption public key."
        case .unsealFailed: return "Could not unseal the home key (wrong key or corrupt data)."
        }
    }
}

enum CameraKeyManager {
    // UserDefaults.standard is documented thread-safe; mirror PairingStore's
    // suppression of the (overly conservative) Sendable check.
    nonisolated(unsafe) private static let defaults = UserDefaults.standard

    // Keychain namespace for the camera's E2EE private key (its own item,
    // separate from the deviceSecret item in KeychainStore).
    private static let keychainService = "com.foresight.cameraclient.cameraKey"
    private static let keychainAccount = "cameraIdentity"

    // UserDefaults keys (single camera per device → unscoped).
    private static let publicKeyKey = "foresight.e2ee.cameraPublicKey.v1"
    private static let registeredKey = "foresight.e2ee.pubkeyRegistered.v1"
    private static let homeKeyPendingKey = "foresight.e2ee.homeKeyPending.v1"

    // MARK: - Keypair lifecycle

    /// Ensure an X25519 keypair exists (generating + persisting one on first
    /// call) and return the base64 public key. Idempotent: repeated calls return
    /// the same key, so retries in the migration flow re-send an identical pubkey.
    @discardableResult
    static func loadOrCreateKeypair() -> String {
        if let existing = defaults.string(forKey: publicKeyKey), loadPrivateKey() != nil {
            return existing
        }

        let sodium = Sodium()
        // crypto_box_keypair (Curve25519 / X25519) — never returns nil in
        // practice (only if sodium_init failed, which the DEBUG self-test catches).
        guard let keyPair = sodium.box.keyPair() else {
            preconditionFailure("libsodium keypair generation failed")
        }
        savePrivateKey(Data(keyPair.secretKey))
        let publicKeyB64 = Data(keyPair.publicKey).base64EncodedString()
        defaults.set(publicKeyB64, forKey: publicKeyKey)
        return publicKeyB64
    }

    /// The persisted base64 public key, or nil if no keypair exists yet.
    static var publicKeyBase64: String? {
        defaults.string(forKey: publicKeyKey)
    }

    /// Open an anonymous sealed box (`crypto_box_seal_open`) holding the HMK,
    /// returning the 32-byte key. Throws rather than returning nil so callers can
    /// surface a precise reason.
    static func unseal(_ sealedB64: String) throws -> Data {
        guard let sealed = Data(base64Encoded: sealedB64) else {
            throw CameraKeyError.malformedSealedKey
        }
        guard let secretKey = loadPrivateKey() else { throw CameraKeyError.missingPrivateKey }
        guard let publicKeyB64 = defaults.string(forKey: publicKeyKey),
              let publicKey = Data(base64Encoded: publicKeyB64) else {
            throw CameraKeyError.missingPublicKey
        }

        let sodium = Sodium()
        guard let opened = sodium.box.open(anonymousCipherText: [UInt8](sealed),
                                           recipientPublicKey: [UInt8](publicKey),
                                           recipientSecretKey: [UInt8](secretKey)) else {
            throw CameraKeyError.unsealFailed
        }
        return Data(opened)
    }

    // MARK: - Migration / pairing bookkeeping

    /// Whether this camera's public key has been registered with the server
    /// (either in the /pair/claim body for new cameras, or via the existing-camera
    /// migration POST /cameras/:id/pubkey). Gates the one-shot migration on boot.
    static var isPubkeyRegistered: Bool {
        defaults.bool(forKey: registeredKey)
    }

    static func markPubkeyRegistered() {
        defaults.set(true, forKey: registeredKey)
    }

    /// Persisted hint from ClaimPairingResponse.homeKeyPending. Informational: the
    /// authoritative gate at connect time is RtTokenResponse.keyEpoch/sealedHomeKey.
    static var homeKeyPending: Bool {
        get { defaults.bool(forKey: homeKeyPendingKey) }
        set { defaults.set(newValue, forKey: homeKeyPendingKey) }
    }

    /// Forget all E2EE key state (on unpair). The next pairing generates a fresh
    /// keypair.
    static func clear() {
        deletePrivateKey()
        defaults.removeObject(forKey: publicKeyKey)
        defaults.removeObject(forKey: registeredKey)
        defaults.removeObject(forKey: homeKeyPendingKey)
    }

    // MARK: - Keychain (private key)

    @discardableResult
    private static func savePrivateKey(_ data: Data) -> Bool {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        // Available after first unlock; survives reboots, fits an always-on camera
        // that must stream unattended (plan §7.3).
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    private static func loadPrivateKey() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return data
    }

    private static func deletePrivateKey() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Startup self-test (DEBUG)

    #if DEBUG
    /// A lightweight self-test proving libsodium's seal/open round-trips and that
    /// the byte sizes match the locked contract (plan §3.2 / ForesightE2EE). Called
    /// at startup in DEBUG so a broken libsodium or a size drift fails loudly here
    /// rather than as silent black video in the field.
    static func assertConstants() {
        let sodium = Sodium()
        guard let keyPair = sodium.box.keyPair() else {
            assertionFailure("libsodium keypair generation failed")
            return
        }
        assert(keyPair.publicKey.count == ForesightE2EE.x25519KeyBytes,
               "X25519 public key must be \(ForesightE2EE.x25519KeyBytes) bytes")
        assert(keyPair.secretKey.count == ForesightE2EE.x25519KeyBytes,
               "X25519 secret key must be \(ForesightE2EE.x25519KeyBytes) bytes")

        guard let hmk = sodium.randomBytes.buf(length: ForesightE2EE.hmkBytes) else {
            assertionFailure("randomBytes failed")
            return
        }
        assert(hmk.count == ForesightE2EE.hmkBytes)

        guard let sealed = sodium.box.seal(message: hmk, recipientPublicKey: keyPair.publicKey) else {
            assertionFailure("crypto_box_seal failed")
            return
        }
        assert(sealed.count == ForesightE2EE.sealedHmkBytes,
               "sealed HMK must be \(ForesightE2EE.sealedHmkBytes) bytes, got \(sealed.count)")

        guard let opened = sodium.box.open(anonymousCipherText: sealed,
                                           recipientPublicKey: keyPair.publicKey,
                                           recipientSecretKey: keyPair.secretKey) else {
            assertionFailure("crypto_box_seal_open failed")
            return
        }
        assert(opened == hmk, "seal/open round-trip mismatch")

        // 32 raw bytes → 44 base64 chars: the exact string handed to LiveKit setKey.
        assert(Data(hmk).base64EncodedString().count == 44,
               "base64(HMK) must be 44 chars")
    }
    #endif
}
