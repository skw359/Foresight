/**
 * Typed REST client for the Foresight backend; every shape comes from
 * `@foresight/contract`. The LiveKit ws URL is never hardcoded; it is read from
 * RtTokenResponse.
 */
import type {
  AddMemberRequest,
  ApiError,
  AuditLogResponse,
  ChangePasswordRequest,
  ClipUrlResponse,
  MemberRole,
  RecordingHealthResponse,
  SessionResponse,
  SetKeyVaultRequest,
  AuthResponse,
  CameraDTO,
  ClaimPairingRequest,
  ClaimPairingResponse,
  CreateHomeRequest,
  DeleteRecordingsResponse,
  EncryptedKeyVault,
  HomeDTO,
  HomeKeyEpochResponse,
  HomeKeyResponse,
  HomeMemberDTO,
  InitHomeKeyRequest,
  KeyHolderType,
  LoginRequest,
  MeKeysResponse,
  PendingKeyHoldersResponse,
  RecorderConsentRequest,
  RecorderConsentResponse,
  RecorderIdentityResponse,
  RotateHomeKeyRequest,
  TransferOwnershipRequest,
  PairingTicket,
  RecordingCoverage,
  RegisterRequest,
  RenameCameraRequest,
  RtTokenRequest,
  RtTokenResponse,
  ServerSettings,
  SetRecordingResponse,
  SubmitSealedKeysRequest,
  UpdateProfileRequest,
  UpdateServerSettingsRequest,
  UserDTO,
} from "@foresight/contract";

import { clearToken, getToken, setToken } from "./auth";

/**
 * Resolve the backend base URL. An explicit VITE_API_URL always wins. Otherwise:
 * production → "" (same origin: the backend serves this build, so every device
 * that can load the dashboard can reach the API, and HTTPS stays HTTPS); dev →
 * the Vite page's own host on port 3199. A hardcoded "localhost" would make
 * every OTHER device's browser call itself.
 */
