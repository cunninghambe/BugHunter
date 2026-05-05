#!/usr/bin/env bash
# network-fault-mini — reset.sh

set -euo pipefail

PORT=9643

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[network-fault-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
