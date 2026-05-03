#!/usr/bin/env bash
# BugHunter self-test fixture coordinator — start all sub-fixtures.
# Reads reuse-manifest.json and boots the referenced sub-fixtures on their ports.
# EC-4: checks for port conflicts before starting.
# DO NOT DEPLOY this fixture to any public network.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$FIXTURE_ROOT/../.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/fixtures"
PID_FILE="$FIXTURE_ROOT/.fixture-pids"

log() { echo "[up.sh] $*" >&2; }

_cleanup() {
  log "Signal received — running down.sh..."
  bash "$(dirname "${BASH_SOURCE[0]}")/down.sh" || true
}
trap _cleanup INT TERM

check_port_free() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; then
      log "ERROR: port $port is already in use. Aborting (EC-4)."
      exit 2
    fi
  fi
}

wait_for_port() {
  local port="$1"
  local name="$2"
  local retries=30
  while ! nc -z 127.0.0.1 "$port" &>/dev/null && ! nc -z ::1 "$port" &>/dev/null; do
    retries=$((retries - 1))
    if [ "$retries" -eq 0 ]; then
      log "ERROR: $name (port $port) did not come up in time."
      exit 2
    fi
    sleep 1
  done
  log "$name ready on port $port"
}

> "$PID_FILE"

# ---- race-bad (port 9994) ----
check_port_free 9994
log "Starting race-bad on port 9994..."
RACE_BAD_PORT=9994 node "$FIXTURES_DIR/race-bad/server.js" &>"$FIXTURE_ROOT/.race-bad.log" &
echo "race-bad $!" >> "$PID_FILE"

# ---- idor-bad (port 4090) ----
check_port_free 4090
log "Starting idor-bad on port 4090..."
PORT=4090 node "$FIXTURES_DIR/idor-bad/server.js" &>"$FIXTURE_ROOT/.idor-bad.log" &
echo "idor-bad $!" >> "$PID_FILE"

# ---- v24-deferred-bugs (port 5780) ----
check_port_free 5780
log "Starting v24-deferred-bugs on port 5780..."
(cd "$FIXTURES_DIR/v24-deferred-bugs" && npm run dev -- --port 5780 &>"$FIXTURE_ROOT/.v24.log") &
echo "v24-deferred-bugs $!" >> "$PID_FILE"

# ---- a11y-bad static (port 5781) ----
check_port_free 5781
log "Starting a11y-bad static server on port 5781..."
(cd "$FIXTURES_DIR/a11y-bad" && node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 5781;
const ROOT = process.cwd();
function mime(ext) {
  return { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' }[ext] || 'text/plain';
}
http.createServer((req, res) => {
  let p = req.url.replace(/\?.*/, '');
  if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); return; }
  res.writeHead(200, {'Content-Type': mime(path.extname(file))});
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => process.stdout.write('a11y-bad ready on port ' + PORT + '\n'));
" &>"$FIXTURE_ROOT/.a11y-bad.log") &
echo "a11y-bad $!" >> "$PID_FILE"

# ---- seo-bad static (port 5782) ----
check_port_free 5782
log "Starting seo-bad static server on port 5782..."
(cd "$FIXTURES_DIR/seo-bad" && node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 5782;
const ROOT = process.cwd();
function mime(ext) {
  return { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.txt': 'text/plain' }[ext] || 'text/plain';
}
http.createServer((req, res) => {
  let p = req.url.replace(/\?.*/, '');
  if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); return; }
  res.writeHead(200, {'Content-Type': mime(path.extname(file))});
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => process.stdout.write('seo-bad ready on port ' + PORT + '\n'));
" &>"$FIXTURE_ROOT/.seo-bad.log") &
echo "seo-bad $!" >> "$PID_FILE"

# ---- browser-platform-bad (port 5793) ----
check_port_free 5793
log "Starting browser-platform-bad on port 5793..."
PORT=5793 node "$FIXTURES_DIR/browser-platform-bad/server.js" &>"$FIXTURE_ROOT/.browser-platform-bad.log" &
echo "browser-platform-bad $!" >> "$PID_FILE"

# ---- pen-bad (port 4091) ----
check_port_free 4091
log "Starting pen-bad on port 4091..."
PEN_BAD_PORT=4091 node "$FIXTURES_DIR/pen-bad/server.js" &>"$FIXTURE_ROOT/.pen-bad.log" &
echo "pen-bad $!" >> "$PID_FILE"

# ---- self SPA (port 5790) ----
check_port_free 5790
log "Starting self SPA (Vite) on port 5790..."
(cd "$FIXTURE_ROOT/web" && npm run dev -- --port 5790 &>"$FIXTURE_ROOT/.self-spa.log") &
echo "self-spa $!" >> "$PID_FILE"

# ---- self API (port 5791) ----
check_port_free 5791
log "Starting self API on port 5791..."
SELF_API_PORT=5791 node "$FIXTURE_ROOT/api/server.js" &>"$FIXTURE_ROOT/.self-api.log" &
echo "self-api $!" >> "$PID_FILE"

# ---- wait for all ports ----
wait_for_port 9994 "race-bad"
wait_for_port 4090 "idor-bad"
wait_for_port 5780 "v24-deferred-bugs"
wait_for_port 5781 "a11y-bad"
wait_for_port 5782 "seo-bad"
wait_for_port 5793 "browser-platform-bad"
wait_for_port 4091 "pen-bad"
wait_for_port 5790 "self-spa"
wait_for_port 5791 "self-api"

log "All fixture ports ready."
