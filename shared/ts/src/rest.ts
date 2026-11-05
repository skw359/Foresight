/**
 * Foresight Security — REST API contract.
 *
 * Shared by the Node backend (foresight-server) and the web dashboard
 * (Foresight-web-client). The Swift apps mirror these shapes in
 * shared/swift/ForesightProtocol.swift — keep the two in sync.
 *
 * All timestamps are ISO-8601 strings (UTC).
 */

import type { EncryptedKeyVault, SealedKey } from "./e2ee.js";

export type MemberRole = "owner" | "member";

/** Role a participant plays inside a LiveKit room. */
export type ParticipantRole = "camera" | "viewer";

/**
 * Stream quality presets exposed in the viewer UIs.
 *
 * `1080p` is a high-bitrate 1080p simulcast (reliable everywhere, keeps the
 * grid/low layer). `max` is true 4K published as a SINGLE non-simulcast layer —
 * for solo/fullscreen viewing — on cameras with a 4K-capable sensor; the camera
 * falls back to `1080p` if 4K fails to start, and serves the 1080p ladder for
 * `max` when it has no 4K sensor at all.
 *
 * `pure4k` is the legacy wire value for the same single-layer 4K that `max` now
 * selects. Cameras still accept it; the viewer UIs no longer offer it.
 */
export type QualityPreset = "auto" | "480p" | "1080p" | "max" | "pure4k";

/** iOS thermal state, surfaced as a health warning. */
export type ThermalState = "nominal" | "fair" | "serious" | "critical";

/** Wi-Fi signal info reported by a camera device. */
export interface WifiInfo {
  /** Signal strength bucketed to 0–4 bars. */
  level: number;
  /** Raw RSSI in dBm if available. */
  rssi?: number;
  /** Network name if the device exposes it. */
  ssid?: string;
}

/**
 * Hardware capabilities a camera reports at pairing time and on join.
 * Drives which controls the viewer UIs show (e.g. hide flashlight when torch
 * is unavailable, only offer lenses the device actually has). Never hardcoded.
 */
export interface CameraCapabilities {
  /** Available optical zoom factors, e.g. [0.5, 1, 2] or [1]. */
  lenses: number[];
  /** Maximum digital zoom factor beyond the longest lens, e.g. 6. */
  maxDigitalZoom: number;
  /** Whether the active camera supports torch/flashlight (usually rear only). */
  torch: boolean;
  maxResolution: { width: number; height: number };
  supportsAudio: boolean;
}

export interface RegisterRequest {
  /** Email OR username — a single field, the user's choice. */
  identifier: string;
  /** No complexity requirements; stored hashed. */
  password: string;
  /** Optional display first name, shown in greetings. Editable later in Settings. */
  firstName?: string;
}

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface UserDTO {
  id: string;
  identifier: string;
  /** Optional display first name; absent/empty for accounts that never set one. */
  firstName?: string | null;
  createdAt: string;
  /**
   * True for the server administrator — the first account created on the
   * server (or one promoted by an admin). Only admins may change server-wide
   * settings such as the pairing URL and whether new accounts may register.
   * Optional so older servers that predate the flag still decode.
   */
  isAdmin?: boolean;
}

export interface AuthResponse {
  /** Bearer session token for subsequent authenticated requests. */
  token: string;
  user: UserDTO;
  /**
   * The user's encrypted E2EE key vault (opaque to the server), or null when
   * the account has no keys yet — the client then runs first-login key
   * generation and POSTs the vault to /me/keys.
   */
  keyVault: EncryptedKeyVault | null;
}

/**
 * Body for POST /me/password — change the caller's login password. The E2EE
 * vault is wrapped under the login password, so the client re-wraps its
 * private key under the new password and sends the new vault in the same
 * request; the server swaps both atomically. Every existing session token is
 * revoked; the response carries a fresh one.
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  /** The vault re-wrapped under `newPassword`. Required when the account has a vault. */
  keyVault?: EncryptedKeyVault;
}

