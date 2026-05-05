#!/usr/bin/env bash
# nav-state-mini — reset.sh

set -euo pipefail

PORT=9703

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[nav-state-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
