/**
 * Foresight Security — E2EE contract (canonical).
 *
 * THE SOURCE OF TRUTH for every cryptographic constant and key-management wire
 * type. Mirrored (hand-kept in sync) in:
 *   - shared/swift/ForesightProtocol.swift            (canonical Swift mirror)
 *   - Foresight Security Camera Client/Sources/Protocol/ForesightProtocol.swift
 *   - Foresight/Foresight/Models/ForesightProtocol.swift
 *
 * ── The locked LiveKit key-application contract (shared/E2EE.md §3.2) ──
 * A divergence on ANY of these values produces SILENT decryption failure
 * (black video, no error). Do not change any of them without changing every
 * platform in the same release and re-running the M0 parity vector.
 *
 *  1. Key application: `setKey(base64(HMK))` as a STRING (LiveKit's PBKDF2
 *     path). Byte-API platforms (@livekit/rtc-node) feed utf8Bytes(base64(HMK)),
 *     NEVER the raw 32 bytes.
 *  2. keySize = 128 — the only value supported by non-web SDKs.
 *  3. encryptionType = AES-GCM.
 *  4. sharedKey = true — one HMK decrypts every camera in a Home.
 *  5. ratchetSalt = "LKFrameEncryptionKey" (LiveKit default, UTF-8).
 *  6. ratchetWindowSize = 0 — no automatic ratcheting; we rotate by re-sealing
 *     a fresh HMK (web's ExternalE2EEKeyProvider hardcodes this; Swift and
 *     rtc-node MUST set it explicitly).
 *  7. keyIndex = 0 — EVERY platform, EVERY rotation (web's setKey physically
 *     cannot target another index). `Home.keyEpoch` / `SealedKey.epoch` are
 *     server-side bookkeeping counters and are NEVER fed to LiveKit in v1.
 *
 * The server performs NO crypto with any of this: it stores/serves opaque
 * base64 blobs only. Sealing/unsealing/KDF happen exclusively on clients
 * (libsodium: libsodium-wrappers-sumo / swift-sodium / sodium-native).
 *
 * ── What E2EE does and does NOT protect against (read before relying on it) ──
 * PROTECTS: media (video/audio frames) against the SFU operator (e.g. LiveKit
 * Cloud) and anyone who obtains only the sealed-key blobs or the database's
 * HomeKey table.
 * DOES NOT PROTECT against a compromised or malicious Foresight server, nor
 * against someone who can read the login traffic:
 *   - the vault key is Argon2id(LOGIN PASSWORD), and the login password is sent
 *     to the server at every login (in cleartext on a plain-HTTP LAN setup), so
 *     whoever sees it can unwrap that user's vault;
 *   - the server is the key directory: a malicious server can hand out its own
 *     public key for a member/camera that a client has not pinned yet (TOFU
 *     pins only catch a CHANGED key on a device that already pinned it);
 *   - a database dump enables offline guessing of weak passwords against both
 *     the login hash and the vault.
 * Use TLS for the API, strong passwords, and compare key fingerprints out of
 * band when it matters. See shared/E2EE.md for the full model.
 */

/** AES key size in bits fed to LiveKit key providers. 128 is the only value all SDKs support. */
export const E2EE_KEY_SIZE = 128;
/** LiveKit frame-encryption algorithm. Must match the publisher (camera). */
export const E2EE_ENCRYPTION_TYPE = "gcm";
/** LiveKit key-derivation ratchet salt (SDK default — keep on ALL platforms). */
export const E2EE_RATCHET_SALT = "LKFrameEncryptionKey";
/** No automatic ratcheting in v1; rotation = re-seal a fresh HMK + re-setKey. */
export const E2EE_RATCHET_WINDOW_SIZE = 0;
/**
 * The LiveKit key index every platform applies the HMK at — LOCKED to 0 in v1,
 * on every platform, on every rotation (web cannot target any other index).
 */
