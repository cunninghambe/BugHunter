#!/usr/bin/env bash
# console-error-mini — reset.sh

set -euo pipefail

PORT=9763

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[console-error-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
