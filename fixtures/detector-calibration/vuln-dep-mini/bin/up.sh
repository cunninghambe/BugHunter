#!/usr/bin/env bash
# vuln-dep-mini — up.sh
#
# This fixture is STATIC-ANALYSIS surface — no server to boot.
# up.sh runs npm install in app/ to materialise package-lock.json so that
# `npm audit --json` can parse the dependency graph.
#
# The planted vulnerable versions are:
#   - lodash@4.17.4  (prototype-pollution CVEs: CVE-2019-10744, CVE-2020-8203)
#   - axios@0.21.0   (SSRF / ReDoS CVE-2021-3749)
#
# These versions are pinned intentionally for the harness to detect.
# See README.md for rationale and the Dependabot-alert disclaimer.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo "[vuln-dep-mini/up.sh] $*" >&2; }

log "Installing npm dependencies (materialises package-lock.json for npm audit)..."
cd "$FIXTURE_ROOT/app"
npm install --prefer-offline --no-audit 2>&1 | tail -5 >&2 || npm install --no-audit 2>&1 | tail -5 >&2

log "npm install complete. npm audit target: $FIXTURE_ROOT/app"
log "(This fixture has no server — harness runs npm audit against the app/ directory.)"