export const E2EE_KEY_INDEX = 0;
/**
 * Capacity of a LiveKit key provider's key ring. Web hardcodes the same value
 * (livekit-client KEYRING_SIZE = 16); the recorder must pass it explicitly —
 * rtc-node's pinned FFI proto marks key_ring_size `required` at connect. Key
 * INDICES stay locked to E2EE_KEY_INDEX = 0 in v1; the `epoch % 16` index
 * ring is reserved for the v2 seamless-rotation design.
 */
export const E2EE_KEY_RING_SIZE = 16;
/**
 * PBKDF2 iteration count LiveKit uses to derive the AES key from the base64
 * string passphrase (verified in the installed livekit-client@2.19.2 worker:
 * PBKDF2-SHA-256, salt = utf8(E2EE_RATCHET_SALT)). Informational — used by
 * startup self-tests and the M0 parity vector, never configured anywhere.
 */
export const E2EE_PBKDF2_ITERATIONS = 100000;

/** Argon2id opslimit for the password→vault-key KDF (stored per-blob in KdfParams). */
export const E2EE_ARGON2ID_OPSLIMIT = 3;
/** Argon2id memlimit in bytes (64 MiB), stored per-blob in KdfParams. */
export const E2EE_ARGON2ID_MEMLIMIT = 67108864;
/** X25519 public/private key length (crypto_box_keypair). */
export const E2EE_X25519_KEY_BYTES = 32;
/** Home Media Key length (randombytes_buf). */
export const E2EE_HMK_BYTES = 32;
/** crypto_box_seal(HMK): 32 + 48 (SEALBYTES) = 80 bytes. */
export const E2EE_SEALED_HMK_BYTES = 80;
/** crypto_secretbox_easy(sk): 32 + 16 (MAC) = 48 bytes. */
export const E2EE_WRAPPED_PRIVATE_KEY_BYTES = 48;
/** crypto_secretbox nonce length. */
export const E2EE_SECRETBOX_NONCE_BYTES = 24;
/** Argon2id salt length (crypto_pwhash_SALTBYTES). */
export const E2EE_KDF_SALT_BYTES = 16;

/** Who a sealed copy of a Home Media Key belongs to. */
export type KeyHolderType = "user" | "camera" | "recorder";

/**
 * Argon2id parameters stored alongside each wrapped vault so they can be
 * retuned later without bricking old vaults. `algo` is always "argon2id"
 * (libsodium ALG_ARGON2ID13).
 */
export interface KdfParams {
  algo: "argon2id";
  opslimit: number;
  memlimit: number;
  /** base64, E2EE_KDF_SALT_BYTES bytes. */
  saltB64: string;
}

/**
 * A user's identity keypair at rest: X25519 public key in the clear, private
 * key wrapped under Argon2id(login password) via crypto_secretbox_easy. The
 * server stores this blob verbatim and does no crypto with it — but because it
 * also receives the login password at sign-in, it is NOT a party the vault is
 * hidden from (see the threat-model note at the top of this file).
 */
export interface EncryptedKeyVault {
  /** base64 X25519 public key (32 B). */
  publicKey: string;
  /** base64 crypto_secretbox_easy(privateKey) — E2EE_WRAPPED_PRIVATE_KEY_BYTES (48 B). */
  wrappedPrivateKey: string;
  /** base64 secretbox nonce (24 B). */
  nonce: string;
  kdf: KdfParams;
}

/**
 * A sealed copy of a Home Media Key for one holder.
 * `epoch` is `Home.keyEpoch` — a server-side delivery/consistency counter.
 * It is NEVER a LiveKit key index (that is locked to E2EE_KEY_INDEX = 0 in v1).
 */
export interface SealedKey {
  /** base64 crypto_box_seal(HMK → holder pubkey) — E2EE_SEALED_HMK_BYTES (80 B). */
  ciphertext: string;
  epoch: number;
}

