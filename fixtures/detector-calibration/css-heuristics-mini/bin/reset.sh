#!/usr/bin/env bash
# css-heuristics-mini — reset.sh

set -euo pipefail

PORT=9773

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[css-heuristics-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
