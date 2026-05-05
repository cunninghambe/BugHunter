#!/usr/bin/env bash
# cache-staleness-mini — reset.sh

set -euo pipefail

PORT=9823

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[cache-staleness-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
