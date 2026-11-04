/*
 * Foresight Security — REST API contract (Kotlin mirror).
 *
 * Hand-kept in sync with shared/ts/src/rest.ts (canonical). JSON field names
 * MUST match the TypeScript contract exactly; kotlinx.serialization is
 * configured for unknown-key tolerance and omitted nulls in ForesightJson.
 *
 * Optional fields added after v1 (keyEpoch, recorderConsented, sealedHomeKey,
 * homeKeyPending, keyVault…) are nullable with defaults so a pre-E2EE server's
 * responses still decode — same leniency as the Swift viewer mirror.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Shared Json configuration for everything that speaks the contract. */
val ForesightJson: Json = Json {
    ignoreUnknownKeys = true   // unknown keys from newer servers are tolerated
    explicitNulls = false      // absent optionals decode as null; nulls are omitted on encode
    encodeDefaults = true      // data messages must carry their v/type defaults
}

// MARK: - Enums

@Serializable
enum class MemberRole {
    @SerialName("owner") OWNER,
    @SerialName("member") MEMBER;

    val wireName: String get() = if (this == OWNER) "owner" else "member"
}

@Serializable
enum class ParticipantRole {
    @SerialName("camera") CAMERA,
    @SerialName("viewer") VIEWER,
}

/**
 * Stream quality presets. `P1080` is a high-bitrate 1080p simulcast; `MAX` is
 * true 4K published as a SINGLE non-simulcast layer for solo/fullscreen viewing
 * on a 4K-capable camera (falling back to `P1080` if 4K fails to start, or if
 * the camera has no 4K sensor). `PURE4K` is the legacy wire value for the same
 * single-layer 4K as `MAX`; cameras still accept it, viewers no longer send it.
 */
@Serializable
enum class QualityPreset {
    @SerialName("auto") AUTO,
    @SerialName("480p") P480,
    @SerialName("1080p") P1080,
    @SerialName("max") MAX,
    @SerialName("pure4k") PURE4K,
}

@Serializable
enum class ThermalState {
    @SerialName("nominal") NOMINAL,
    @SerialName("fair") FAIR,
    @SerialName("serious") SERIOUS,
    @SerialName("critical") CRITICAL,
}

// MARK: - Shared value types

@Serializable
data class WifiInfo(
    /** Signal strength bucketed to 0–4 bars. */
    val level: Int,
    val rssi: Int? = null,
    val ssid: String? = null,
)

@Serializable
data class CameraCapabilities(
    /** Available optical zoom factors, e.g. [0.5, 1, 2] or [1]. */
    val lenses: List<Double>,
    /** Maximum digital zoom factor beyond the longest lens, e.g. 6. */
    val maxDigitalZoom: Double,
    val torch: Boolean,
    val maxResolution: Resolution,
    val supportsAudio: Boolean,
) {
    @Serializable
    data class Resolution(val width: Int, val height: Int)
}

// MARK: - Auth

@Serializable
data class RegisterRequest(
    /** Email OR username — a single field, the user's choice. */
    val identifier: String,
    /** No complexity requirements (product decision). */
    val password: String,
    val firstName: String? = null,
)

@Serializable
data class LoginRequest(
    val identifier: String,
    val password: String,
)

@Serializable
data class UserDTO(
    val id: String,
    val identifier: String,
    val firstName: String? = null,
    val createdAt: String,
)

@Serializable
data class AuthResponse(
    /** Bearer session token for subsequent authenticated requests. */
    val token: String,
    val user: UserDTO,
    /**
     * The user's encrypted E2EE key vault, or null when the account has no keys
     * yet — the client then runs first-login key generation → POST /me/keys.
     */
    val keyVault: EncryptedKeyVault? = null,
)

/** Body for PATCH /me. Send "" or null to clear the first name. */
@Serializable
data class UpdateProfileRequest(val firstName: String?)

// MARK: - Homes

@Serializable
data class CreateHomeRequest(val name: String)

