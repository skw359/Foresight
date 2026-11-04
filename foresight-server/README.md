# foresight-server

The Foresight Security backend: accounts, Homes, cameras, QR pairing, LiveKit
token minting, and webhooks. Node + TypeScript (ESM), Fastify, Prisma + SQLite.
Runs on **Linux, macOS, or Windows — no Docker, no manual native build**
(the native deps ship prebuilt binaries).

See [`../shared/PROTOCOL.md`](../shared/PROTOCOL.md) for the API contract.

## Host platforms

Runs on **Linux, macOS or Windows**. It is pure Node — **no Docker, no build
toolchain required**:

- The native dependencies (`better-sqlite3`, `argon2`) ship **prebuilt
  binaries** and fetch the right one at `npm install` time, so there is no
  `node-gyp`, no Visual Studio Build Tools and no `build-essential`. (Only if a
  prebuild were missing for your exact Node version would it compile from
  source.)
- All npm scripts are cross-platform (`tsx`/`tsc`/`prisma`/`vitest`) — no
  bash-only tooling. Paths are resolved with `node:path`.
- To create the env file: `cp .env.example .env` (Windows: `copy .env.example .env`).
- LiveKit: `./infra/run-local.sh` (Windows: `infra\run-local.ps1`) — a native
  binary, no Docker.

`package-lock.json` carries the optional native packages for **linux-x64,
darwin-arm64 and win32-x64**, so a checkout installs on any of the three. If you
add a platform (e.g. `linux-arm64`), its `@esbuild/*`, `@rolldown/binding-*` and
`lightningcss-*` entries need to be in the lockfile or `npm install` will
silently skip them and the build will fail with a missing `.node` binding.

Running it as a systemd service on Ubuntu: see
[`../infra/UBUNTU-SETUP.md`](../infra/UBUNTU-SETUP.md).

## Setup

From the **repo root** (the npm workspace installs all packages and builds the
shared contract):

```bash
npm install
npm run build:contract
```

Then, in this folder:

```bash
cp .env.example .env          # adjust if needed (Windows: copy .env.example .env)
npm run prisma:generate       # generate the Prisma client
npm run prisma:migrate        # create dev.db from migrations
```

## Run

```bash
npm run dev                   # tsx watch on http://localhost:3199 (binds 0.0.0.0 for LAN)
# or
npm run build && npm start    # compiled
```

LiveKit must be running for live media/tokens to connect — see
[`../infra/README.md`](../infra/README.md). The backend itself only *mints*
tokens and *receives* webhooks; it never opens a media socket, so it boots fine
without LiveKit (token endpoints still work; clients just can't connect to a
room until LiveKit is up).

## Test

```bash
npm test                      # vitest — full API flow against an isolated temp DB
```

The tests use Fastify `inject()` (no network) and a throwaway SQLite file, so
they need neither a running server nor LiveKit.

## Configuration (`.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3199` | HTTP port |
| `DATABASE_URL` | `file:./dev.db` | SQLite location (relative to project root) |
| `JWT_SECRET` | — | signs user session JWTs |
| `LIVEKIT_URL` | `ws://localhost:7880` | LiveKit URL the server knows (loopback is fine here) |
| `LIVEKIT_PUBLIC_URL` | falls back to `LIVEKIT_URL` | Device-reachable LiveKit URL advertised in pairing tickets + `/rt/token`. Set to the LiveKit server's LAN address (e.g. `http://192.168.1.20:7880`); `localhost` is the phone itself, not the server |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | must match `infra/livekit.yaml` |
| `PUBLIC_SERVER_URL` | `http://localhost:3199` | OPTIONAL fallback for the QR pairing base URL. Overridden by the dashboard Settings value and by per-request auto-detection; set only to pin a fixed default. Must be a phone-reachable LAN IP, not localhost |
| `RECORDER_URL` | `http://127.0.0.1:3399` | `foresight-recorder`'s loopback control API |
| `RECORDER_SHARED_SECRET` | — | Sent on every server↔recorder call. Unset disables server→recorder calls (the recorder still self-reconciles) |
| `RECORDINGS_DIR` | `<project>/recordings` | Root of the HLS segment tree. **Must be the same absolute path as the recorder's** — if the two disagree every playlist is empty (hls.js `levelEmptyError`) while the recorder writes happily |
| `FFMPEG_PATH` | `ffmpeg` | Only used to remux clip downloads. Resolved on PATH when bare; with no system ffmpeg, point it at `../foresight-recorder/bin/ffmpeg` (`.exe` on Windows) — but smoke-test that binary's **demux** path first, since this route pipes MPEG-TS into its stdin (see `foresight-recorder/bin/README.md`) |

Note `LIVEKIT_PUBLIC_URL` and `PUBLIC_SERVER_URL` should share a scheme: a page
served over `https://` cannot open a `ws://` socket (mixed content), so pairing a
public HTTPS origin with a plain-`ws` LiveKit breaks video in the browser.

## Console output

On a terminal the server prints a coral boot banner and aligned, colored log
lines — one per completed request, with method, path, status and duration in
fixed columns (see `src/console.ts` and `src/logging.ts`). Redirect stdout to a
file or a pipe and pino's stock JSON goes out untouched. `foresight-recorder`
shares the same renderer.

| Var | Effect |
| --- | --- |
| `LOG_LEVEL` | pino level, default `info` (`/health` requests log at `debug`) |
| `LOG_PRETTY` | `1` forces human output, `0` forces JSON; unset = detect a TTY |
| `NO_COLOR` | any value drops all ANSI (no-color.org convention) |
| `FORESIGHT_LOG_COLOR` | `off` / `256` / `full` to pin the color depth |
| `FORESIGHT_LOG_ASCII` | `1` swaps box-drawing and glyphs for ASCII |

## Layout

```
src/
  index.ts          entrypoint (listen on 0.0.0.0)
  app.ts            Fastify app factory (CORS, error handler, webhook raw-body, routes)
  console.ts        terminal theme (banner + line renderer); mirrored in foresight-recorder
  logging.ts        pino -> console.ts bridge, active only on a TTY
  config.ts         env config
  db.ts             PrismaClient + better-sqlite3 adapter
  auth.ts           argon2 hashing, session JWTs, requireUser preHandler
  livekit.ts        AccessToken minting + WebhookReceiver
  lib/              errors, dto mappers, membership guards, zod validation
  routes/           auth, homes, cameras, pairing, rt (token), webhooks
test/api.test.ts    end-to-end API tests
```
