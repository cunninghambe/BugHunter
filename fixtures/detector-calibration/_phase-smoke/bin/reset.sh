#!/usr/bin/env bash
# _phase-smoke fixture — reset.sh
# Resets the phase-smoke server to a clean state via its HTTP reset endpoint.
# V56.1: stub (server doesn't exist yet). V56.2 wires actual reset.

set -euo pipefail

PORT=9960

log() { echo "[_phase-smoke/reset.sh] $*" >&2; }

if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  log "Server not running on port $PORT — nothing to reset."
  exit 0
fi

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  log "Reset endpoint returned error (V56.2+ required for real reset)."
}

log "Reset done."
