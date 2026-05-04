#!/usr/bin/env bash
# xss-mini — reset.sh
# Restores fixture server state via its HTTP reset endpoint.

set -euo pipefail

PORT=9971

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[xss-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
