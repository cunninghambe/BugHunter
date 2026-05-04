#!/usr/bin/env bash
# rate-limit-mini — reset.sh

set -euo pipefail

PORT=9853

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[rate-limit-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