/** Response to POST /me/password and POST /auth/logout-all. */
export interface SessionResponse {
  /** A fresh session token (all older tokens are now rejected). */
  token: string;
}

/**
 * Body for PATCH /me — update the caller's own profile. Currently just the
 * display first name; send "" or null to clear it.
 */
export interface UpdateProfileRequest {
  firstName: string | null;
}

export interface CreateHomeRequest {
  name: string;
}

export interface HomeDTO {
  id: string;
  name: string;
  /** The requesting user's role in this Home. */
  role: MemberRole;
  createdAt: string;
  /**
   * Current Home Media Key epoch. 0 ⇒ E2EE has not been activated for this
   * Home (it runs plaintext exactly as before E2EE existed). Server-side
   * bookkeeping only — NEVER a LiveKit key index (that is locked to 0).
   */
  keyEpoch: number;
  /** True when the recorder holds a sealed HMK copy at the current epoch. Computed, never stored. */
  recorderConsented: boolean;
  /**
   * True when a key holder lost access (member removed, camera deleted,
   * account deleted) while E2EE was active, so the Home Media Key must be
   * rotated before that holder's old copy stops decrypting new media. The
   * owner's client rotates as soon as it can; the flag clears on rotate or
   * disable. Optional for compatibility with servers that predate it.
   */
  keyRotationRequired?: boolean;
}

export interface AddMemberRequest {
  /** identifier of an existing user to add to the Home. */
  identifier: string;
  /**
   * Role for a NEW member (default "member"). For someone who is already a
   * member it is applied only when given explicitly, and a change that would
   * leave the Home without an owner is refused (409 last_owner).
   */
  role?: MemberRole;
}

/** Body for PATCH /homes/:homeId/members/:userId (owner only). */
export interface UpdateMemberRequest {
  role: MemberRole;
}

/** A single member of a Home (returned by GET /homes/:homeId/members). */
export interface HomeMemberDTO {
  userId: string;
  identifier: string;
  role: MemberRole;
  /** base64 X25519 public key, or null when the member has no key vault yet. */
  publicKey: string | null;
}

/**
 * Hand ownership of a Home to another existing member (owner only). The named
 * member is promoted to "owner"; unless `keepOwnership` is true the caller is
 * demoted to "member". Used to clear the block on account deletion when the
 * caller is the sole owner of a Home that still has other members.
 */
export interface TransferOwnershipRequest {
  /** userId of an existing member of this Home to promote to owner. */
  userId: string;
  /** Keep the caller as a co-owner instead of demoting them. Defaults to false. */
  keepOwnership?: boolean;
}

/**
 * Result of DELETE /me when it cannot proceed because the caller is the sole
 * owner of one or more Homes that still have other members. The account is left
 * untouched; the user must transfer ownership (or remove those members) first.
 * Carried as the `details` of a 409 ApiError so the UI can list the Homes.
 */
export interface BlockingHomeRef {
  id: string;
  name: string;
}

export interface AccountDeletionBlocked {
  blockingHomes: BlockingHomeRef[];
}

/** Latest known health snapshot for a camera (derived from telemetry). */
export interface CameraStatus {
  /** Battery level 0–1. */
  battery: number | null;
  charging: boolean | null;
  wifi: WifiInfo | null;
  thermal: ThermalState | null;
  /** ISO timestamp of the last telemetry/heartbeat. */
  lastSeen: string | null;
}

export interface CameraDTO {
  id: string;
  homeId: string;
  name: string;
  online: boolean;
  /** Whether 24/7 server-side recording is enabled for this camera. */
  recordingEnabled: boolean;
  status: CameraStatus;
  capabilities: CameraCapabilities | null;
  createdAt: string;
}

export interface RenameCameraRequest {
  name: string;
}

/** Body for POST /cameras/:cameraId/recording — the "record 24/7" toggle. */
export interface SetRecordingRequest {
  enabled: boolean;
}

