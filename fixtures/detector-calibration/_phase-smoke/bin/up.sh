#!/usr/bin/env bash
# _phase-smoke fixture — up.sh
# Boots a minimal Express server that emits deterministic markers for each
# BugHunter phase. Used by Tier 2 of the tiered self-test runner.
#
# V56.1: Infrastructure scaffold. Full phase-smoke app wires in V56.2 follow-up.
# See: docs/specs/V56_PER_DETECTOR_HARNESS.md §8.3
#
# DO NOT deploy this fixture to any public network.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$FIXTURE_ROOT/.pid"
PORT=9960

log() { echo "[_phase-smoke/up.sh] $*" >&2; }

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

# V56.1 placeholder: the phase-smoke app doesn't exist yet.
# V56.2 will add app/server.js that responds to phase probe requests
# with deterministic markers (one per BugHunter phase).
if [ ! -f "$FIXTURE_ROOT/app/server.js" ]; then
  log "Phase-smoke app not yet created (V56.2 ships this)."
  log "Creating a temporary stub server for infrastructure validation..."

  # Write a minimal stub so up.sh succeeds without crashing
  cat > /tmp/_phase-smoke-stub.js << 'EOF'
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ phase: 'stub', marker: 'v56.1-infrastructure-only' }));
});
server.listen(9960, '127.0.0.1', () => {
  process.stderr.write('[_phase-smoke] Stub server listening on 127.0.0.1:9960\n');
});
EOF
  node /tmp/_phase-smoke-stub.js &
  STUB_PID=$!
  echo "$STUB_PID" > "$PID_FILE"
  wait_for_port "$PORT" "_phase-smoke-stub"
  log "Stub server up (pid $STUB_PID). Replace with real app in V56.2."
  exit 0
fi

cd "$FIXTURE_ROOT/app"
node server.js &
APP_PID=$!
echo "$APP_PID" > "$PID_FILE"
wait_for_port "$PORT" "_phase-smoke"
log "Phase-smoke app up (pid $APP_PID)"
