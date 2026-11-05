# Foresight — Android Viewer

Native Android viewer for Foresight Security, at feature parity with the iOS
viewer (`../Foresight`): auth, Homes, live camera grid, full-screen viewing
with camera controls, pairing-QR display, push-to-talk, listen, snapshots,
local recordings, rename/remove, settings — and **media-only E2EE** per
`../shared/E2EE.md`.

Kotlin + Jetpack Compose, package `com.foresight.viewer`, minSdk 29 / target 35.

## Build

```
./gradlew test            # JVM unit tests (protocol + E2EE parity vector)
./gradlew assembleDebug   # APK at app/build/outputs/apk/debug/
```

Requirements: JDK 17+ (Android Studio's JBR works), Android SDK (path in
`local.properties`). Missing platforms/build-tools are auto-installed.

The E2EE parity tests read the **canonical** frozen vector at
`../shared/test-vectors/e2ee-parity.json` (located by walking up from the
module directory) — run tests from within the monorepo checkout.

## Architecture (mirrors the iOS app)

| Package | Contents | iOS counterpart |
| --- | --- | --- |
| `contract/` | Kotlin mirror of `shared/ts` (rest + realtime + e2ee), `ForesightCodec`, QR payload | `Models/ForesightProtocol.swift` |
| `network/` | `ApiClient` (OkHttp, bearer injection, 20 s timeout, `ApiError` decode) | `Networking/APIClient.swift` |
| `session/` | `Session` (auth phase, unlock phase, cold-launch re-unlock) | `App/Session.swift` |
| `crypto/` | `IdentityVault` + `SodiumOps` over **lazysodium** (libsodium) | `Crypto/IdentityVault.swift` |
| `securestore/` | Keystore-encrypted JWT store; biometric-gated identity cache (RSA user-auth key, invalidated on enrollment change) | `Networking/Keychain.swift` |
| `realtime/` | `RoomManager`, `LiveCamera`, Compose video renderer (LiveKit Android) | `Realtime/*` |
| `media/` | ZXing QR, `FrameGrabber` snapshot, `TrackRecorder` (MediaCodec+MediaMuxer), MediaStore saving | `Support/*`, `FrameCapture.swift` |
| `ui/` | Compose screens: Auth, Settings, Homes, HomeGrid, CameraTile, FullScreenCamera, AddCamera QR, Unlock | `Features/*` |

## Server address

Default API base URL is `http://10.0.2.2:3199` — the host machine's localhost
as seen **from the Android emulator**. On a physical device, open Settings
(gear icon) and set the host's LAN IP, e.g. `http://192.168.1.20:3199`.
Cleartext HTTP is enabled for the dev backend.

## E2EE — the locked contract (do not drift)

Everything cryptographic must stay byte-identical with web / iOS / camera /
recorder (`shared/ts/src/e2ee.ts` is canonical; plan §3.2):

- HMK applied as `setSharedKey(base64(HMK))` — a **string** (PBKDF2 path),
  never raw bytes — always at **key index 0** (`keyEpoch` is server
  bookkeeping, never a LiveKit key index).
- `ratchetSalt "LKFrameEncryptionKey"`, `ratchetWindowSize 0` (the Android
  SDK default is **16** — `RoomManager.makeKeyProvider` overrides it), AES-GCM,
  shared key, key ring 16.
- Argon2id `opslimit 3 / memlimit 64 MiB`; vault unlock derives from the
  **blob's** KdfParams, not constants.
- **Media-only**: plain `E2EEOptions` encrypts frames only. The SDK's `@Beta`
  `dataChannelEncryptionEnabled` must stay `false` — commands/telemetry/rekey
  ride the reliable data channel in plaintext until every Foresight client
  migrates together (plan §2.3).
- Never connect plaintext into a Home with `keyEpoch ≥ 1`: a missing sealed
  key shows "Waiting for access"; a locked identity shows the unlock flow
  (biometric first, then password).
- Rotation (`rekey` data message): re-fetch `GET /homes/:id/key`, unseal, and
  re-apply on the **same** key provider at index 0.

`E2EEParityTest` proves all of this against the frozen M0 vector, including
LiveKit's PBKDF2 derivation and an AES-GCM sample frame.

## Contract sync

The protocol is hand-mirrored across platforms (see the repo's
`shared/PROTOCOL.md` and the 4-file Swift mirror convention). This app adds a
Kotlin mirror: `app/src/main/java/com/foresight/viewer/contract/` — when the
contract changes, edit these files too and keep JSON field names identical.

## Manual verification

See [SMOKE_TESTS.md](SMOKE_TESTS.md) for the device/emulator checklist
(login/register, pairing, E2EE lock states, controls, PTT, snapshot,
recording, rename/remove).
