#!/usr/bin/env bash
# visual-anomaly-mini — reset.sh

set -euo pipefail

PORT=9623

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[visual-anomaly-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
