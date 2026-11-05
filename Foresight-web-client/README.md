# Foresight-web-client

The Foresight Security **web desktop dashboard** — the main control center. Pair
cameras (QR), view a Home's cameras in a grid or full-screen, and control them
(quality, audio, push-to-talk, flashlight, lens, zoom, snapshot, record). Built
with Vite + React + TypeScript and the LiveKit browser SDK.

See [`../shared/PROTOCOL.md`](../shared/PROTOCOL.md) for the API + realtime
contract (imported as `@foresight/contract`).

## Setup & run

From the **repo root** first (installs the workspace + builds the shared contract):

```bash
npm install
npm run build:contract
```

Then in this folder:

```bash
npm run dev        # Vite dev server (prints a localhost + LAN URL)
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

The backend URL defaults to the **same origin** in a production build — the
backend serves `dist/`, so every device that can open the dashboard reaches
the API, and an HTTPS dashboard stays HTTPS. The Vite dev server defaults to
port 3199 on whatever host you opened it on. Set `VITE_API_URL` (copy
`.env.example` to `.env`) only when the API lives somewhere else. The LiveKit
ws URL is **never** hardcoded; it always comes from the backend's `/rt/token`
responses.

The dashboard is served with a strict Content-Security-Policy (no inline or
third-party scripts) and loads no third-party resources: the Montserrat font is
self-hosted under `public/fonts/` (SIL OFL 1.1).

## Using it

1. Register (single identifier field — email or username — + password, no rules).
   The first account on a server becomes its **administrator**; after that,
   registration is closed until the admin opens it (Settings → General → New
   accounts).
2. Create a **Home** (a group of cameras), open it.
3. **Add Camera** → a QR code + pairing token appear. Either:
   - scan the QR with the iPhone **Camera Client**, or
   - use the **Dev Camera** harness (below) to test without a device.
4. Cameras appear in the grid (live, low-res tiles + health badges). Click one
   for full-screen + the control panel.

## Dev Camera harness (test without an iPhone)

Route: **`/dev/camera`** — a browser stand-in for the iPhone Camera Client. It
claims a pairing token, publishes your **webcam + mic** as a camera participant,
and obeys control commands (ack, quality, push-to-talk audio, torch/record
indicators) while emitting `state` + `telemetry`.

End-to-end test in one browser:
1. Tab A: log in → create a Home → **Add Camera** → copy the pairing token.
2. Tab B: go to `/dev/camera`, paste the token, **Start dev camera** (allow
   camera/mic). You can also deep-link `/dev/camera?token=...`.
3. Tab A: the camera appears in the grid. Open it full-screen and exercise the
   controls — watch the dev camera's activity log react, and the badges update.

This exercises the whole pairing → media → control → telemetry path with no
hardware. Requires the backend and LiveKit running (see the root README and
`../infra/README.md`).

## Layout

```
src/
  main.tsx, App.tsx        bootstrap + route table
  api/                     typed REST client + token storage
  auth/                    AuthContext + RequireAuth guard
  pages/                   Login, Register, Homes, Home (grid), Camera (full-screen), DevCamera
  components/              TopBar/AppShell, CameraTile, ControlPanel, HealthBadges, AddCameraModal, VideoView, Modal
  realtime/                useHomeRoom (LiveKit viewer), useCameras, quality (simulcast layers), capture (snapshot/record), types
  styles.css               dark dashboard styling
```
