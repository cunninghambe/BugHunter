#!/usr/bin/env bash
# csrf-missing-mini — reset.sh

set -euo pipefail

PORT=9903

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[csrf-missing-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
