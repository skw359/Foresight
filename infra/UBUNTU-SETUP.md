# Foresight on Ubuntu

The backend, the recorder, LiveKit and the dashboard all run natively on Ubuntu
— no Docker, no build toolchain. Only the two Swift apps still need macOS/Xcode.

This box is set up as described below (Ubuntu 26.04, Node 24).

## 1. Dependencies

```bash
npm install                 # from the repo root (workspaces)
npm run build:contract
```

Node **20+** is required; nothing else is built from source (`better-sqlite3`,
`argon2`, `sodium-native` and `@livekit/rtc-node` all ship prebuilt binaries).

> **Lockfile note.** `package-lock.json` must carry the `linux-x64` variants of
> `@esbuild/*`, `@rolldown/binding-*` and `lightningcss-*`. Without them `npm
> install` exits 0 but silently installs no native binding, and the first
> `vite`/`vitest` run dies with `Cannot find module '../rolldown-binding.linux-x64-gnu.node'`.
> The lockfile here holds linux-x64, darwin-arm64 and win32-x64 together, so the
> same checkout installs on all three.

### ffmpeg

Either a system install:

```bash
sudo apt install ffmpeg
```

This box uses the distro build, and both `.env` files set `FFMPEG_PATH=ffmpeg`
(`/usr/bin` is on the systemd user units' PATH, so the bare name resolves).

A static build in the recorder's `bin/` is the no-root fallback
(see [`../foresight-recorder/bin/README.md`](../foresight-recorder/bin/README.md)),
but **verify any static build before relying on it**. The johnvansickle 7.0.2
amd64 build that shipped here segfaults (SIGSEGV, exit 139) on *any* demux on
this host — `ffprobe <file>`, or `ffmpeg -f mpegts -i pipe:0`, even on a file it
had just written itself. It encodes fine from a raw pipe, so **recording worked
and hid the fault**; what broke was the server's `clip.mp4` route, which remuxes
by piping segment bytes into ffmpeg's stdin and so returned 0 bytes every time.
Smoke-test both directions after dropping a binary in `bin/`:

```bash
./bin/ffmpeg -hide_banner -encoders | grep 264          # encoders present?
./bin/ffmpeg -f lavfi -i testsrc=size=320x240:rate=30 -t 2 -c:v libx264 -y /tmp/t.ts
./bin/ffprobe /tmp/t.ts                                 # MUST NOT segfault
```

With `FFMPEG_PATH` unset the recorder finds `bin/ffmpeg` on its own. The server
needs it too (clip downloads only) and does **not** search `bin/`, so set
`FFMPEG_PATH` in `foresight-server/.env` when there is no system ffmpeg.

### LiveKit

```bash
curl -sSL https://get.livekit.io | bash          # /usr/local/bin, needs sudo
```

Or without root, extract `livekit-server` from the
[release tarball](https://github.com/livekit/livekit/releases) into `~/.local/bin`
— `infra/run-local.sh` and the systemd unit both look there.

## 2. Configure

```bash
cp foresight-server/.env.example   foresight-server/.env
cp foresight-recorder/.env.example foresight-recorder/.env
cp infra/livekit.example.yaml      infra/livekit.yaml
chmod 600 foresight-server/.env foresight-recorder/.env infra/livekit.yaml
```

Then edit all three. **Generate every secret** — the server and recorder refuse
to start on an empty, short or template value:

```bash
openssl rand -hex 32   # run once per secret
```

| Setting | Why |
| --- | --- |
| `JWT_SECRET` (server) | Signs session tokens. Anyone who knows it can sign in as any user. |
| `LIVEKIT_API_KEY` / `_SECRET` (server, recorder, `infra/livekit.yaml` `keys:`) | The same generated pair in all three. With the public `devkey`/`secret` pair anyone could join any Home room, watch cameras and talk through them. |
| `RECORDER_SHARED_SECRET` (server, recorder) | The same generated value in both. |
| `SERVER_URL` (recorder) | `http://127.0.0.1:3198` — the server's loopback-only internal API (`INTERNAL_PORT`), not port 3199. |
| `RECORDINGS_DIR` | Same **absolute** POSIX path in both files. A leftover `E:\...` resolves to a literal directory of that name under the project root. On this host it points at the 1TB HDD — see Gotchas. |
| `LIVEKIT_PUBLIC_URL` | This host's LAN IP, not `localhost` — `localhost` is the *phone*. Get it with `hostname -I`. |
| `PUBLIC_SERVER_URL` | Same scheme as `LIVEKIT_PUBLIC_URL` (see the mixed-content note in the server README). |
| `FFMPEG_PATH` | Only needed where ffmpeg is not on PATH. |

Both `LIVEKIT_PUBLIC_URL` and `PUBLIC_SERVER_URL` embed a **DHCP address**. If
the lease changes, update them — or reserve the IP on the router.

Then set up the database and build:

```bash
cd foresight-server && npm run prisma:generate && npm run prisma:deploy && cd ..
npm run build:web
npm run build:recorder
```

`prisma:deploy` (`prisma migrate deploy`) only applies pending migrations.
Never use `prisma:migrate` (`migrate dev`) on a real database — on schema drift
it offers to reset it. The systemd unit runs `migrate deploy` before every
start, so after a `git pull` you only rebuild and restart.

**The first account you register becomes the server administrator.** After
that, registration is closed until the admin opens it (dashboard → Settings →
General → *Allow new accounts*), or set `ALLOW_REGISTRATION=true` in
`foresight-server/.env`. Register yourself right after the first start.

## 3. Run it

By hand, three terminals:

```bash
./infra/run-local.sh      # LiveKit
npm run dev:server
npm run dev:web
```

Or as systemd **user** services:

```bash
./infra/systemd/install-user-units.sh
systemctl --user start livekit foresight-server foresight-recorder
```

That writes `~/.config/systemd/user/{livekit,foresight-server,foresight-recorder}.service`
with absolute paths baked in — **a systemd unit does not read your shell
profile**, so an nvm-managed `node` is invisible to it unless the full path is
written into `ExecStart`. Re-run the script after `nvm install` of a new Node
version, or after moving the repo.

To survive logout and start at boot:

```bash
sudo loginctl enable-linger "$USER"
```

Without lingering the user manager shuts down when your last session ends and
takes all three services with it.

```bash
systemctl --user status foresight-recorder
journalctl --user -u foresight-server -f
```

Logs go to the journal, which is not a TTY, so the services emit their JSON
format rather than the coral banner — `journalctl -o cat -u ... | jq` reads well.

## 4. Firewall

If ufw is enabled, the phones and browsers need:

| Port | Proto | For |
| --- | --- | --- |
| 3199 | TCP | backend + dashboard |
| 7880 | TCP | LiveKit signaling |
| 7881 | TCP | WebRTC over TCP (fallback) |
| 50000–50100 | UDP | WebRTC media (the range in `infra/livekit.yaml`) |

```bash
sudo ufw allow 3199,7880,7881/tcp
sudo ufw allow 50000:50100/udp
```

Ports 3399 (the recorder's control API) and 3198 (the server's internal API
for the recorder) bind loopback only and must **not** be opened.

## Backups

`foresight-server/dev.db` holds every account, Home, camera and every user's
E2EE key vault. Losing it locks everyone out of their encrypted Homes.

`install-user-units.sh` installs `foresight-backup.timer`, which runs
`node scripts/backup-db.mjs` daily: an online SQLite backup (safe while the
server runs), integrity-checked, into `foresight-server/backups/` (override with
`BACKUP_DIR`), keeping the newest 14 (`BACKUP_KEEP`). **Copy the backups off this
machine too** (another disk, a NAS, cloud storage) — a dead SSD takes local
backups with it.

```bash
systemctl --user list-timers foresight-backup.timer
cd foresight-server && node scripts/backup-db.mjs     # on demand
```

To restore: stop `foresight-server`, copy a backup over the database file
(delete any `dev.db-wal` / `dev.db-shm` next to it), start it again. The server
runs SQLite in WAL mode.

## Gotchas

- **Recordings live on the 1TB HDD, not the root SSD.** `/dev/sda1` (ext4,
  `LABEL=foresight-rec`) is mounted at `/mnt/foresight` from `/etc/fstab` by
  UUID, and `RECORDINGS_DIR=/mnt/foresight/recordings`. This replaces the
  Windows host's `E:`. Two things are deliberate:
  - `RECORDINGS_DIR` is a **subdirectory** of the mount, never the mount root.
    ffmpeg runs with `-strftime_mkdir 1`, so it creates whatever tree it is
    pointed at — writing to a bare, unmounted mount point would silently
    recreate the segments on the root SSD and fill it. It also keeps
    `lost+found` out of the tree the server scans.
  - Both user units carry an `ExecStartPre` that waits (up to 60s) for
    `/mnt/foresight` to be a mount point, so they **refuse to run** against a
    missing disk. `RequiresMountsFor=` is unavailable — mount units are
    system-scope, these are *user* units — and `AssertPathIsMountPoint=` is a
    trap here: the fstab entry uses `nofail`, which by design leaves the mount
    **not** ordered `Before=local-fs.target`, so at boot the user manager can
    beat a spinning disk to the punch. An assert fails permanently and is never
    retried, which would leave recording dead after every unlucky reboot; a
    failing `ExecStartPre` is retried by `Restart=always`, so a slow spin-up
    self-heals while an absent disk is still never written to.

  `install-user-units.sh` derives all of this from `/etc/fstab`, so changing
  `RECORDINGS_DIR` and re-running it is enough — it also refuses to `mkdir` the
  tree when its volume is unmounted.
- **Segment buckets are UTC.** ffmpeg is spawned with `TZ=UTC` on purpose; the
  server maps a segment's epoch to its `YYYY/MM/DD` bucket assuming that. Don't
  set `TZ` in the unit files.
- **`dev.db` is portable.** SQLite files move between Windows and Linux as-is;
  the database carried over from the previous host needs no conversion. After
  upgrading, the oldest existing account is made server admin automatically.
- **The phone's battery.** A camera phone sits on its charger 24/7: turn on
  *Optimized Battery Charging* (or the 80 % limit on newer iPhones) to slow
  battery wear, and keep it somewhere it can shed heat. The camera app already
  steps quality down when the phone gets hot.
