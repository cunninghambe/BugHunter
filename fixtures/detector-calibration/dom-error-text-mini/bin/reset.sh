#!/usr/bin/env bash
# dom-error-text-mini — reset.sh

set -euo pipefail

PORT=9733

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[dom-error-text-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
