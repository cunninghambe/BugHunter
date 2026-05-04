#!/usr/bin/env bash
# cookie-flags-mini — reset.sh

set -euo pipefail

PORT=9933

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[cookie-flags-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
