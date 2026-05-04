#!/usr/bin/env bash
# sqli-mini fixture — reset.sh
# Resets the fixture app to a clean state via its HTTP reset endpoint.

set -euo pipefail

PORT=9972

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[sqli-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
