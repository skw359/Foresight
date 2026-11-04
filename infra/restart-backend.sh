#!/usr/bin/env bash
# Foresight Security — restart ONLY the backend + recorder, leaving the LiveKit
# SFU running so connected cameras keep their media sessions and phones do not
# have to renegotiate. Use this for a code or .env change in foresight-server /
# foresight-recorder; use restart-foresight.sh when LiveKit itself needs a kick.
#
# Thin wrapper: all the logic lives in restart-foresight.sh.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/restart-foresight.sh" --backend "$@"
