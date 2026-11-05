#!/usr/bin/env bash
# Foresight Security — start the local LiveKit dev server (Linux / macOS).
#
# Install livekit-server first (no Docker needed):
#   Ubuntu/Debian : curl -sSL https://get.livekit.io | bash        (writes /usr/local/bin, needs sudo)
#                   ...or, without root, drop the release binary in ~/.local/bin:
#                   see infra/README.md
#   macOS         : brew install livekit
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A no-root install commonly lands here and is not always on a non-login PATH.
if ! command -v livekit-server >/dev/null 2>&1 && [ -x "$HOME/.local/bin/livekit-server" ]; then
  PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v livekit-server >/dev/null 2>&1; then
  cat >&2 <<'MSG'
livekit-server not found. Install it with one of:
  Ubuntu/Debian : curl -sSL https://get.livekit.io | bash
  macOS         : brew install livekit
Or put the release binary from https://github.com/livekit/livekit/releases
on your PATH (e.g. ~/.local/bin/livekit-server).
MSG
  exit 1
fi

# The LAN address to hand to phones/browsers. `ip route get` asks the kernel
# which source address it would actually use to leave this box — correct even
# with several interfaces — and the rest are fallbacks for macOS and for hosts
# without iproute2.
lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then   # macOS
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [ -n "$ip" ] || return 1
  printf '%s\n' "$ip"
}

if [ ! -f "$DIR/livekit.yaml" ]; then
  echo "infra/livekit.yaml missing — create it: cp infra/livekit.example.yaml infra/livekit.yaml" >&2
  echo "and replace the placeholder key secret with: openssl rand -hex 32" >&2
  exit 1
fi
if grep -q "REPLACE_WITH_OUTPUT_OF_openssl_rand_hex_32\|devkey: secret" "$DIR/livekit.yaml"; then
  echo "infra/livekit.yaml still has a template API secret — replace it with: openssl rand -hex 32" >&2
  exit 1
fi

IP="$(lan_ip || true)"
echo "Point your iPhones / clients at:  ws://${IP:-<LAN-IP>}:7880"
if [ -z "$IP" ]; then
  echo "  (could not detect a LAN IP — check: ip -4 addr | grep inet)"
fi
echo

exec livekit-server --config "$DIR/livekit.yaml"
