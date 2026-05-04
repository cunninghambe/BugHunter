#!/usr/bin/env bash
# Template fixture — reset.sh
# Resets the fixture app to a clean state via its HTTP reset endpoint.

set -euo pipefail

PORT=9970  # Match the port in up.sh

curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" || {
  echo "[<fixture-name>/reset.sh] Reset endpoint returned error." >&2
  exit 1
}
