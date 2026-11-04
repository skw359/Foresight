# Foresight Security

**Turn old iPhones into high-quality smart security cameras you can view and
control from anywhere.**

An unused iPhone runs the Camera Client and streams live video/audio. You pair,
view, and control your cameras from a web dashboard or an iOS app — switch
lenses, zoom, toggle the flashlight, talk back (push-to-talk), take snapshots,
record clips, and watch device health (battery, Wi-Fi, temperature).

## System

Four codebases + a media server, all speaking one shared contract.

```
┌─────────────────────┐         ┌──────────────────────┐
│  iPhone Camera       │  media  │      LiveKit         │  media   ┌──────────────────┐
│  Client (Swift)      │────────▶│   (WebRTC SFU)       │◀────────│  Web dashboard    │
│  publishes A/V       │◀───────▶│  room per Home       │◀───────▶│  (React)          │
└─────────┬───────────┘  data    └──────────┬───────────┘  data    └──────────────────┘
          │                                  │                      ┌──────────────────┐
          │ REST (pair, token)               │ tokens/webhooks      │  iOS Viewer       │
          ▼                                  ▼                       │  (Swift)          │◀┐
┌──────────────────────────────────────────────────────┐           └──────────────────┘ │
│  foresight-server (Node) — accounts, Homes, cameras,   │◀───────────── REST + tokens ───┘
│  pairing, LiveKit token minting, status               │
└────────────────────────────┬──────────────────────────┘
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
| [`Foresight-web-client/`](./Foresight-web-client) | Web desktop dashboard | Vite + React + TS |
| [`foresight-server/`](./foresight-server) | Backend | Node + TS, Fastify, Prisma/SQLite |
| [`foresight-recorder/`](./foresight-recorder) | 24/7 recorder — LiveKit → HLS on disk | Node + TS, ffmpeg |
| [`shared/`](./shared) | **Locked contract** — see [`PROTOCOL.md`](./shared/PROTOCOL.md) | TS types + Swift mirror |
| [`infra/`](./infra) | LiveKit config, run scripts, systemd units, TLS | YAML + sh/ps1 |

## Runtime split

- **Backend + recorder + LiveKit + web** run on **Linux, macOS or Windows** —
  pure Node + a native LiveKit binary, **no Docker**. On Ubuntu they run as
  systemd user services; see [`infra/UBUNTU-SETUP.md`](./infra/UBUNTU-SETUP.md).
- **The two Swift apps** must be built on **macOS with Xcode**.
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

# 3. Start LiveKit (separate terminal) — see infra/README.md
./infra/run-local.sh          # Linux/macOS    (Windows: .\infra\run-local.ps1)

# 4. Start the backend (separate terminal)
npm run dev:server

# 5. Start the web dashboard (separate terminal)
npm run dev:web
```

Then register an account, create a Home, click **Add Camera** to get a QR code,
and either run the Camera Client on an iPhone or use the dashboard's built-in
**dev-camera harness** (publishes your laptop webcam) to test end-to-end without
a device.

See [`shared/PROTOCOL.md`](./shared/PROTOCOL.md) for the full API + realtime
protocol, and the per-folder READMEs for build/run details.
