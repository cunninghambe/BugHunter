#!/usr/bin/env bash
# agent-runner-mini — down.sh
set -euo pipefail
FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.pid"
log() { echo "[agent-runner-mini/down.sh] $*" >&2; }
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" && log "Killed pid $PID"; fi
  rm -f "$PID_FILE"
else
  log "No PID file found — nothing to stop"
fi
