#!/usr/bin/env bash
# rtl-mini — down.sh

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.pid"

log() { echo "[rtl-mini/down.sh] $*" >&2; }

if [ ! -f "$PID_FILE" ]; then
  log "No PID file — nothing to stop."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  log "Stopping (pid $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 2
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
log "Done."
