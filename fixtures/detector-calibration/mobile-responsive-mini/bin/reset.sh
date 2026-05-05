#!/usr/bin/env bash
# mobile-responsive-mini — reset.sh
set -euo pipefail
PORT=9513
curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" -o /dev/null
