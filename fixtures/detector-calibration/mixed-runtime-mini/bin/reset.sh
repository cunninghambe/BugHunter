#!/usr/bin/env bash
# mixed-runtime-mini — reset.sh
set -euo pipefail
PORT=9553
curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" -o /dev/null
