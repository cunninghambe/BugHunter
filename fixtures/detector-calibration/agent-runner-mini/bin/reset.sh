#!/usr/bin/env bash
# agent-runner-mini — reset.sh
set -euo pipefail
PORT=9533
curl -sf -X POST "http://127.0.0.1:${PORT}/__bughunter_reset" -o /dev/null
