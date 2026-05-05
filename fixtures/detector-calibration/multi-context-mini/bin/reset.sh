#!/usr/bin/env bash
# multi-context-mini — reset.sh

set -euo pipefail

PORT=9653

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[multi-context-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
