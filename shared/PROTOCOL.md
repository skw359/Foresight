# Foresight Security — Protocol Contract (v1)

This is the **single source of truth** every codebase builds against. The typed
definitions live in:

- **TypeScript** (backend + web): [`shared/ts/src`](./ts/src) — published as `@foresight/contract`.
- **Swift** (both iOS apps): [`shared/swift/ForesightProtocol.swift`](./swift/ForesightProtocol.swift)
  — canonical; each app carries a byte-identical copy, synced by
  `node shared/scripts/sync-swift-protocol.mjs` and checked by the server test
  suite (`test/contractMirrors.test.ts`).
- **Kotlin** (Android viewer): `Foresight-android/app/src/main/java/com/foresight/viewer/contract/`
  — hand-mirrored; `ProtocolJsonTest` / `ProtocolRulesTest` pin the wire shapes.

All must stay in sync with this document. JSON field names are identical across
all platforms. E2EE design + threat model: [`E2EE.md`](./E2EE.md).

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
in every LiveKit access token. Peers authorize every received data message by
its SENDER identity (`isAuthorizedSender` in TS, `Foresight.isAuthorizedSender`
in Swift/Kotlin):

| Message | Accepted only from |
| --- | --- |
| `state`, `telemetry` | the camera the payload is about (`camera:<msg.cameraId>`) |
| `ack` | a camera — and receivers match it to the camera the command was sent to |
| `command` | a viewer (`user:…`); never another camera and never sender-less (server API) data |
| `rekey` | the server (no sender) or a viewer |

Grants: viewers may publish only `microphone` (push-to-talk); cameras only
`camera` + `microphone`. LiveKit tokens live 2 h; revoking access also evicts
the participant (LiveKit only checks tokens at join).

---

## 2. Authentication model

- **Users (web + iOS viewer):** `POST /auth/register` or `/auth/login` → bearer
  `token`. Sent as `Authorization: Bearer <token>` on all user requests and to
  obtain a viewer realtime token. Sessions carry a token version: "sign out
  everywhere" and a password change revoke every older token.
- **Server admin:** the first account on a server (`UserDTO.isAdmin`). Only
  the admin may change server-wide settings (pairing URL, registration).
  Registration is closed once an admin exists unless the admin (or
  `ALLOW_REGISTRATION`) opens it.
- **Cameras:** receive a long-lived `deviceSecret` (256 random bits) from
  `POST /pair/claim`. They present it to `POST /rt/token` to obtain a publisher
  LiveKit token. No user session. The camera confirms the ticket's server with
  the user before claiming — it trusts that URL permanently.
- Unauthenticated endpoints are rate limited (429 + `Retry-After`).
- Passwords have **no complexity rules** (product decision); stored hashed (argon2).
- `identifier` is a **single field** — email or username, the user's choice.

---

## 3. REST API

Base URL is the backend (default dev port `3199`). All bodies are JSON. See
`rest.ts` for exact field types.

| Method & path | Auth | Body → Response |
| --- | --- | --- |
| `POST /auth/register` | — (first account, or registration open) | `RegisterRequest` → `AuthResponse` (403 `registration_closed`) |
| `POST /auth/login` | — | `LoginRequest` → `AuthResponse` |
| `POST /auth/logout-all` | user | → `SessionResponse` (revokes every other session) |
| `POST /me/password` | user | `ChangePasswordRequest` → `SessionResponse` |
| `PATCH /me` / `DELETE /me` | user | profile / account deletion |
| `GET /settings` / `PUT /settings` | user / **server admin** | → / `UpdateServerSettingsRequest` → `ServerSettings` |
| `GET /homes` | user | → `HomeDTO[]` |
| `POST /homes` | user | `CreateHomeRequest` → `HomeDTO` |
| `POST /homes/:homeId/members` | user (owner) | `AddMemberRequest` → `HomeDTO` |
| `GET /homes/:homeId/members` | user | → `HomeMemberDTO[]` |
| `PATCH /homes/:homeId/members/:userId` | user (owner) | `UpdateMemberRequest` → `HomeMemberDTO` (409 `last_owner`) |
| `DELETE /homes/:homeId/members/:userId` | owner, or the member themself | → `204` (evicts their sessions; 409 `last_owner`) |
| `POST /homes/:homeId/transfer-owner` | user (owner) | `TransferOwnershipRequest` → `HomeDTO` |
| `DELETE /homes/:homeId` | user (owner) | → `204` (closes the room) |
| `GET /homes/:homeId/audit` | user (owner) | → `AuditLogResponse` |
| `GET /homes/:homeId/recording-health` | user | → `RecordingHealthResponse` |
| `GET /homes/:homeId/cameras` | user | → `CameraDTO[]` |
| `POST /homes/:homeId/cameras/pair` | user | → `PairingTicket` (encode into QR) |
| `POST /pair/claim` | — (pairing token, single use) | `ClaimPairingRequest` → `ClaimPairingResponse` |
| `PATCH /cameras/:cameraId` | user | `RenameCameraRequest` → `CameraDTO` |
| `DELETE /cameras/:cameraId` | user (owner) | → `204` (evicts the camera) |
| `POST /cameras/:cameraId/recording` | user (turning OFF: owner) | `SetRecordingRequest` → `SetRecordingResponse` |
| `POST /cameras/:cameraId/unpair` | deviceSecret | `UnpairCameraRequest` → `204` (the camera removes itself) |
| `GET /cameras/:cameraId/recordings` | user | → `RecordingCoverage` |
| `DELETE /cameras/:cameraId/recordings?from&to` | user (owner) | → `DeleteRecordingsResponse` |
| `POST /recordings/:cameraId/clip-url?from&to` | user | → `ClipUrlResponse` (signed, 5 min, range ≤ `CLIP_MAX_SECONDS`) |
| `POST /rt/token` | user **or** deviceSecret | `RtTokenRequest` → `RtTokenResponse` |
| `POST /webhooks/livekit` | LiveKit signature | LiveKit `WebhookEvent` → `200` |

