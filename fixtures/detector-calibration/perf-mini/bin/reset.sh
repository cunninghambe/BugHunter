#!/usr/bin/env bash
# perf-mini — reset.sh

set -euo pipefail

PORT=9713

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[perf-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
