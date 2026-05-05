#!/usr/bin/env bash
# state-change-mini — reset.sh

set -euo pipefail

PORT=9683

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[state-change-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
