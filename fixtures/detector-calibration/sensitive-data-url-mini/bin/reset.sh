#!/usr/bin/env bash
# sensitive-data-url-mini — reset.sh
# This fixture is stateless; reset is a no-op beyond confirming the server responds.

set -euo pipefail

PORT=9975

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[sensitive-data-url-mini/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
