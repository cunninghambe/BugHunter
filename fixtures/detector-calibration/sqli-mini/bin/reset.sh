#!/usr/bin/env bash
# sqli-mini — reset.sh

set -euo pipefail

PORT=9957

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[sqli-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
