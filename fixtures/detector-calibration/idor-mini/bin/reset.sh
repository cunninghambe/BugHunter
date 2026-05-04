#!/usr/bin/env bash
# idor-mini — reset.sh

set -euo pipefail

PORT=9978

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[idor-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
