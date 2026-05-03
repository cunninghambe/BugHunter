#!/usr/bin/env bash
# BugHunter self-test fixture coordinator — stop all sub-fixtures.
# Reads .fixture-pids written by up.sh and sends SIGTERM to each process group.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.fixture-pids"

log() { echo "[down.sh] $*" >&2; }

if [ ! -f "$PID_FILE" ]; then
  log "No PID file found at $PID_FILE — nothing to stop."
  exit 0
fi

while IFS=' ' read -r name pid; do
  if [ -z "$pid" ]; then continue; fi
  if kill -0 "$pid" 2>/dev/null; then
    log "Stopping $name (pid $pid)..."
    kill "$pid" 2>/dev/null || true
  else
    log "$name (pid $pid) already stopped."
  fi
done < "$PID_FILE"

# Give processes up to 5s to exit gracefully, then SIGKILL stragglers.
sleep 5

while IFS=' ' read -r name pid; do
  if [ -z "$pid" ]; then continue; fi
  if kill -0 "$pid" 2>/dev/null; then
    log "Force-killing $name (pid $pid)..."
    kill -9 "$pid" 2>/dev/null || true
  fi
done < "$PID_FILE"

rm -f "$PID_FILE"
log "All fixtures stopped."
