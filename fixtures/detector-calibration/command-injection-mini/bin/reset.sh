#!/usr/bin/env bash
# command-injection-mini — reset.sh

set -euo pipefail

PORT=9979

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[command-injection-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
