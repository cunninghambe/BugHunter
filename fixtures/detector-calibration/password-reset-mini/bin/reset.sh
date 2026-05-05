#!/usr/bin/env bash
# password-reset-mini — reset.sh

set -euo pipefail

PORT=9783

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[password-reset-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