/* Route map (all session-authed unless noted):
 *   POST /me/keys                     body: SetKeyVaultRequest       → 204 (409 vault_exists when replacing a DIFFERENT existing vault without a correct currentPassword)
 *   GET  /me/keys                     → MeKeysResponse
 *   GET  /homes/:homeId/key           → HomeKeyResponse   (caller's own sealed copy)
 *   GET  /homes/:homeId/key/pending   → PendingKeyHoldersResponse
 *   GET  /homes/:homeId/key/holders   → PendingKeyHoldersResponse (owner; EVERY holder the next epoch must be sealed to — members/cameras with pubkeys + the recorder while consented)
 *   POST /homes/:homeId/key           body: SubmitSealedKeysRequest  → 204 (idempotent; §10.5 authority — first-contact user/recorder seals are owner-only, 403 otherwise)
 *   DELETE /homes/:homeId/key/:holderType/:holderId → 204 (owner; drops the holder's CURRENT-epoch sealed copy so it returns to pending — repair path for a poisoned/undecryptable copy)
 *   POST /homes/:homeId/key/init      body: InitHomeKeyRequest       → HomeKeyEpochResponse (owner; 409 until every camera has a pubkey)
 *   POST /homes/:homeId/key/rotate    body: RotateHomeKeyRequest     → HomeKeyEpochResponse (owner; 409 stale_epoch on stale fromEpoch; 409 recorder_key_required when consent is in force but the recorder's copy is missing; the server broadcasts `rekey`)
 *   POST /homes/:homeId/key/disable   → HomeKeyEpochResponse (owner; turns E2EE off — keyEpoch → 0, every sealed copy dropped, `rekey` epoch 0 broadcast; 409 when not activated)
 *   POST /homes/:homeId/recorder-consent body: RecorderConsentRequest → RecorderConsentResponse (owner)
 *   GET  /e2ee/recorder-identity      → RecorderIdentityResponse
 *   POST /cameras/:cameraId/pubkey    body: CameraKeyRegistration    → 204 (deviceSecret-authed)
 * Internal (x-recorder-secret header):
 *   POST /internal/recorder-identity  body: RegisterRecorderIdentityRequest → 204
 *   GET  /internal/recording-cameras  → RecorderReconcileResponse (extended)
 */

/**
 * Body of POST /me/keys. Creating the first vault needs only the session.
 * REPLACING an existing, different vault also requires the account password
 * (`currentPassword`) so a stolen session token alone cannot swap in an
 * attacker's public key. Re-posting the identical vault is an idempotent 204.
 */
export interface SetKeyVaultRequest extends EncryptedKeyVault {
  currentPassword?: string;
}

/** Response to GET /me/keys. `keyVault: null` ⇒ run first-login key generation. */
export interface MeKeysResponse {
  keyVault: EncryptedKeyVault | null;
}

/**
 * Response to GET /homes/:homeId/key — the caller's own sealed HMK copy at the
 * Home's current epoch. `epoch: 0` ⇒ E2EE not activated for this Home.
 * `sealedKey: null` with `epoch ≥ 1` ⇒ activated but nobody has sealed to the
 * caller yet ("waiting for access").
 */
export interface HomeKeyResponse {
  epoch: number;
  /** base64 sealed box (80 B) or null. */
  sealedKey: string | null;
}

/** One holder that lacks a sealed HMK copy at the Home's current epoch. */
export interface PendingKeyHolder {
  holderType: KeyHolderType;
  /** userId / cameraId / RecorderIdentity id. */
  holderId: string;
  /** base64 X25519 public key to seal to. */
  publicKey: string;
  /** Human-readable label for grant UIs (member identifier / camera name / "recorder"). */
  label: string;
  /**
   * True when this holder has NEVER held a sealed key for this Home at any
   * epoch (first-contact grant — §10.5 owner-only authority rule applies).
   * False for epoch backfill of an existing holder (any current holder may seal).
   */
  firstContact: boolean;
}

/**
 * Response to GET /homes/:homeId/key/pending. At `epoch 0` (not activated)
 * `pending` is the ACTIVATION candidate list — every member/camera with a
 * registered pubkey, all `firstContact` — consumed by the owner's activation
 * precheck and as the key/init seal targets.
 */
export interface PendingKeyHoldersResponse {
  epoch: number;
  pending: PendingKeyHolder[];
}

/** One sealed HMK copy being uploaded for a holder. */
export interface SealedKeyUpload {
  holderType: KeyHolderType;
  holderId: string;
  /** base64 crypto_box_seal(HMK → holder pubkey) — 80 B. */
  sealedKey: string;
}