/** Response to the recording toggle: the persisted flag + whether it armed. */
export interface SetRecordingResponse {
  cameraId: string;
  recordingEnabled: boolean;
  /** True if the camera was online and the recorder was asked to start now. */
  armed: boolean;
}

/** One contiguous span of recorded footage available on disk for a camera. */
export interface RecordingSpan {
  /** ISO-8601 start of the span (inclusive). */
  start: string;
  /** ISO-8601 end of the span (exclusive). */
  end: string;
  /** Number of segments in the span. */
  segments: number;
  /** Total bytes on disk for the span. */
  bytes: number;
}

/**
 * DELETE /cameras/:cameraId/recordings?from&to — removes every stored segment
 * whose start falls in the half-open window [from, to) (the segments backing one
 * coverage span). Returns what was actually deleted; deletion is permanent.
 */
export interface DeleteRecordingsResponse {
  cameraId: string;
  /** Number of segment files removed from disk. */
  deletedSegments: number;
  /** Total bytes freed. */
  deletedBytes: number;
}

/**
 * GET /cameras/:cameraId/recordings — coverage summary derived from the
 * on-disk segment files (segments are the source of truth, not a DB catalog).
 */
export interface RecordingCoverage {
  cameraId: string;
  /** The persisted Camera.recordingEnabled flag. */
  recordingEnabled: boolean;
  /** Contiguous coverage spans, oldest first. */
  spans: RecordingSpan[];
  /** Earliest available footage (ISO-8601) or null when nothing is stored. */
  earliest: string | null;
  /** Latest available footage (ISO-8601) or null. */
  latest: string | null;
  /** Total bytes across every stored segment. */
  totalBytes: number;
}

/**
 * Payload encoded into the QR code shown by a viewer (web/iOS) when adding a
 * camera. The camera client scans it and calls POST /pair/claim.
 */
export interface PairingTicket {
  /** Backend base URL, e.g. http://192.168.1.20:3199 */
  serverUrl: string;
  /** LiveKit ws URL, e.g. ws://192.168.1.20:7880 */
  livekitUrl: string;
  /** One-time pairing token. */
  token: string;
  homeId: string;
  expiresAt: string;
}

export interface ClaimPairingRequest {
  token: string;
  /** Camera name chosen on the device, e.g. "Front Door". */
  name: string;
  capabilities: CameraCapabilities;
  /** base64 X25519 public key generated on-device at pairing (E2EE identity). */
  cameraPublicKey: string;
}

export interface ClaimPairingResponse {
  camera: CameraDTO;
  /** Long-lived secret the camera stores and uses to mint realtime tokens. */
  deviceSecret: string;
  /**
   * True when the camera's Home has E2EE activated and the camera must wait
   * for a member to seal the Home Media Key to it before it can publish
   * (it arrives via RtTokenResponse.sealedHomeKey).
   */
  homeKeyPending: boolean;
}

export interface RtTokenRequest {
  homeId: string;
  role: ParticipantRole;
  /** Required when role === "camera"; viewers authenticate via session bearer. */
  deviceSecret?: string;
}

export interface RtTokenResponse {
  livekitUrl: string;
  /** LiveKit access token (JWT). */
  token: string;
  /** Room name, e.g. "home:abc123". */
  room: string;
  /** The participant identity embedded in the token. */
  identity: string;
  /**
   * The Home's current key epoch. 0 ⇒ E2EE not activated: connect/publish
   * plaintext exactly as today. ≥ 1 ⇒ the room is E2EE; a null sealedHomeKey
   * then means "awaiting key" — NEVER publish plaintext into an activated Home.
   */
  keyEpoch: number;
  /**
   * The caller's own sealed copy of the Home Media Key (every role — viewer
   * and camera — gets it with the token: zero extra round-trips on the join
   * path). Null when not activated or not yet sealed to this holder.
   */
  sealedHomeKey: SealedKey | null;
}

