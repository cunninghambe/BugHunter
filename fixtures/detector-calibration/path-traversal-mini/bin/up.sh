#!/usr/bin/env bash
# path-traversal-mini — up.sh
# INTENTIONALLY VULNERABLE fixture for path_traversal detector calibration.
# DO NOT DEPLOY to any public network.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.pid"
PORT=9972

log() { echo "[path-traversal-mini/up.sh] $*" >&2; }

_cleanup() {
  log "Signal received — running down.sh..."
  bash "$(dirname "${BASH_SOURCE[0]}")/down.sh" || true
}
trap _cleanup INT TERM

check_port_free() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
      log "ERROR: port $port is already in use (EC-4)."
      exit 2
    fi
  fi
}

wait_for_port() {
  local port="$1"
  local name="$2"
  local retries=30
  while ! nc -z 127.0.0.1 "$port" &>/dev/null 2>&1; do
    retries=$((retries - 1))
    if [ "$retries" -eq 0 ]; then
      log "ERROR: $name (port $port) did not come up in time."
      exit 2
    fi
    sleep 1
  done
  log "$name ready on port $port"
}

check_port_free "$PORT"

PORT="$PORT" node "$FIXTURE_ROOT/app/server.js" &
APP_PID=$!
echo "$APP_PID" > "$PID_FILE"
wait_for_port "$PORT" "path-traversal-mini"
log "App up (pid $APP_PID)"
