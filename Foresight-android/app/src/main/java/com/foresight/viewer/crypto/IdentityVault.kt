/*
 * The viewer's E2EE identity: an X25519 keypair whose private key is wrapped
 * under an Argon2id(password) vault key (crypto_secretbox). Unlocks the vault,
 * unseals per-Home Media Keys (HMK) sealed to the identity, and retains the
 * unlocked keypair in memory only. Port of the iOS IdentityVault actor.
 *
 * Cross-platform parity is load-bearing: every primitive and parameter here
 * must match web (libsodium-wrappers-sumo), iOS/camera (swift-sodium) and the
 * recorder (sodium-native) byte-for-byte, or media silently fails to decrypt.
 * See shared/E2EE.md §3 and shared/test-vectors/e2ee-parity.json
 * (asserted by E2EEParityTest).
 *
 * KDF work (~100–300 ms native Argon2id at opslimit 3 / 64 MiB) runs on
 * Dispatchers.Default, never the main thread.
 */
package com.foresight.viewer.crypto

import android.util.Base64 as AndroidBase64
import com.foresight.viewer.contract.EncryptedKeyVault
import com.foresight.viewer.contract.ForesightE2EE
import com.foresight.viewer.contract.KdfParams
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class VaultException(val kind: Kind) : Exception(kind.message) {
    enum class Kind(val message: String) {
        BAD_VAULT_ENCODING("The key vault is malformed."),
        KDF_FAILED("Could not derive the vault key."),
        UNWRAP_FAILED("Could not unlock your keys (wrong password or corrupt vault)."),
        KEYGEN_FAILED("Could not generate an identity keypair."),
        WRAP_FAILED("Could not encrypt the new identity keypair."),
        UNSEAL_FAILED("Could not unseal the camera key."),
    }
}

/**
 * Base64 helpers that work on both Android (android.util.Base64) and the JVM
 * (java.util.Base64). android.util.Base64 is a stub in unit tests, so route
 * through java.util when available — the encodings are identical (standard
 * alphabet, padding, no wrapping).
 */
object B64 {
    fun decode(value: String): ByteArray? = try {
        java.util.Base64.getDecoder().decode(value)
    } catch (_: Throwable) {
        try {
            AndroidBase64.decode(value, AndroidBase64.NO_WRAP)
        } catch (_: Throwable) {
            null
        }
    }

    fun encode(bytes: ByteArray): String = try {
        java.util.Base64.getEncoder().encodeToString(bytes)
    } catch (_: Throwable) {
        AndroidBase64.encodeToString(bytes, AndroidBase64.NO_WRAP)
    }
}

class IdentityVault(private val sodium: SodiumOps) {

    private val mutex = Mutex()
    private var publicKey: ByteArray? = null
    private var privateKey: ByteArray? = null

    /** True once an identity is unlocked/loaded and available for unsealing. */
    suspend fun isUnlocked(): Boolean = mutex.withLock { privateKey != null }

    /**
     * Derive the Argon2id vault key from [password] + the blob's KdfParams, then
     * crypto_secretbox_open the wrapped private key. Retains the keypair and
     * returns the 32-byte private key.
     *
     * IMPORTANT: the KDF parameters come FROM THE BLOB, not from constants, so a
     * vault created on any platform (e.g. the web dashboard) opens here.
     */
    suspend fun unlock(password: String, vault: EncryptedKeyVault): ByteArray =
        withContext(Dispatchers.Default) {
            val vaultKey = deriveVaultKey(password, vault.kdf)
            val wrapped = B64.decode(vault.wrappedPrivateKey)
                ?: throw VaultException(VaultException.Kind.BAD_VAULT_ENCODING)
            val nonce = B64.decode(vault.nonce)
                ?: throw VaultException(VaultException.Kind.BAD_VAULT_ENCODING)
            val pub = B64.decode(vault.publicKey)
                ?: throw VaultException(VaultException.Kind.BAD_VAULT_ENCODING)
            val sk = sodium.secretBoxOpen(wrapped, nonce, vaultKey)
                ?: throw VaultException(VaultException.Kind.UNWRAP_FAILED)
            mutex.withLock {
                publicKey = pub
                privateKey = sk
            }
            sk.copyOf()
        }

