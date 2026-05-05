#!/usr/bin/env bash
# audit-log-mini — reset.sh

set -euo pipefail

PORT=9813

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[audit-log-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