/**
 * Body of POST /homes/:homeId/key — upload sealed copies for pending holders
 * at `epoch` (must equal the Home's current epoch; idempotent per holder —
 * an existing row is never overwritten). The server enforces the §10.5
 * authority rule: a non-owner sealing a FIRST-CONTACT user or recorder holder
 * is refused (403 first_contact_owner_only); first-contact camera seals and
 * epoch backfill of previous holders stay open to any member.
 */
export interface SubmitSealedKeysRequest {
  epoch: number;
  keys: SealedKeyUpload[];
}

/**
 * Body of POST /homes/:homeId/key/init — explicit owner activation (epoch 0 →
 * 1, or one past the last epoch used if E2EE was turned off before: epochs
 * never repeat, so an HMK cached under an old epoch can't match a new one).
 * `keys` must include the owner's own user copy; the server refuses (409)
 * unless every camera in the Home has a registered pubkey.
 */
export interface InitHomeKeyRequest {
  keys: SealedKeyUpload[];
}

/**
 * Body of POST /homes/:homeId/key/rotate — generate-and-seal a fresh HMK for
 * every remaining holder. `fromEpoch` is an optimistic-concurrency guard
 * (409 when it no longer matches the Home's current epoch).
 */
export interface RotateHomeKeyRequest {
  fromEpoch: number;
  keys: SealedKeyUpload[];
}

/** Response to key/init, key/rotate and key/disable (0 after a disable). */
export interface HomeKeyEpochResponse {
  keyEpoch: number;
}

/**
 * Body of POST /homes/:homeId/recorder-consent (owner only).
 * enable: `sealedKey` (HMK sealed to the recorder pubkey) is required.
 * disable: server deletes the recorder's HomeKey rows, disarms recording in
 * the Home, and the owner client MUST follow up with a rotate.
 */
export interface RecorderConsentRequest {
  enabled: boolean;
  /** base64 sealed box — required when enabled. */
  sealedKey?: string;
}

/** Response to the recorder-consent toggle. */
export interface RecorderConsentResponse {
  recorderConsented: boolean;
  keyEpoch: number;
}

/** Response to GET /e2ee/recorder-identity. `publicKey: null` ⇒ no recorder registered. */
export interface RecorderIdentityResponse {
  /** base64 X25519 public key of the global recorder, or null. */
  publicKey: string | null;
}

/**
 * Body of POST /cameras/:cameraId/pubkey — existing-camera migration.
 * Device-secret-authed exactly like the camera status sink; a camera paired
 * before E2EE registers its keypair here on first post-update boot.
 */
export interface CameraKeyRegistration {
  deviceSecret: string;
  /** base64 X25519 public key (32 B). */
  publicKey: string;
}

/** Body of POST /internal/recorder-identity — recorder registers/refreshes its pubkey on boot. */
export interface RegisterRecorderIdentityRequest {
  /** base64 X25519 public key (32 B). */
  publicKey: string;
}

/** Per-Home key state carried on the recorder reconcile response. */
export interface RecorderHomeKeyInfo {
  homeId: string;
  /** Home.keyEpoch; 0 = E2EE not activated (record plaintext exactly as today). */
  epoch: number;
  /** base64 HMK sealed to the recorder's pubkey at `epoch`, or null (no consent → awaiting_consent). */
  sealedHmk: string | null;
  /**
   * True ONLY when the owner explicitly revoked recorder consent (stop +
   * finalize, don't just wait). "Never consented" and "consented, but the
   * post-rotation copy is not sealed yet" both report `revoked: false` with
   * `sealedHmk: null` (awaiting_consent).
   */
  revoked: boolean;
}

/**
 * Extended response of GET /internal/recording-cameras. `homeKeys` covers at
 * minimum every homeId present in `cameras`, plus revoked entries for Homes
 * that lost recorder consent.
 */
export interface RecorderReconcileResponse {
  cameras: Array<{ cameraId: string; homeId: string }>;
  homeKeys: RecorderHomeKeyInfo[];
}
