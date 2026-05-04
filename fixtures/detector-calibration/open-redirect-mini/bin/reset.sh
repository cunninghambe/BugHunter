#!/usr/bin/env bash
# open-redirect-mini — reset.sh

set -euo pipefail

PORT=9913

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[open-redirect-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