E2EE key-management routes (see `e2ee.ts` for the full route map + types):

| Method & path | Auth | Body → Response |
| --- | --- | --- |
| `POST /me/keys` / `GET /me/keys` | user | `SetKeyVaultRequest` → `204` (replacing a different vault needs `currentPassword`; 409 `vault_exists`) / → `MeKeysResponse` |
| `GET /homes/:homeId/key` | user | → `HomeKeyResponse` (caller's sealed copy) |
| `GET /homes/:homeId/key/pending` | user | → `PendingKeyHoldersResponse` |
| `GET /homes/:homeId/key/holders` | user (owner) | → `PendingKeyHoldersResponse` (every rotation target) |
| `POST /homes/:homeId/key` | user | `SubmitSealedKeysRequest` → `204` |
| `POST /homes/:homeId/key/init` | user (owner) | `InitHomeKeyRequest` → `HomeKeyEpochResponse` |
| `POST /homes/:homeId/key/rotate` | user (owner) | `RotateHomeKeyRequest` → `HomeKeyEpochResponse` (must include the recorder's copy while consented) |
| `POST /homes/:homeId/key/disable` | user (owner) | → `HomeKeyEpochResponse` |
| `POST /homes/:homeId/recorder-consent` | user (owner) | `RecorderConsentRequest` → `RecorderConsentResponse` |
| `GET /e2ee/recorder-identity` | user | → `RecorderIdentityResponse` |
| `POST /cameras/:cameraId/pubkey` | deviceSecret | `CameraKeyRegistration` → `204` |

Errors use `ApiError` `{ error, message, details? }`.

The server↔recorder internal API (`/internal/*`, shared-secret authenticated)
is served only on a separate loopback listener (`127.0.0.1:INTERNAL_PORT`,
default 3198), never on the public port.

---

## 4. Realtime control protocol (LiveKit data channel)

All control traffic is **reliable data messages**, never tied to the media
stream. Envelope is discriminated on `type`; every message carries `v`
(= `PROTOCOL_VERSION`, currently `1`). Receivers drop messages with another
`v`, an unknown `type`, a malformed shape, or an unauthorized sender (§1).

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
Cameras ack every command; a viewer that gets no ack within a few seconds
reports the command as **unconfirmed**, not as done.

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

### `rekey` — server (or rotating client) → room (broadcast)
The Home's key state changed: activated (`key/init`), rotated (`key/rotate`) or
turned off (`epoch: 0`, `key/disable`). The **server** sends it for all three.
Every participant re-fetches its sealed copy and converges: a plaintext session
in a newly activated Home reconnects encrypted; a keyed session re-applies
`setKey(base64(HMK′))` — still at LiveKit key index 0 (`epoch` is server
bookkeeping, never a key index); epoch 0 reconnects plaintext. Cameras also
re-check periodically, so a missed `rekey` still converges.
```jsonc
{ "v": 1, "type": "rekey", "epoch": 2 }
```

Use `encodeDataMessage`/`decodeDataMessage` (TS) and `ForesightCodec` (Swift).

---

## 4b. End-to-end encryption (E2EE)

Camera media is E2EE per Home once the **owner explicitly activates** it
(`key/init`, refused until every camera registered a pubkey). Design + locked
constants: [`E2EE.md`](./E2EE.md) and `e2ee.ts` (canonical constants —
key applied as the **base64(HMK) string** at **key index 0**, keySize 128,
AES-GCM, ratchetSalt `LKFrameEncryptionKey`, ratchetWindowSize 0).

- Per-user X25519 keypair; private key wrapped under Argon2id(login password)
  in an `EncryptedKeyVault` (server stores it opaquely; `AuthResponse.keyVault`).
- Per-Home Media Key (HMK) sealed (`crypto_box_seal`) to each member/camera —
  and to the **recorder only with explicit per-Home owner consent**.
- Sealed copies ride `RtTokenResponse.sealedHomeKey` (zero extra round-trips).
  `keyEpoch 0` = Home not activated (plaintext, exactly as before).
- Rotation (member/camera removal, consent revoke): fresh HMK at `epoch+1`,
  sealed to every remaining holder in the rotate request itself (recorder
  included while consented) + server `rekey` broadcast.
- Honest scope: the **live feed** is E2EE; this data channel and recordings at
  rest are **not** (`E2EE.md` §2.3), and E2EE does **not** protect against a
  compromised Foresight server, which receives the login password the vault is
  derived from (`E2EE.md` §12). Cross-platform parity is locked by the M0 test
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
4. Camera detects `CameraCapabilities`, the user names it **and confirms the
   server shown on screen is theirs**, then `POST /pair/claim` →
   `ClaimPairingResponse { camera, deviceSecret }`.
5. Camera stores `deviceSecret`, calls `POST /rt/token` (role `camera`), joins
   `home:<homeId>`, and starts publishing.
6. Viewers see the new camera appear live.
7. **Unpair** on the camera calls `POST /cameras/:cameraId/unpair`, removing
   the camera from the Home server-side.
