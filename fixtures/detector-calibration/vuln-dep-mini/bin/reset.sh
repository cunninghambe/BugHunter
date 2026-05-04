#!/usr/bin/env bash
# vuln-dep-mini — reset.sh
#
# Re-runs npm install to restore package-lock.json to a clean state.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[vuln-dep-mini/reset.sh] Re-running npm install in app/..." >&2
cd "$FIXTURE_ROOT/app"
npm install --prefer-offline --no-audit 2>&1 | tail -3 >&2 || npm install --no-audit 2>&1 | tail -3 >&2
echo "[vuln-dep-mini/reset.sh] Done." >&2
