#!/usr/bin/env bash
# race-mini — reset.sh

set -euo pipefail

PORT=9663

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[race-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
