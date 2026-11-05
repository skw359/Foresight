#!/usr/bin/env bash
# Foresight Security — restart the systemd *user* services on this box.
#
#   ./infra/restart-foresight.sh            # everything: LiveKit + backend + recorder
#   ./infra/restart-foresight.sh --backend  # backend + recorder only, leaving the SFU up
#
# Stops in reverse dependency order, then starts in forward order and waits for
# each service to actually ANSWER. `systemctl start` returning only means the
# process was spawned, which is not the same as "listening" — the recorder in
# particular blocks in ExecStartPre until the recordings volume is mounted.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BACKEND_ONLY=0
case "${1:-}" in
  "")                     ;;
  --backend|--backend-only) BACKEND_ONLY=1 ;;
  -h|--help)              sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *)                      echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
esac

# Start order; stopping walks it backwards. LiveKit leads because the backend's
# webhook and the recorder's hidden subscriber both hang off it.
if [ "$BACKEND_ONLY" = 1 ]; then
  UNITS=(foresight-server.service foresight-recorder.service)
else
  UNITS=(livekit.service foresight-server.service foresight-recorder.service)
fi

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; Z=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; Z=""
fi
say() { printf '\n%s==> %s%s\n' "$B" "$*" "$Z"; }
ok()  { printf '    %s✓%s %s\n' "$G" "$Z" "$*"; }
bad() { printf '    %s✗%s %s\n' "$R" "$Z" "$*"; }
note(){ printf '    %s•%s %s\n' "$Y" "$Z" "$*"; }

REC_SECRET="$(sed -n 's/^RECORDER_SHARED_SECRET=//p' "$REPO/foresight-recorder/.env" 2>/dev/null | head -1)"

probe_livekit()          { timeout 2 bash -c ': >/dev/tcp/127.0.0.1/7880'; }
probe_foresight_server() { curl -fsS -m 3 -o /dev/null http://127.0.0.1:3199/health; }
probe_foresight_recorder() {
  [ -n "$REC_SECRET" ] || return 0   # can't authenticate; unit state is all we have
  curl -fsS -m 3 -o /dev/null -H "x-recorder-secret: $REC_SECRET" http://127.0.0.1:3399/status
}

# wait_for <seconds> <label> <cmd...>
wait_for() {
  local timeout="$1" label="$2"; shift 2
  local deadline=$(( SECONDS + timeout ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then ok "$label"; return 0; fi
    sleep 1
  done
  bad "$label — no response after ${timeout}s"
  return 1
}

LABEL=""; [ "$BACKEND_ONLY" = 1 ] && LABEL=" (backend only — leaving LiveKit up)"
say "Stopping$LABEL"
for (( i=${#UNITS[@]} - 1; i >= 0; i-- )); do
  u="${UNITS[$i]}"
  [ "$u" = livekit.service ] && note "livekit drains sessions — this takes a few seconds"
  printf '    stopping %-28s' "$u"
  if systemctl --user stop "$u"; then printf '%s✓%s\n' "$G" "$Z"; else printf '%s✗%s\n' "$R" "$Z"; fi
done

# A unit SIGKILLed at TimeoutStopSec stays `failed`, which makes the next status
# read look alarming even though the restart is fine. Clear it before starting.
systemctl --user reset-failed "${UNITS[@]}" 2>/dev/null || true

say "Starting"
rc=0
for u in "${UNITS[@]}"; do
  printf '    starting %-28s' "$u"
  if systemctl --user start "$u"; then printf '%s✓%s\n' "$G" "$Z"; else printf '%s✗%s\n' "$R" "$Z"; rc=1; fi
done

say "Waiting for services to answer"
for u in "${UNITS[@]}"; do
  case "$u" in
    livekit.service)            wait_for 20 "livekit        :7880"     probe_livekit            || rc=1 ;;
    foresight-server.service)   wait_for 30 "backend        :3199/health"  probe_foresight_server   || rc=1 ;;
    foresight-recorder.service) wait_for 90 "recorder       :3399/status" probe_foresight_recorder || rc=1 ;;
  esac
done

say "Status"
for u in "${UNITS[@]}"; do
  state="$(systemctl --user is-active "$u" || true)"
  if [ "$state" = active ]; then ok "$(printf '%-28s %s' "$u" "$state")"
  else bad "$(printf '%-28s %s' "$u" "$state")"; rc=1; fi
done

RECDIR="$(sed -n 's/^RECORDINGS_DIR=//p' "$REPO/foresight-recorder/.env" 2>/dev/null | head -1)"
if [ -n "$RECDIR" ]; then
  printf '\n    recordings : %s\n' "$RECDIR"
  df -h "$RECDIR" 2>/dev/null | tail -1 | awk '{printf "    volume     : %s  %s used of %s (%s free)\n", $1, $3, $2, $4}'
fi

if [ "$rc" -ne 0 ]; then
  say "Something did not come up — recent logs"
  for u in "${UNITS[@]}"; do
    [ "$(systemctl --user is-active "$u" || true)" = active ] && continue
    printf '\n--- %s ---\n' "$u"
    journalctl --user -u "$u" -n 15 --no-pager 2>/dev/null || true
  done
  echo
  exit 1
fi

printf '\n%sAll services up.%s\n\n' "$G" "$Z"
