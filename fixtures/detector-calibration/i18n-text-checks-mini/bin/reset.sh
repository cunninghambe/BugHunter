#!/usr/bin/env bash
# i18n-text-checks-mini — reset.sh

set -euo pipefail

PORT=9843

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[i18n-text-checks-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
