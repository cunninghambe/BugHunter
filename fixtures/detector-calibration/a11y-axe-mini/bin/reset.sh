#!/usr/bin/env bash
# a11y-axe-mini — reset.sh

set -euo pipefail

PORT=9723

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[a11y-axe-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
