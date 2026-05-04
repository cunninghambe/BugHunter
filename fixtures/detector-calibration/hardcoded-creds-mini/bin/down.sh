#!/usr/bin/env bash
# hardcoded-creds-mini — down.sh
# No server to stop. Removes the generated/ directory.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED_DIR="$FIXTURE_ROOT/generated"

log() { echo "[hardcoded-creds-mini/down.sh] $*" >&2; }

if [ -d "$GENERATED_DIR" ]; then
  rm -rf "$GENERATED_DIR"
  log "Removed $GENERATED_DIR."
else
  log "Nothing to clean — $GENERATED_DIR does not exist."
fi
