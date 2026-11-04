# infra — local LiveKit (no Docker required)

LiveKit is the WebRTC media server. It ships native binaries; **Docker is only
one option, never required.**

## Install

| OS | Install |
| --- | --- |
| **Linux** | `curl -sSL https://get.livekit.io \| bash` (installs to `/usr/local/bin`, needs sudo) |
| **Linux, no root** | Grab `livekit_<ver>_linux_amd64.tar.gz` from the [releases page](https://github.com/livekit/livekit/releases) and extract `livekit-server` into `~/.local/bin`. `run-local.sh` looks there even when it is not on your PATH. |
| **macOS** | `brew install livekit` |
| **Windows** | Download `livekit_<ver>_windows_amd64.zip` from the [releases page](https://github.com/livekit/livekit/releases), unzip, put `livekit-server.exe` on your PATH. |

## Run

`infra/livekit.yaml` holds the real API secret, so it is not committed. Create it
from the template first: `cp infra/livekit.example.yaml infra/livekit.yaml`.

```bash
# Linux / macOS
./infra/run-local.sh
```
```powershell
# Windows
.\infra\run-local.ps1
```

Either way LiveKit listens on `ws://localhost:7880` (and your LAN IP), using the
API key/secret in `infra/livekit.yaml` — these **must** match `foresight-server`'s
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.

## Connecting devices

iPhones and other clients on the same network connect to **`ws://<host-LAN-IP>:7880`**.
The run scripts print the host's LAN IP. Find it manually with:
- Linux: `hostname -I` (or `ip -4 route get 1.1.1.1`)
- macOS: `ipconfig getifaddr en0`
- Windows: `ipconfig`

That address goes in `foresight-server/.env` as `LIVEKIT_PUBLIC_URL`. It is a
**DHCP lease** — if the host's IP changes, update that value (and
`PUBLIC_SERVER_URL`) or pairing tickets will point somewhere dead. A static
lease/reservation on the router avoids the whole problem.

## Running it as a service (Linux)

`systemd/install-user-units.sh` generates **user** units for LiveKit, the backend
and the recorder — see [`UBUNTU-SETUP.md`](./UBUNTU-SETUP.md).

## Going remote ("view from anywhere")

Two options, both configuration-only:

- **LiveKit Cloud** (free tier, includes TURN): set `LIVEKIT_URL`,
  `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in `foresight-server/.env` to your
  Cloud project values.
- **Self-hosted behind TLS**: keep this LiveKit and put a reverse proxy in front
  of the signaling socket — see [`TLS-SETUP.md`](./TLS-SETUP.md) for the nginx
  and Caddy configs that ship here.
