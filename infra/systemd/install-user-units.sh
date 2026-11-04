#!/usr/bin/env bash
# Foresight Security — install systemd *user* units for this box.
#
# Generates ~/.config/systemd/user/{livekit,foresight-server,foresight-recorder}
# .service with absolute paths baked in, because a systemd unit does not read
# your shell profile: an nvm- or fnm-managed `node` is invisible to it unless the
# full path is written into ExecStart.
#
#   ./infra/systemd/install-user-units.sh          # write units + enable
#   ./infra/systemd/install-user-units.sh --no-enable
#
# Re-run this after `nvm install` of a new Node version, or after moving the
# repo — both invalidate the baked paths.
set -euo pipefail

ENABLE=1
[ "${1:-}" = "--no-enable" ] && ENABLE=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"

die() { echo "error: $*" >&2; exit 1; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found on PATH."
NODE="$(readlink -f "$NODE")"

LIVEKIT="$(command -v livekit-server || true)"
[ -n "$LIVEKIT" ] && LIVEKIT="$(readlink -f "$LIVEKIT")"
[ -z "$LIVEKIT" ] && [ -x "$HOME/.local/bin/livekit-server" ] && LIVEKIT="$HOME/.local/bin/livekit-server"

for f in foresight-server/dist/index.js foresight-recorder/dist/index.js; do
  [ -f "$REPO/$f" ] || die "$f missing — run 'npm run build:web && npm run build:recorder' first."
done
for f in foresight-server/.env foresight-recorder/.env; do
  [ -f "$REPO/$f" ] || die "$f missing — copy it from $f.example."
done

# The recorder refuses to start if this does not exist; create it now rather
# than letting the unit crash-loop.
RECDIR="$(grep -E '^RECORDINGS_DIR=' "$REPO/foresight-recorder/.env" | head -1 | cut -d= -f2-)"

# Which filesystem should back RECORDINGS_DIR? We read /etc/fstab rather than
# the live mount table so that a data volume that is *currently unmounted* is
# still recognised --- that is precisely the case we must not mkdir over, since
# creating the tree would shadow the mount point. ffmpeg runs with
# -strftime_mkdir 1, so a missing disk does NOT fail loudly on its own: it would
# quietly refill the root filesystem instead.
#
# Longest fstab mount point containing RECDIR; empty means the plain root fs.
RECMOUNT=""
if [ -n "$RECDIR" ]; then
  while read -r _src tgt _rest; do
    [ -z "${tgt:-}" ] && continue
    [ "$tgt" = "/" ] && continue
    case "$RECDIR/" in
      "$tgt"/*) [ "${#tgt}" -gt "${#RECMOUNT}" ] && RECMOUNT="$tgt" ;;
    esac
  done < <(grep -vE '^[[:space:]]*(#|$)' /etc/fstab 2>/dev/null || true)
fi

if [ -n "$RECDIR" ] && [ ! -d "$RECDIR" ]; then
  if [ -n "$RECMOUNT" ] && ! mountpoint -q "$RECMOUNT"; then
    die "RECORDINGS_DIR=$RECDIR is missing and its volume ($RECMOUNT) is not mounted — run: sudo mount $RECMOUNT"
  fi
  echo "creating recordings dir: $RECDIR"
  mkdir -p "$RECDIR"
fi

# Guard: never start a unit that touches the recordings tree while its volume is
# unmounted (ffmpeg's -strftime_mkdir 1 would refill the root filesystem).
#
# Why ExecStartPre and not AssertPathIsMountPoint=: an fstab entry with `nofail`
# is deliberately NOT ordered Before=local-fs.target, so at boot the user
# manager can reach these units before a spinning disk has finished mounting.
# An Assert fails *permanently* --- it is not retried by Restart= --- which would
# leave recording dead after a reboot until someone started it by hand. A
# bounded wait fails the unit instead, and Restart=always retries it, so a slow
# spin-up self-heals while a genuinely absent disk still never gets written to.
# (RequiresMountsFor=, the natural answer, is unavailable: mount units are
# system-scope and these are *user* units.)
MOUNTGUARD=""
if [ -n "$RECMOUNT" ]; then
  MOUNTGUARD="ExecStartPre=/usr/bin/timeout 60 /bin/sh -c 'until /usr/bin/mountpoint -q \"$RECMOUNT\"; do sleep 2; done'"
  echo "recordings volume: $RECMOUNT (units will wait for it to be mounted)"
fi

mkdir -p "$UNIT_DIR"

# NOTE: no network-online.target ordering — nothing activates that target in a
# *user* manager. Restart=always is what actually covers "started before the
# LAN was up"; each service retries until its dependency answers.
if [ -n "$LIVEKIT" ]; then
  cat > "$UNIT_DIR/livekit.service" <<UNIT
[Unit]
Description=LiveKit SFU (Foresight Security)
Documentation=file://$REPO/infra/README.md

[Service]
Type=simple
ExecStart=$LIVEKIT --config $REPO/infra/livekit.yaml
Restart=always
RestartSec=3
# LiveKit drains active sessions on the first interrupt and only force-quits on
# the second --- the same "press Ctrl-C twice" you do in a terminal. With cameras
# connected the room never empties, so a single SIGTERM hangs until
# TimeoutStopSec and then dies by SIGKILL, leaving the unit in a failed state.
# Send the pair ourselves: a restart takes ~3s and exits 0. TimeoutStopSec is
# the backstop if even the second interrupt is ignored.
KillSignal=SIGINT
ExecStop=/bin/sh -c 'kill -INT \${MAINPID} 2>/dev/null || true; sleep 3; kill -INT \${MAINPID} 2>/dev/null || true'
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT
  echo "wrote $UNIT_DIR/livekit.service"
else
  echo "note: livekit-server not found — skipping livekit.service." >&2
  echo "      install it (see infra/README.md), then re-run this script." >&2
fi

cat > "$UNIT_DIR/foresight-server.service" <<UNIT
[Unit]
Description=Foresight Security backend (Fastify + Prisma/SQLite)
Documentation=file://$REPO/foresight-server/README.md
After=livekit.service
Wants=livekit.service

[Service]
Type=simple
# dotenv reads .env relative to the working directory, so this must be the
# package root, not the repo root.
WorkingDirectory=$REPO/foresight-server
$MOUNTGUARD
ExecStart=$NODE dist/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT
echo "wrote $UNIT_DIR/foresight-server.service"

cat > "$UNIT_DIR/foresight-recorder.service" <<UNIT
[Unit]
Description=Foresight Security 24/7 recorder (LiveKit -> HLS)
Documentation=file://$REPO/foresight-recorder/README.md
After=foresight-server.service livekit.service
Wants=foresight-server.service livekit.service

[Service]
Type=simple
WorkingDirectory=$REPO/foresight-recorder
$MOUNTGUARD
ExecStart=$NODE dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT
echo "wrote $UNIT_DIR/foresight-recorder.service"

systemctl --user daemon-reload

if [ "$ENABLE" = "1" ]; then
  UNITS="foresight-server.service foresight-recorder.service"
  [ -n "$LIVEKIT" ] && UNITS="livekit.service $UNITS"
  # shellcheck disable=SC2086
  systemctl --user enable $UNITS
  echo
  echo "Enabled: $UNITS"
  echo "Start them with:  systemctl --user start $UNITS"
fi

echo
if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  cat <<MSG
NOTE: lingering is OFF, so these services stop when you log out and do NOT
start at boot. To make them true always-on services, run once (needs root):

  sudo loginctl enable-linger $USER

MSG
fi
echo "Logs:   journalctl --user -u foresight-server -f"
echo "Status: systemctl --user status foresight-recorder"
