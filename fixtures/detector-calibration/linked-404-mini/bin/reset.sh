#!/usr/bin/env bash
# linked-404-mini — reset.sh

set -euo pipefail

PORT=9893

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[linked-404-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
