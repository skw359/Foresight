//
//  IdentityVault.swift
//  Foresight
//
//  The viewer's E2EE identity: an X25519 keypair whose private key is wrapped
//  under an Argon2id(password) vault key (crypto_secretbox). This actor unlocks
//  the vault, unseals per-Home Media Keys (HMK) sealed to the identity, and
//  retains the unlocked keypair in memory only.
//
//  Cross-platform parity is load-bearing: every primitive and parameter here
//  must match the web (libsodium-wrappers-sumo), camera (swift-sodium) and
//  recorder (sodium-native) implementations byte-for-byte, or media silently
//  fails to decrypt. See shared/E2EE.md §3 and the frozen parity vector at
//  shared/test-vectors/e2ee-parity.json (asserted by E2EEParityTests).
//
//  libsodium (not CryptoKit): CryptoKit cannot open a libsodium sealed box
//  (no crypto_box / XSalsa20) — swift-sodium is mandatory (plan §3.1).
//
//  This is an `actor` so the ~100–300 ms native Argon2id (opslimit 3, 64 MiB)
//  runs off the main actor (plan §9.2).
//

import Foundation
import Sodium

actor IdentityVault {

    enum VaultError: LocalizedError {
        case badVaultEncoding
        case kdfFailed
        case unwrapFailed
        case keygenFailed
        case wrapFailed
        case unsealFailed

        var errorDescription: String? {
            switch self {
            case .badVaultEncoding: return "The key vault is malformed."
            case .kdfFailed:        return "Could not derive the vault key."
            case .unwrapFailed:     return "Could not unlock your keys (wrong password or corrupt vault)."
            case .keygenFailed:     return "Could not generate an identity keypair."
            case .wrapFailed:       return "Could not encrypt the new identity keypair."
            case .unsealFailed:     return "Could not unseal the camera key."
            }
        }
    }

    /// libsodium context (sodium_init is idempotent / thread-safe).
    private let sodium = Sodium()

    /// Retained, unlocked identity keypair — memory only, never persisted here.
    private var publicKey: [UInt8]?
    private var privateKey: [UInt8]?

    /// True once an identity is unlocked/loaded and available for unsealing.
    var isUnlocked: Bool { privateKey != nil }

    // MARK: - Unlock an existing vault

    /// Derive the Argon2id vault key from `password` + the blob's KdfParams,
    /// then crypto_secretbox_open the wrapped private key. Retains the keypair.
    /// Returns the 32-byte private key.
    ///
    /// - Important: the KDF parameters come FROM THE BLOB, not from constants,
    ///   so a vault created on any platform (e.g. the web dashboard) opens here.
    func unlock(password: String, vault: EncryptedKeyVault) throws -> Data {
        let vaultKey = try deriveVaultKey(password: password, kdf: vault.kdf)
        guard let wrapped = Data(base64Encoded: vault.wrappedPrivateKey),
              let nonce = Data(base64Encoded: vault.nonce),
              let pub = Data(base64Encoded: vault.publicKey) else {
            throw VaultError.badVaultEncoding
        }
        guard let sk = sodium.secretBox.open(authenticatedCipherText: [UInt8](wrapped),
                                             secretKey: vaultKey,
                                             nonce: [UInt8](nonce)) else {
            throw VaultError.unwrapFailed
        }
        publicKey = [UInt8](pub)
        privateKey = sk
        return Data(sk)
    }

    // MARK: - First-login migration (create a fresh vault)

    /// Generate a new X25519 keypair, a fresh 16-byte salt, derive the vault key
    /// from `password`, wrap the private key, and return the uploadable vault
    /// blob plus the raw private key. Retains the keypair. Used only when the
    /// account has no keys yet (AuthResponse.keyVault == nil).
    func createVault(password: String) throws -> (vault: EncryptedKeyVault, privateKey: Data) {
        guard let keyPair = sodium.box.keyPair() else { throw VaultError.keygenFailed }
        guard let salt = sodium.randomBytes.buf(length: ForesightE2EE.kdfSaltBytes) else {
            throw VaultError.keygenFailed
        }
        let kdf = KdfParams(opslimit: ForesightE2EE.argon2idOpslimit,
                            memlimit: ForesightE2EE.argon2idMemlimit,
                            saltB64: Data(salt).base64EncodedString())
        let vaultKey = try deriveVaultKey(password: password, kdf: kdf)

        // Disambiguate the (authenticatedCipherText, nonce) seal overload by type.
        let sealed: (authenticatedCipherText: [UInt8], nonce: [UInt8])? =
            sodium.secretBox.seal(message: keyPair.secretKey, secretKey: vaultKey)
        guard let sealed else { throw VaultError.wrapFailed }

        let vault = EncryptedKeyVault(
            publicKey: Data(keyPair.publicKey).base64EncodedString(),
            wrappedPrivateKey: Data(sealed.authenticatedCipherText).base64EncodedString(),
            nonce: Data(sealed.nonce).base64EncodedString(),
            kdf: kdf
        )
        publicKey = keyPair.publicKey
        privateKey = keyPair.secretKey
        return (vault, Data(keyPair.secretKey))
    }

    // MARK: - Unseal a Home Media Key

    /// crypto_box_seal_open a sealed HMK against an explicit recipient keypair.
    /// Stateless — used by the parity test and internally. Returns the 32-byte HMK.
    func unseal(sealedB64: String, publicKey pub: Data, privateKey priv: Data) throws -> Data {
        guard let sealed = Data(base64Encoded: sealedB64) else { throw VaultError.badVaultEncoding }
        guard let hmk = sodium.box.open(anonymousCipherText: [UInt8](sealed),
                                        recipientPublicKey: [UInt8](pub),
                                        recipientSecretKey: [UInt8](priv)) else {
            throw VaultError.unsealFailed
        }
        return Data(hmk)
    }

    /// Unseal using the retained (unlocked) keypair. Returns nil if locked or on
    /// failure — the caller surfaces an "awaiting key"/re-unlock state.
    func unsealRetained(sealedB64: String) -> Data? {
        guard let publicKey, let privateKey else { return nil }
        return try? unseal(sealedB64: sealedB64, publicKey: Data(publicKey), privateKey: Data(privateKey))
    }

    // MARK: - In-memory retention

    /// Load a keypair restored from the biometric Keychain cache (cold launch).
    func load(publicKey pub: Data, privateKey priv: Data) {
        publicKey = [UInt8](pub)
        privateKey = [UInt8](priv)
    }

    /// The `publicKey(32) || privateKey(32)` payload to cache behind Face ID so a
    /// cold launch can restore the identity without re-deriving from the password.
    func biometricPayload() -> Data? {
        guard let publicKey, let privateKey else { return nil }
        return Data(publicKey) + Data(privateKey)
    }

    /// Zero the retained keypair (sign-out / session expiry).
    func wipe() {
        // Best-effort scrub of the private key's backing store before dropping it.
        privateKey?.withUnsafeMutableBytes { raw in
            for i in 0..<raw.count { raw[i] = 0 }
        }
        privateKey = nil
        publicKey = nil
    }

    // MARK: - KDF

    /// Argon2id (ALG_ARGON2ID13) → 32-byte vault key, parameters FROM THE BLOB.
    private func deriveVaultKey(password: String, kdf: KdfParams) throws -> [UInt8] {
        guard let salt = Data(base64Encoded: kdf.saltB64) else { throw VaultError.badVaultEncoding }
        guard let key = sodium.pwHash.hash(outputLength: sodium.secretBox.KeyBytes,
                                           passwd: [UInt8](Data(password.utf8)),
                                           salt: [UInt8](salt),
                                           opsLimit: kdf.opslimit,
                                           memLimit: kdf.memlimit,
                                           alg: .Argon2ID13) else {
            throw VaultError.kdfFailed
        }
        return key
    }
}
