#!/usr/bin/env bash
# script-checks-mini — reset.sh

set -euo pipefail

PORT=9863

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[script-checks-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
