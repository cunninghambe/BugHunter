#!/usr/bin/env bash
# i18n-hardcoded-strings-mini — down.sh
# Removes generated/ to keep the fixture clean between runs.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED_DIR="$FIXTURE_ROOT/generated"

if [ -d "$GENERATED_DIR" ]; then
  rm -rf "$GENERATED_DIR"
  echo "[i18n-hardcoded-strings-mini/down.sh] Cleaned generated/" >&2
fi
