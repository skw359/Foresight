# Foresight Security — Protocol Contract (v1)

This is the **single source of truth** every codebase builds against. The typed
definitions live in:

- **TypeScript** (backend + web): [`shared/ts/src`](./ts/src) — published as `@foresight/contract`.
- **Swift** (both iOS apps): [`shared/swift/ForesightProtocol.swift`](./swift/ForesightProtocol.swift).

Both must stay in sync with this document. JSON field names are identical across
all platforms.

---

## 1. Roles & identity

| Concept | Value |
| --- | --- |
| LiveKit room (one per Home) | `home:<homeId>` |
| Camera participant identity | `camera:<cameraId>` |
| Viewer participant identity | `user:<userId>:<sessionId>` |
| Participant role | `camera` \| `viewer` (in token metadata) |

Helpers: `homeRoom()`, `cameraIdentity()`, `viewerIdentity()`, `parseIdentity()`.

The backend embeds **`ParticipantMetadata`** (`{ role, userId?, cameraId?, displayName? }`)
in every LiveKit access token. Peers read each other's metadata to authorize
senders — a camera only obeys `command` messages from participants whose
metadata role is `viewer` and who belong to the same Home (enforced by the
token the backend minted).

---

## 2. Authentication model

- **Users (web + iOS viewer):** `POST /auth/register` or `/auth/login` → bearer
  `token`. Sent as `Authorization: Bearer <token>` on all user requests and to
  obtain a viewer realtime token.
- **Cameras:** receive a long-lived `deviceSecret` from `POST /pair/claim`. They
  present it to `POST /rt/token` to obtain a publisher LiveKit token. No user
  session.
- Passwords have **no complexity rules** (product decision); stored hashed (argon2).
- `identifier` is a **single field** — email or username, the user's choice.

---

## 3. REST API

Base URL is the backend (default dev port `3199`). All bodies are JSON. See
`rest.ts` for exact field types.

| Method & path | Auth | Body → Response |
| --- | --- | --- |
| `POST /auth/register` | — | `RegisterRequest` → `AuthResponse` |
| `POST /auth/login` | — | `LoginRequest` → `AuthResponse` |
| `GET /homes` | user | → `HomeDTO[]` |
| `POST /homes` | user | `CreateHomeRequest` → `HomeDTO` |
| `POST /homes/:homeId/members` | user (owner) | `AddMemberRequest` → `HomeDTO` |
| `GET /homes/:homeId/cameras` | user | → `CameraDTO[]` |
| `POST /homes/:homeId/cameras/pair` | user | → `PairingTicket` (encode into QR) |
| `POST /pair/claim` | — (pairing token) | `ClaimPairingRequest` → `ClaimPairingResponse` |
| `PATCH /cameras/:cameraId` | user | `RenameCameraRequest` → `CameraDTO` |
| `DELETE /cameras/:cameraId` | user | → `204` |
| `POST /rt/token` | user **or** deviceSecret | `RtTokenRequest` → `RtTokenResponse` |
| `POST /webhooks/livekit` | LiveKit signature | LiveKit `WebhookEvent` → `200` |

E2EE key-management routes (see `e2ee.ts` for the full route map + types):

