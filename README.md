# Foresight Security

**Turn old iPhones into high-quality smart security cameras you can view and
control from anywhere.**

An unused iPhone runs the Camera Client and streams live video/audio. You pair,
view, and control your cameras from a web dashboard, an iOS app or an Android
app — switch
lenses, zoom, toggle the flashlight, talk back (push-to-talk), take snapshots,
record clips, and watch device health (battery, Wi-Fi, temperature).

## System

Five client/server codebases + a media server, all speaking one shared contract.

```
┌─────────────────────┐         ┌──────────────────────┐
│  iPhone Camera       │  media  │      LiveKit         │  media   ┌──────────────────┐
│  Client (Swift)      │────────▶│   (WebRTC SFU)       │◀────────│  Web dashboard    │
│  publishes A/V       │◀───────▶│  room per Home       │◀───────▶│  (React)          │
└─────────┬───────────┘  data    └──────────┬───────────┘  data    └──────────────────┘
          │                                  │                      ┌──────────────────┐
          │ REST (pair, token)               │ tokens/webhooks      │  iOS + Android    │
          ▼                                  ▼                       │  viewers          │◀┐
┌──────────────────────────────────────────────────────┐           └──────────────────┘ │
│  foresight-server (Node) — accounts, Homes, cameras,   │◀───────────── REST + tokens ───┘
│  pairing, LiveKit token minting, playback, audit       │──loopback──▶ foresight-recorder
└────────────────────────────┬──────────────────────────┘             (24/7 HLS on disk)
                             SQLite
```

- **Media** rides LiveKit (WebRTC SFU). One **room per Home**; each camera is a
  publisher, each viewer a subscriber. Simulcast handles grid-vs-full-screen
  quality with no custom transcoding.
- **Control** (flashlight, lens, zoom, quality, push-to-talk, snapshot/record
  hints) and **telemetry** ride LiveKit's reliable **data channel** —
  decoupled from the video stream.
- **The backend** owns identity: accounts, Homes (a group of cameras), pairing,
  and minting LiveKit access tokens.

## Codebases

| Folder | What | Stack |
| --- | --- | --- |
| [`Foresight Security Camera Client/`](./Foresight%20Security%20Camera%20Client) | iPhone capture + publish app | Swift / SwiftUI |
| [`Foresight/`](./Foresight) | iOS viewing app | Swift / SwiftUI |
| [`Foresight-android/`](./Foresight-android) | Android viewing app | Kotlin / Jetpack Compose |
| [`Foresight-web-client/`](./Foresight-web-client) | Web desktop dashboard | Vite + React + TS |
| [`foresight-server/`](./foresight-server) | Backend | Node + TS, Fastify, Prisma/SQLite |
| [`foresight-recorder/`](./foresight-recorder) | 24/7 recorder — LiveKit → HLS on disk | Node + TS, ffmpeg |
| [`shared/`](./shared) | **Locked contract** — see [`PROTOCOL.md`](./shared/PROTOCOL.md); E2EE design + threat model in [`E2EE.md`](./shared/E2EE.md) | TS types + Swift mirror (+ Kotlin mirror in the Android app) |
| [`infra/`](./infra) | LiveKit config, run scripts, systemd units, TLS | YAML + sh/ps1 |

## Runtime split

- **Backend + recorder + LiveKit + web** run on **Linux, macOS or Windows** —
  pure Node + a native LiveKit binary, **no Docker**. On Ubuntu they run as
  systemd user services; see [`infra/UBUNTU-SETUP.md`](./infra/UBUNTU-SETUP.md).
- **The two Swift apps** must be built on **macOS with Xcode**; the Android app
  with Android Studio / Gradle.
- All of it talks over your **LAN** for now; going remote = point at LiveKit
  Cloud, or put TLS in front of LiveKit ([`infra/TLS-SETUP.md`](./infra/TLS-SETUP.md))
  — configuration only, no code changes.

## Quick start (local)

```bash
# 1. Install JS deps and build the shared contract
npm install
npm run build:contract

# 2. Configure (both files need the SAME absolute RECORDINGS_DIR)
cp foresight-server/.env.example   foresight-server/.env
cp foresight-recorder/.env.example foresight-recorder/.env
cp infra/livekit.example.yaml      infra/livekit.yaml
#    Generate the secrets — the server and recorder refuse template values:
#      openssl rand -hex 32   → JWT_SECRET, RECORDER_SHARED_SECRET (same in both
#                               .env files) and the LiveKit secret (same in both
#                               .env files and livekit.yaml's `keys:`)
#    (A throwaway local setup may instead set FORESIGHT_INSECURE_DEV=1.)

# 2b. Create the database
(cd foresight-server && npm run prisma:deploy)

# 3. Start LiveKit (separate terminal) — see infra/README.md
./infra/run-local.sh          # Linux/macOS    (Windows: .\infra\run-local.ps1)

# 4. Start the backend (separate terminal)
npm run dev:server

# 5. Start the web dashboard (separate terminal)
npm run dev:web
```

Then register an account — **the first account becomes the server
administrator**, and registration closes after it until the admin opens it in
Settings — create a Home, click **Add Camera** to get a QR code,
and either run the Camera Client on an iPhone or use the dashboard's built-in
**dev-camera harness** (publishes your laptop webcam) to test end-to-end without
a device.

See [`shared/PROTOCOL.md`](./shared/PROTOCOL.md) for the full API + realtime
protocol, and the per-folder READMEs for build/run details.

## Security notes

- Keep the server on a trusted LAN, or put **TLS** in front of both the API and
  LiveKit signaling before exposing it ([`infra/TLS-SETUP.md`](./infra/TLS-SETUP.md)).
- Only Home **owners** can remove cameras, turn recording off, delete footage
  and manage members; those actions are recorded in each Home's Activity log.
  Removing a member or camera disconnects it immediately.
- End-to-end encryption protects live video from the media server operator,
  **not** from a compromised Foresight server — see the threat model in
  [`shared/E2EE.md`](./shared/E2EE.md) §12.
- Back up `foresight-server`'s database (it holds every E2EE key vault):
  [`infra/UBUNTU-SETUP.md`](./infra/UBUNTU-SETUP.md#backups).
