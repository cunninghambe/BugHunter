#!/usr/bin/env bash
# browser-platform-probe-mini — reset.sh

set -euo pipefail

PORT=9633

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[browser-platform-probe-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
