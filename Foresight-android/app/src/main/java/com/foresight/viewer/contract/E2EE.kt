/*
 * Foresight Security — E2EE contract (Kotlin mirror).
 *
 * Hand-kept in sync with shared/ts/src/e2ee.ts (THE canonical source of truth).
 *
 * ── The locked LiveKit key-application contract (shared/E2EE.md §3.2) ──
 * A divergence on ANY value below produces SILENT decryption failure (black
 * video, no error):
 *   1. Key application: setSharedKey(base64(HMK)) as a STRING (LiveKit's PBKDF2
 *      path — the Android SDK UTF-8-encodes it), never the raw 32 bytes.
 *   2. keySize 128 (AES-GCM 128 is what the PBKDF2 derivation yields).
 *   3. encryptionType = AES-GCM.
 *   4. sharedKey = true — one HMK decrypts every camera in a Home.
 *   5. ratchetSalt = "LKFrameEncryptionKey".
 *   6. ratchetWindowSize = 0 — the Android SDK DEFAULTS TO 16; set explicitly.
 *   7. keyIndex = 0 — EVERY platform, EVERY rotation. Home.keyEpoch /
 *      SealedKey.epoch are server bookkeeping, NEVER a LiveKit key index.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

object ForesightE2EE {
    /** AES key size in bits — 128 is the only value all LiveKit SDKs support. */
    const val KEY_SIZE = 128
    /** Frame-encryption algorithm; must match the publisher (camera). */
    const val ENCRYPTION_TYPE = "gcm"
    /** LiveKit key-derivation ratchet salt (SDK default — keep on ALL platforms). */
    const val RATCHET_SALT = "LKFrameEncryptionKey"
    /** No automatic ratcheting in v1 (Android SDK default is 16 — always pass this). */
    const val RATCHET_WINDOW_SIZE = 0
    /** LOCKED to 0 in v1 — every platform, every rotation. */
    const val KEY_INDEX = 0
    /** Key-ring capacity; reserved for the v2 rotation ring, indices stay 0 in v1. */
    const val KEY_RING_SIZE = 16
    /** PBKDF2 iterations LiveKit derives the AES key with (informational; self-tests). */
    const val PBKDF2_ITERATIONS = 100_000

    /** Argon2id password→vault-key parameters (stored per-blob in KdfParams). */
    const val ARGON2ID_OPSLIMIT = 3
    const val ARGON2ID_MEMLIMIT = 67_108_864

    /** libsodium byte sizes (self-test assertions). */
    const val X25519_KEY_BYTES = 32
    const val HMK_BYTES = 32
    const val SEALED_HMK_BYTES = 80
    const val WRAPPED_PRIVATE_KEY_BYTES = 48
    const val SECRETBOX_NONCE_BYTES = 24
    const val KDF_SALT_BYTES = 16
}

/** Who a sealed copy of a Home's Media Key belongs to. */
@Serializable
enum class KeyHolderType {
    @SerialName("user") USER,
    @SerialName("camera") CAMERA,
    @SerialName("recorder") RECORDER,
}

/**
 * Argon2id parameters stored alongside each wrapped vault (retunable without
 * bricking old vaults). `algo` is always "argon2id" (libsodium ALG_ARGON2ID13).
 */
@Serializable
data class KdfParams(
    val algo: String = "argon2id",
    val opslimit: Int,
    val memlimit: Int,
    /** base64, ForesightE2EE.KDF_SALT_BYTES bytes. */
    val saltB64: String,
)

/**
 * A user's identity keypair at rest: X25519 public key in the clear, private
 * key wrapped under Argon2id(password) via crypto_secretbox_easy. The server
 * stores this blob verbatim and can never open it.
 */
@Serializable
data class EncryptedKeyVault(
    /** base64 X25519 public key (32 B). */
    val publicKey: String,
    /** base64 crypto_secretbox_easy(privateKey) — 48 B. */
    val wrappedPrivateKey: String,
    /** base64 secretbox nonce (24 B). */
    val nonce: String,
    val kdf: KdfParams,
)

/**
 * A sealed copy of a Home Media Key for one holder. `epoch` is Home.keyEpoch —
 * a server-side delivery/consistency counter, NEVER a LiveKit key index.
 */
@Serializable
data class SealedKey(
    /** base64 crypto_box_seal(HMK → holder pubkey) — 80 B. */
    val ciphertext: String,
    val epoch: Int,
)

/** Response to GET /me/keys. keyVault null ⇒ run first-login key generation. */
@Serializable
data class MeKeysResponse(
    val keyVault: EncryptedKeyVault? = null,
)

/**
 * Response to GET /homes/:homeId/key — the caller's own sealed HMK copy at the
 * Home's current epoch. epoch 0 ⇒ E2EE not activated. sealedKey null with
 * epoch ≥ 1 ⇒ activated but nobody sealed to the caller yet ("waiting for access").
 */
@Serializable
data class HomeKeyResponse(
    val epoch: Int,
    /** base64 sealed box (80 B) or null. */
    val sealedKey: String? = null,
)

/** One holder lacking a sealed HMK copy at the Home's current epoch. */
@Serializable
data class PendingKeyHolder(
    val holderType: KeyHolderType,
    val holderId: String,
    /** base64 X25519 public key to seal to. */
    val publicKey: String,
    /** Human-readable label for grant UIs. */
    val label: String,
    /** True when this holder never held a key for this Home (first-contact grant). */
    val firstContact: Boolean,
)

@Serializable
data class PendingKeyHoldersResponse(
    val epoch: Int,
    val pending: List<PendingKeyHolder>,
)

/** One sealed HMK copy being uploaded for a holder. */
@Serializable
data class SealedKeyUpload(
    val holderType: KeyHolderType,
    val holderId: String,
    /** base64 crypto_box_seal(HMK → holder pubkey) — 80 B. */
    val sealedKey: String,
)

/** Body of POST /homes/:homeId/key (idempotent per holder). */
@Serializable
data class SubmitSealedKeysRequest(
    val epoch: Int,
    val keys: List<SealedKeyUpload>,
)

/** Body of POST /homes/:homeId/key/init — explicit owner activation (epoch 0→1). */
@Serializable
data class InitHomeKeyRequest(
    val keys: List<SealedKeyUpload>,
)

/** Body of POST /homes/:homeId/key/rotate. fromEpoch guards concurrency (409 stale). */
@Serializable
data class RotateHomeKeyRequest(
    val fromEpoch: Int,
    val keys: List<SealedKeyUpload>,
)

/** Response to key/init and key/rotate. */
@Serializable
data class HomeKeyEpochResponse(
    val keyEpoch: Int,
)

/** Body of POST /homes/:homeId/recorder-consent (owner only). */
@Serializable
data class RecorderConsentRequest(
    val enabled: Boolean,
    /** base64 sealed box — required when enabled. */
    val sealedKey: String? = null,
)

@Serializable
data class RecorderConsentResponse(
    val recorderConsented: Boolean,
    val keyEpoch: Int,
)

/** Response to GET /e2ee/recorder-identity. publicKey null ⇒ no recorder registered. */
@Serializable
data class RecorderIdentityResponse(
    val publicKey: String? = null,
)

/** Body of POST /cameras/:cameraId/pubkey — existing-camera migration. */
@Serializable
data class CameraKeyRegistration(
    val deviceSecret: String,
    /** base64 X25519 public key (32 B). */
    val publicKey: String,
)