| Method & path | Auth | Body → Response |
| --- | --- | --- |
| `POST /me/keys` / `GET /me/keys` | user | `EncryptedKeyVault` → `204` / → `MeKeysResponse` |
| `GET /homes/:homeId/key` | user | → `HomeKeyResponse` (caller's sealed copy) |
| `GET /homes/:homeId/key/pending` | user | → `PendingKeyHoldersResponse` |
| `POST /homes/:homeId/key` | user | `SubmitSealedKeysRequest` → `204` |
| `POST /homes/:homeId/key/init` | user (owner) | `InitHomeKeyRequest` → `HomeKeyEpochResponse` |
| `POST /homes/:homeId/key/rotate` | user (owner) | `RotateHomeKeyRequest` → `HomeKeyEpochResponse` |
| `POST /homes/:homeId/recorder-consent` | user (owner) | `RecorderConsentRequest` → `RecorderConsentResponse` |
| `GET /e2ee/recorder-identity` | user | → `RecorderIdentityResponse` |
| `POST /cameras/:cameraId/pubkey` | deviceSecret | `CameraKeyRegistration` → `204` |

Errors use `ApiError` `{ error, message }`.

---

## 4. Realtime control protocol (LiveKit data channel)

All control traffic is **reliable data messages**, never tied to the media
stream. Envelope is discriminated on `type`; every message carries `v`
(= `PROTOCOL_VERSION`, currently `1`).

### `command` — viewer → camera
Addressed to the target camera via LiveKit `destinationIdentities`.
```jsonc
{ "v": 1, "type": "command", "id": "<uuid>", "target": "<cameraId>",
  "action": "torch", "args": { "on": true } }
```
Actions & their `args`:

| action | args | effect |
| --- | --- | --- |
| `torch` | `{ on }` | flashlight on/off (only if `capabilities.torch`) |
| `switchLens` | `{ lens }` | switch optical lens to a factor from `capabilities.lenses` |
| `setZoom` | `{ zoom }` | digital zoom ≥ 1, up to `capabilities.maxDigitalZoom` |
| `setQuality` | `{ quality }` | `auto`\|`480p`\|`1080p`\|`max` (see §5; `pure4k` accepted as a legacy alias for `max`) |
| `snapshotHint` | — | advisory; snapshot is captured viewer-side in v1 |
| `startRecord`/`stopRecord` | — | advisory; recording is viewer-side in v1 |
| `talkStart`/`talkStop` | — | push-to-talk; camera plays the viewer's audio track and shows "Viewer is speaking" |
| `alarm` | `{ on }` | emergency sound (stubbed; UI deferred) |

### `ack` — camera → viewer
```jsonc
{ "v": 1, "type": "ack", "commandId": "<uuid>", "ok": true }
```

### `state` — camera → room (broadcast on change)
Keeps web + iOS viewers in sync.
```jsonc
{ "v": 1, "type": "state", "cameraId": "...", "torchOn": false, "lens": 1,
  "zoom": 1, "quality": "auto", "recording": false, "talking": false }
```

### `telemetry` — camera → room (periodic heartbeat, ~every 5s)
```jsonc
{ "v": 1, "type": "telemetry", "cameraId": "...", "battery": 0.82,
  "charging": true, "wifi": { "level": 3 }, "thermal": "nominal", "viewerCount": 2 }
```

### `rekey` — rotating client → room (broadcast, E2EE Homes only)
The Home Media Key rotated to `epoch`; every participant re-fetches its sealed
copy and re-applies `setKey(base64(HMK′))` — still at LiveKit key index 0
(`epoch` is server bookkeeping, never a key index).
```jsonc
{ "v": 1, "type": "rekey", "epoch": 2 }
```

Use `encodeDataMessage`/`decodeDataMessage` (TS) and `ForesightCodec` (Swift).

---

## 4b. End-to-end encryption (E2EE)

Camera media is E2EE per Home once the **owner explicitly activates** it
(`key/init`, refused until every camera registered a pubkey). Design + locked
constants: `E2EE_MODEL_B_PLAN.md` (root) and `e2ee.ts` (canonical constants —
key applied as the **base64(HMK) string** at **key index 0**, keySize 128,
AES-GCM, ratchetSalt `LKFrameEncryptionKey`, ratchetWindowSize 0).

- Per-user X25519 keypair; private key wrapped under Argon2id(login password)
  in an `EncryptedKeyVault` (server stores it opaquely; `AuthResponse.keyVault`).
- Per-Home Media Key (HMK) sealed (`crypto_box_seal`) to each member/camera —
  and to the **recorder only with explicit per-Home owner consent**.
- Sealed copies ride `RtTokenResponse.sealedHomeKey` (zero extra round-trips).
  `keyEpoch 0` = Home not activated (plaintext, exactly as before).
- Rotation (member/camera removal, consent revoke): fresh HMK at `epoch+1`,
  re-sealed to remaining holders + `rekey` broadcast.
- Honest scope: the **live feed** is E2EE; this data channel and recordings at
  rest are **not** (plan §2.3). Cross-platform parity is locked by the M0 test
  vector at `shared/test-vectors/e2ee-parity.json`.

---

## 5. Quality & multi-view

LiveKit **simulcast + dynacast** does the heavy lifting — no custom transcoding.

- Camera publishes simulcast layers (low/med/high; high only when the device
  supports it, e.g. up to 4K).
- **Grid view:** viewers subscribe to the **low** layer per camera; unviewed
  tiles are paused by dynacast.
- **Full-screen:** pin the **high/max** layer for the selected camera.
- Preset mapping: `auto` → adaptive; `480p` → low; `1080p` → the high-bitrate
  1080p ladder; `max` → highest available: true 4K as a SINGLE non-simulcast
  layer if the camera has a 4K sensor, else the same 1080p ladder. A camera that
  can't start 4K falls back to `1080p` and acks the failure.
- `pure4k` is a legacy wire alias for `max`; cameras still accept it, viewer UIs
  no longer send it.

---

## 6. Pairing flow

1. Viewer opens a Home → **Add Camera** → `POST /homes/:id/cameras/pair`.
2. Backend returns a `PairingTicket`; the viewer renders it as a **QR code**.
3. Camera client scans the QR, reads the `PairingTicket`.
4. Camera detects `CameraCapabilities`, the user names it, then
   `POST /pair/claim` → `ClaimPairingResponse { camera, deviceSecret }`.
5. Camera stores `deviceSecret`, calls `POST /rt/token` (role `camera`), joins
   `home:<homeId>`, and starts publishing.
6. Viewers see the new camera appear live.