export function resolveApiUrl(
  env: { VITE_API_URL?: string; DEV?: boolean },
  location?: { protocol: string; hostname: string },
): string {
  const explicit = env.VITE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (!env.DEV) return "";
  const host = location?.hostname || "localhost";
  const proto = location?.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${host.includes(":") ? `[${host}]` : host}:3199`;
}

export const API_URL: string = resolveApiUrl(
  import.meta.env as { VITE_API_URL?: string; DEV?: boolean },
  typeof window !== "undefined" ? window.location : undefined,
);

/** Error thrown by the client carrying the backend's structured ApiError. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** Optional machine-readable context from ApiError.details, when present. */
  readonly details: unknown;

  constructor(status: number, body: ApiError | string) {
    const message = typeof body === "string" ? body : body.message;
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = typeof body === "string" ? "error" : body.error;
    this.details = typeof body === "string" ? undefined : body.details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** When true, attaches the stored bearer token. Defaults to true. */
  auth?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true, signal } = opts;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network failure (backend down). Surface a clean message; callers guard.
    throw new ApiRequestError(0, {
      error: "network_error",
      message:
        err instanceof Error
          ? `Cannot reach the backend at ${API_URL || window.location.origin}. ${err.message}`
          : `Cannot reach the backend at ${API_URL || window.location.origin}.`,
    });
  }

  if (res.status === 401 && auth) {
    // Token expired/invalid — drop it so the app redirects to login.
    clearToken();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    if (data && typeof data === "object" && "message" in data) {
      throw new ApiRequestError(res.status, data as ApiError);
    }
    throw new ApiRequestError(res.status, text || res.statusText);
  }

  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function register(req: RegisterRequest): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/register", {
    method: "POST",
    body: req,
    auth: false,
  });
}

export function login(req: LoginRequest): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", {
    method: "POST",
    body: req,
    auth: false,
  });
}

/**
 * Permanently delete the current account and all data uniquely tied to it.
 * Clears the local session on success. On a 409 the backend refuses because the
 * caller solely owns one or more shared Homes; ApiRequestError.details carries
 * `AccountDeletionBlocked` so the caller can list and resolve them.
 */
export async function deleteAccount(): Promise<void> {
  await request<void>("/me", { method: "DELETE" });
  clearToken();
}

/**
 * Sign out every device (revokes every session token issued so far). The
 * response carries a fresh token so THIS browser stays signed in.
 */
export async function logoutEverywhere(): Promise<void> {
  const { token } = await request<SessionResponse>("/auth/logout-all", { method: "POST" });
  setToken(token);
}

/**
 * Change the login password. The caller must send the key vault re-wrapped
 * under the new password (same public key). Every other session is revoked;
 * the fresh token is stored for this browser.
 */
export async function changePassword(req: ChangePasswordRequest): Promise<void> {
  const { token } = await request<SessionResponse>("/me/password", { method: "POST", body: req });
  setToken(token);
}

/** Update the caller's own profile (display first name). Returns the saved user. */
export function updateProfile(req: UpdateProfileRequest): Promise<UserDTO> {
  return request<UserDTO>("/me", { method: "PATCH", body: req });
}

export function listHomes(signal?: AbortSignal): Promise<HomeDTO[]> {
  return request<HomeDTO[]>("/homes", { signal });
}

export function createHome(req: CreateHomeRequest): Promise<HomeDTO> {
  return request<HomeDTO>("/homes", { method: "POST", body: req });
}

export function addMember(
  homeId: string,
  req: AddMemberRequest,
): Promise<HomeDTO> {
  return request<HomeDTO>(`/homes/${homeId}/members`, {
    method: "POST",
    body: req,
  });
}

/** Change a member's role (owner only; the last owner can't be demoted). */
export function updateMemberRole(homeId: string, userId: string, role: MemberRole): Promise<HomeMemberDTO> {
  return request<HomeMemberDTO>(`/homes/${homeId}/members/${userId}`, { method: "PATCH", body: { role } });
}

/**
 * Remove a member (owner), or leave the Home (pass your own userId). The server
 * disconnects the member's live sessions; for an E2EE Home the owner's client
 * must then rotate the key (HomeDTO.keyRotationRequired).
 */
export function removeMember(homeId: string, userId: string): Promise<void> {
  return request<void>(`/homes/${homeId}/members/${userId}`, { method: "DELETE" });
}

/** The Home's audit trail, newest first (owner only). */
export function getAuditLog(homeId: string, before?: string, signal?: AbortSignal): Promise<AuditLogResponse> {
  const q = before ? `?before=${encodeURIComponent(before)}` : "";
  return request<AuditLogResponse>(`/homes/${homeId}/audit${q}`, { signal });
}

/** Per-camera 24/7 recorder health (is it actually writing segments?). */
export function getRecordingHealth(homeId: string, signal?: AbortSignal): Promise<RecordingHealthResponse> {
  return request<RecordingHealthResponse>(`/homes/${homeId}/recording-health`, { signal });
}

/** Permanently delete a Home and everything in it (owner only). */
export function deleteHome(homeId: string): Promise<void> {
  return request<void>(`/homes/${homeId}`, { method: "DELETE" });
}

/** List the members of a Home (any member may view). */
export function listHomeMembers(
  homeId: string,
  signal?: AbortSignal,
): Promise<HomeMemberDTO[]> {
  return request<HomeMemberDTO[]>(`/homes/${homeId}/members`, { signal });
}

/**
 * Hand ownership of a Home to another member (owner only). By default the caller
 * is demoted to a regular member; pass keepOwnership to stay a co-owner.
 */
export function transferHomeOwnership(
  homeId: string,
  req: TransferOwnershipRequest,
): Promise<HomeDTO> {
  return request<HomeDTO>(`/homes/${homeId}/transfer-owner`, {
    method: "POST",
    body: req,
  });
}

export function listCameras(
  homeId: string,
  signal?: AbortSignal,
): Promise<CameraDTO[]> {
  return request<CameraDTO[]>(`/homes/${homeId}/cameras`, { signal });
}

export function pairCamera(homeId: string): Promise<PairingTicket> {
  return request<PairingTicket>(`/homes/${homeId}/cameras/pair`, {
    method: "POST",
  });
}

export function claimPairing(
  req: ClaimPairingRequest,
): Promise<ClaimPairingResponse> {
  // Pairing token is in the body; no user bearer required.
  return request<ClaimPairingResponse>("/pair/claim", {
    method: "POST",
    body: req,
    auth: false,
  });
}

export function renameCamera(
  cameraId: string,
  req: RenameCameraRequest,
): Promise<CameraDTO> {
  return request<CameraDTO>(`/cameras/${cameraId}`, {
    method: "PATCH",
    body: req,
  });
}

export function deleteCamera(cameraId: string): Promise<void> {
  return request<void>(`/cameras/${cameraId}`, { method: "DELETE" });
}

export function setRecording(
  cameraId: string,
  enabled: boolean,
): Promise<SetRecordingResponse> {
  return request<SetRecordingResponse>(`/cameras/${cameraId}/recording`, {
    method: "POST",
    body: { enabled },
  });
}

/** Coverage summary (available spans) from the on-disk segments. */
export function getRecordingCoverage(
  cameraId: string,
  opts?: { from?: string; to?: string },
  signal?: AbortSignal,
): Promise<RecordingCoverage> {
  const qs = new URLSearchParams();
  if (opts?.from) qs.set("from", opts.from);
  if (opts?.to) qs.set("to", opts.to);
  const q = qs.toString();
  return request<RecordingCoverage>(
    `/cameras/${cameraId}/recordings${q ? `?${q}` : ""}`,
    { signal },
  );
}

/**
 * Permanently delete a [from,to) range of recorded footage (the segments behind
 * one coverage span). `from`/`to` are epoch seconds or ISO; deletion cannot be
 * undone. Returns how many segments/bytes were removed.
 */
export function deleteRecordingSpan(
  cameraId: string,
  from: string,
  to: string,
): Promise<DeleteRecordingsResponse> {
  const qs = new URLSearchParams({ from, to });
  return request<DeleteRecordingsResponse>(
    `/cameras/${cameraId}/recordings?${qs.toString()}`,
    { method: "DELETE" },
  );
}

/**
 * URL of a generated HLS playlist. `live` is a rolling tail; `range` needs
 * from/to (epoch seconds or ISO). The bearer token is NOT in the URL — hls.js
 * attaches it per-request via xhrSetup so the auth guard covers playlist + segments.
 */
export function recordingPlaylistUrl(
  cameraId: string,
  opts: { mode: "live" | "range"; from?: string; to?: string },
): string {
  const qs = new URLSearchParams({ mode: opts.mode });
  if (opts.from) qs.set("from", opts.from);
  if (opts.to) qs.set("to", opts.to);
  return `${API_URL}/recordings/${cameraId}/playlist.m3u8?${qs.toString()}`;
}

/**
 * Download a [from,to] range as MP4. The server mints a short-lived signed URL
 * scoped to exactly this camera and range, so a plain download link can stream
 * the file straight to disk — no Authorization header, and no buffering of the
 * whole MP4 in browser memory (which crashed the tab for long clips).
 */
export async function downloadClip(
  cameraId: string,
  from: string,
  to: string,
): Promise<void> {
  const qs = new URLSearchParams({ from, to });
  const { url } = await request<ClipUrlResponse>(
    `/recordings/${cameraId}/clip-url?${qs.toString()}`,
    { method: "POST" },
  );
  const a = document.createElement("a");
  a.href = `${API_URL}${url}`;
  a.download = `clip-${from}-${to}.mp4`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Mint a LiveKit access token. Viewers authenticate via the bearer session;
 * cameras must pass a deviceSecret. Returns the ws URL + room + identity.
 */
export function rtToken(req: RtTokenRequest): Promise<RtTokenResponse> {
  return request<RtTokenResponse>("/rt/token", {
    method: "POST",
    body: req,
    // Cameras have no user session — they authenticate with deviceSecret only.
    auth: req.role !== "camera",
  });
}

// E2EE keys: the server stores/serves opaque base64 blobs only and performs no
// crypto (shared/E2EE.md §7.1). Sealing/unsealing/KDF happen client-side under
// @foresight/contract's locked constants.

/** GET /me/keys — the caller's encrypted key vault (null ⇒ run first-login keygen). */
export function getMyKeys(signal?: AbortSignal): Promise<MeKeysResponse> {
  return request<MeKeysResponse>("/me/keys", { signal });
}

/**
 * POST /me/keys — upload the caller's encrypted key vault (register /
 * first-login). Replacing an existing, different vault needs `currentPassword`
 * (409 vault_exists otherwise).
 */
export function putMyKeys(vault: EncryptedKeyVault | SetKeyVaultRequest): Promise<void> {
  return request<void>("/me/keys", { method: "POST", body: vault });
}

/** GET /homes/:id/key — the caller's own sealed HMK copy at the Home's epoch. */
export function getHomeKey(homeId: string, signal?: AbortSignal): Promise<HomeKeyResponse> {
  return request<HomeKeyResponse>(`/homes/${homeId}/key`, { signal });
}

/** GET /homes/:id/key/pending — holders lacking a sealed key at the current epoch. */
export function getPendingKeyHolders(
  homeId: string,
  signal?: AbortSignal,
): Promise<PendingKeyHoldersResponse> {
  return request<PendingKeyHoldersResponse>(`/homes/${homeId}/key/pending`, { signal });
}

/**
 * GET /homes/:id/key/holders — owner only: EVERY holder the next epoch must be
 * sealed to (members/cameras with pubkeys + the recorder while consented).
 */
export function getKeyHolders(homeId: string, signal?: AbortSignal): Promise<PendingKeyHoldersResponse> {
  return request<PendingKeyHoldersResponse>(`/homes/${homeId}/key/holders`, { signal });
}

/** POST /homes/:id/key — upload sealed copies for pending holders (idempotent). */
export function submitSealedKeys(homeId: string, req: SubmitSealedKeysRequest): Promise<void> {
  return request<void>(`/homes/${homeId}/key`, { method: "POST", body: req });
}

/** DELETE /homes/:id/key/:holderType/:holderId — owner-only repair: drop a holder's current-epoch sealed copy so it returns to pending. */
export function deleteHolderKey(homeId: string, holderType: KeyHolderType, holderId: string): Promise<void> {
  return request<void>(`/homes/${homeId}/key/${holderType}/${holderId}`, { method: "DELETE" });
}

/** POST /homes/:id/key/init — explicit owner activation (epoch 0→1). */
export function initHomeKey(homeId: string, req: InitHomeKeyRequest): Promise<HomeKeyEpochResponse> {
  return request<HomeKeyEpochResponse>(`/homes/${homeId}/key/init`, { method: "POST", body: req });
}

/** POST /homes/:id/key/rotate — generate-and-seal a fresh HMK for remaining holders. */
export function rotateHomeKey(homeId: string, req: RotateHomeKeyRequest): Promise<HomeKeyEpochResponse> {
  return request<HomeKeyEpochResponse>(`/homes/${homeId}/key/rotate`, { method: "POST", body: req });
}

/** POST /homes/:id/key/disable — owner turns E2EE off (keyEpoch → 0; the server tells the room). */
export function disableHomeKey(homeId: string): Promise<HomeKeyEpochResponse> {
  return request<HomeKeyEpochResponse>(`/homes/${homeId}/key/disable`, { method: "POST" });
}

/** POST /homes/:id/recorder-consent — owner toggles recorder key-holding for a Home. */
export function setRecorderConsent(
  homeId: string,
  req: RecorderConsentRequest,
): Promise<RecorderConsentResponse> {
  return request<RecorderConsentResponse>(`/homes/${homeId}/recorder-consent`, {
    method: "POST",
    body: req,
  });
}

/** GET /e2ee/recorder-identity — the global recorder pubkey (for consent + fingerprint). */
export function getRecorderIdentity(signal?: AbortSignal): Promise<RecorderIdentityResponse> {
  return request<RecorderIdentityResponse>("/e2ee/recorder-identity", { signal });
}

/** Fetch server-wide settings (and the URL the server auto-detected for us). */
export function getServerSettings(signal?: AbortSignal): Promise<ServerSettings> {
  return request<ServerSettings>("/settings", { signal });
}

export function updateServerSettings(
  req: UpdateServerSettingsRequest,
): Promise<ServerSettings> {
  return request<ServerSettings>("/settings", { method: "PUT", body: req });
}