    /**
     * Generate a new X25519 keypair, a fresh 16-byte salt, derive the vault key
     * from [password], wrap the private key, and return the uploadable vault
     * blob plus the raw private key. Retains the keypair. Used only when the
     * account has no keys yet (AuthResponse.keyVault == null).
     */
    suspend fun createVault(password: String): Pair<EncryptedKeyVault, ByteArray> =
        withContext(Dispatchers.Default) {
            val (pub, sk) = sodium.boxKeypair()
                ?: throw VaultException(VaultException.Kind.KEYGEN_FAILED)
            val salt = sodium.randomBytes(ForesightE2EE.KDF_SALT_BYTES)
            val kdf = KdfParams(
                opslimit = ForesightE2EE.ARGON2ID_OPSLIMIT,
                memlimit = ForesightE2EE.ARGON2ID_MEMLIMIT,
                saltB64 = B64.encode(salt),
            )
            val vaultKey = deriveVaultKey(password, kdf)
            val nonce = sodium.randomBytes(ForesightE2EE.SECRETBOX_NONCE_BYTES)
            val wrapped = sodium.secretBoxSeal(sk, nonce, vaultKey)
                ?: throw VaultException(VaultException.Kind.WRAP_FAILED)

            val vault = EncryptedKeyVault(
                publicKey = B64.encode(pub),
                wrappedPrivateKey = B64.encode(wrapped),
                nonce = B64.encode(nonce),
                kdf = kdf,
            )
            mutex.withLock {
                publicKey = pub
                privateKey = sk
            }
            vault to sk.copyOf()
        }

    /**
     * crypto_box_seal_open a sealed HMK against an explicit recipient keypair.
     * Stateless — used by the parity test and internally. Returns the 32-byte HMK.
     */
    fun unseal(sealedB64: String, publicKey: ByteArray, privateKey: ByteArray): ByteArray {
        val sealed = B64.decode(sealedB64)
            ?: throw VaultException(VaultException.Kind.BAD_VAULT_ENCODING)
        return sodium.sealOpen(sealed, publicKey, privateKey)
            ?: throw VaultException(VaultException.Kind.UNSEAL_FAILED)
    }

    /**
     * Unseal using the retained (unlocked) keypair. Null if locked or on failure
     * — the caller surfaces an "awaiting key"/re-unlock state.
     */
    suspend fun unsealRetained(sealedB64: String): ByteArray? {
        val (pub, sk) = mutex.withLock {
            val p = publicKey ?: return null
            val s = privateKey ?: return null
            p.copyOf() to s.copyOf()
        }
        return try {
            unseal(sealedB64, pub, sk)
        } catch (_: VaultException) {
            null
        } finally {
            sk.fill(0)
        }
    }

    /** Load a keypair restored from the biometric cache (cold launch). */
    suspend fun load(publicKey: ByteArray, privateKey: ByteArray) = mutex.withLock {
        this.publicKey = publicKey.copyOf()
        this.privateKey = privateKey.copyOf()
    }

    /**
     * The publicKey(32) || privateKey(32) payload to cache behind biometrics so
     * a cold launch can restore the identity without re-deriving from the password.
     */
    suspend fun biometricPayload(): ByteArray? = mutex.withLock {
        val pub = publicKey ?: return null
        val sk = privateKey ?: return null
        pub + sk
    }

    /** Zero the retained keypair (sign-out / session expiry). */
    suspend fun wipe() = mutex.withLock {
        privateKey?.fill(0)
        privateKey = null
        publicKey = null
    }

    /** Argon2id (ALG_ARGON2ID13) → 32-byte vault key, parameters FROM THE BLOB. */
    private fun deriveVaultKey(password: String, kdf: KdfParams): ByteArray {
        val salt = B64.decode(kdf.saltB64)
            ?: throw VaultException(VaultException.Kind.BAD_VAULT_ENCODING)
        return sodium.argon2id(
            password = password.encodeToByteArray(),
            salt = salt,
            opslimit = kdf.opslimit,
            memlimit = kdf.memlimit,
            outLen = 32,
        ) ?: throw VaultException(VaultException.Kind.KDF_FAILED)
    }
}
