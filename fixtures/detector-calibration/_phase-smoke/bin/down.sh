#!/usr/bin/env bash
# _phase-smoke fixture — down.sh
# Stops the phase-smoke server booted by up.sh.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.pid"

log() { echo "[_phase-smoke/down.sh] $*" >&2; }

if [ ! -f "$PID_FILE" ]; then
  log "No PID file at $PID_FILE — nothing to stop."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if [ -z "$PID" ]; then
  log "PID file empty — nothing to stop."
  rm -f "$PID_FILE"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  log "Stopping phase-smoke server (pid $PID)..."
  kill "$PID" 2>/dev/null || true
  sleep 2
  if kill -0 "$PID" 2>/dev/null; then
    log "Force-killing (pid $PID)..."
    kill -9 "$PID" 2>/dev/null || true
  fi
else
  log "Process $PID already stopped."
fi

rm -f "$PID_FILE"
log "Done."