/**
 * Server-wide settings. Readable by any signed-in user; only the server admin
 * (see UserDTO.isAdmin) may change them.
 */
export interface ServerSettings {
  /**
   * Base URL embedded into QR pairing tickets, e.g. http://192.168.1.20:3199.
   * `null` means no override is set — the server auto-detects the address the
   * dashboard used to reach it. Must be reachable by the phones being paired
   * ("localhost" only works on the server machine itself).
   */
  pairingServerUrl: string | null;
  /**
   * The URL the server derived from the current request's host. The dashboard
   * shows this as the effective value / placeholder when `pairingServerUrl` is
   * null.
   */
  detectedServerUrl: string;
  /** Whether new accounts may currently register (POST /auth/register). */
  registrationOpen?: boolean;
  /**
   * True when ALLOW_REGISTRATION in the server environment pins
   * `registrationOpen`, so the dashboard toggle is read-only.
   */
  registrationLocked?: boolean;
  /** True when the caller may change these settings (server admin). */
  editable?: boolean;
}

/** Body for PUT /settings (server admin only). Omitted fields are left unchanged. */
export interface UpdateServerSettingsRequest {
  /** New override URL, or null/"" to clear it and fall back to auto-detect. */
  pairingServerUrl?: string | null;
  /** Allow or refuse new account registrations (ignored when pinned by env). */
  registrationOpen?: boolean;
}

/** Who performed an audited action. */
export type AuditActorType = "user" | "camera" | "system";

/**
 * One entry of a Home's audit trail (GET /homes/:homeId/audit, owner only).
 * Destructive and security-relevant actions are recorded: camera pairing and
 * removal, recording toggles, footage deletion, membership and ownership
 * changes, and E2EE key operations.
 */
export interface AuditEventDTO {
  id: string;
  homeId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  /** Human-readable actor label (the identifier or camera name) when known. */
  actorLabel: string | null;
  /** Dotted action name, e.g. "camera.deleted", "recordings.deleted". */
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
  createdAt: string;
}

export interface AuditLogResponse {
  events: AuditEventDTO[];
  /** Pass as `?before=` to fetch the next (older) page; null when exhausted. */
  nextBefore: string | null;
}

/** The recorder's live state for one camera (see foresight-recorder /status). */
export type RecorderCameraState =
  | "idle"
  | "awaiting_track"
  | "recording"
  | "reacquiring"
  | "stalled"
  | "awaiting_consent"
  | "revoked"
  | "encoder_failing"
  | "stopped";

export interface CameraRecordingHealth {
  cameraId: string;
  /** null when the recorder has no session for this camera (not armed). */
  state: RecorderCameraState | null;
  /** Epoch ms when the encoder last finished a segment, or null if unknown. */
  lastSegmentAt: number | null;
  droppedFrames: number;
}

/** GET /homes/:homeId/recording-health. */
export interface RecordingHealthResponse {
  /** False when the recorder could not be reached (states are then unknown). */
  recorderReachable: boolean;
  cameras: CameraRecordingHealth[];
}

/** POST /recordings/:cameraId/clip-url?from&to → a short-lived download URL. */
export interface ClipUrlResponse {
  /**
   * Path (relative to the API base) of a signed, short-lived clip.mp4 URL that
   * needs no Authorization header, so the browser can stream it straight to
   * disk with a plain download link instead of buffering it in memory.
   */
  url: string;
  expiresAt: string;
}

/** Body for POST /cameras/:cameraId/unpair — device-authenticated self-removal. */
export interface UnpairCameraRequest {
  deviceSecret: string;
}

/** Standard error body returned by the backend on 4xx/5xx. */
export interface ApiError {
  error: string;
  message: string;
  /**
   * Optional machine-readable context for the error. Currently used by
   * DELETE /me to carry `AccountDeletionBlocked` when deletion is refused
   * because the caller solely owns Homes that still have other members.
   */
  details?: unknown;
}
