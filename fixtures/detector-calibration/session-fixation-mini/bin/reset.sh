#!/usr/bin/env bash
# session-fixation-mini — reset.sh

set -euo pipefail

PORT=9793

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[session-fixation-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
