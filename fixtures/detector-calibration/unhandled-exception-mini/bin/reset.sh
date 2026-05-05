#!/usr/bin/env bash
# unhandled-exception-mini — reset.sh

set -euo pipefail

PORT=9753

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[unhandled-exception-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
