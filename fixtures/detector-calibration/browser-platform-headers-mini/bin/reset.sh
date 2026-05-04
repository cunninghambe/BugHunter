#!/usr/bin/env bash
# browser-platform-headers-mini — reset.sh

set -euo pipefail

PORT=9873

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[browser-platform-headers-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