@Serializable
data class HomeDTO(
    val id: String,
    val name: String,
    /** The requesting user's role in this Home. */
    val role: MemberRole,
    val createdAt: String,
    /**
     * Current Home Media Key epoch; 0 (or null from a pre-E2EE server) ⇒ E2EE
     * not activated — the Home runs plaintext exactly as before. Server-side
     * bookkeeping only, NEVER a LiveKit key index (locked to 0).
     */
    val keyEpoch: Int? = null,
    /** True when the recorder holds a sealed HMK at the current epoch. */
    val recorderConsented: Boolean? = null,
)

@Serializable
data class AddMemberRequest(
    val identifier: String,
    val role: MemberRole? = null,
)

/** A single member of a Home (GET /homes/:homeId/members). */
@Serializable
data class HomeMemberDTO(
    val userId: String,
    val identifier: String,
    val role: MemberRole,
    /** base64 X25519 public key, or null when the member has no key vault yet. */
    val publicKey: String? = null,
)

// MARK: - Cameras

@Serializable
data class CameraStatus(
    val battery: Double? = null,
    val charging: Boolean? = null,
    val wifi: WifiInfo? = null,
    val thermal: ThermalState? = null,
    val lastSeen: String? = null,
)

@Serializable
data class CameraDTO(
    val id: String,
    val homeId: String,
    val name: String,
    val online: Boolean,
    val status: CameraStatus = CameraStatus(),
    val capabilities: CameraCapabilities? = null,
    val createdAt: String,
)

@Serializable
data class RenameCameraRequest(val name: String)

// MARK: - Pairing

/**
 * Payload encoded into the QR code shown when adding a camera. The camera
 * client scans it and calls POST /pair/claim.
 */
@Serializable
data class PairingTicket(
    /** Backend base URL, e.g. http://192.168.1.20:3199 */
    val serverUrl: String,
    /** LiveKit ws URL, e.g. ws://192.168.1.20:7880 */
    val livekitUrl: String,
    /** One-time pairing token. */
    val token: String,
    val homeId: String,
    val expiresAt: String,
)

@Serializable
data class ClaimPairingRequest(
    val token: String,
    val name: String,
    val capabilities: CameraCapabilities,
    /** base64 X25519 public key generated on-device at pairing (E2EE identity). */
    val cameraPublicKey: String,
)

@Serializable
data class ClaimPairingResponse(
    val camera: CameraDTO,
    val deviceSecret: String,
    /**
     * True when the Home has E2EE activated and the camera must wait for a
     * member to seal the Home Media Key to it. Null from a pre-E2EE server.
     */
    val homeKeyPending: Boolean? = null,
)

// MARK: - Realtime (LiveKit) token

@Serializable
data class RtTokenRequest(
    val homeId: String,
    val role: ParticipantRole,
    /** Required when role == CAMERA; viewers authenticate via session bearer. */
    val deviceSecret: String? = null,
)

@Serializable
data class RtTokenResponse(
    val livekitUrl: String,
    /** LiveKit access token (JWT). */
    val token: String,
    /** Room name, e.g. "home:abc123". */
    val room: String,
    /** The participant identity embedded in the token. */
    val identity: String,
    /**
     * The Home's current key epoch. 0 / null ⇒ E2EE not activated: connect
     * plaintext exactly as today. ≥ 1 ⇒ the room is E2EE; a null sealedHomeKey
     * then means "awaiting key" — NEVER connect plaintext into an activated Home.
     */
    val keyEpoch: Int? = null,
    /** The caller's own sealed HMK copy (rides the token — zero extra round-trips). */
    val sealedHomeKey: SealedKey? = null,
)

@Serializable
data class ParticipantMetadata(
    val role: ParticipantRole,
    val userId: String? = null,
    val cameraId: String? = null,
    val displayName: String? = null,
)

/** Standard error body returned by the backend on 4xx/5xx. */
@Serializable
data class ApiErrorBody(
    val error: String,
    val message: String,
)
