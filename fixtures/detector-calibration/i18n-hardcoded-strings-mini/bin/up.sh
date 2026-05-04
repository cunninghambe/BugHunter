#!/usr/bin/env bash
# i18n-hardcoded-strings-mini — up.sh
#
# Static-analysis fixture — no server. up.sh materialises templates/*.tpl into
# generated/src/ where the i18n_hardcoded_string scanner runs against them.
# generated/ is .gitignore'd to keep the planted strings out of source control.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED_DIR="$FIXTURE_ROOT/generated"
SRC_DIR="$GENERATED_DIR/src"

log() { echo "[i18n-hardcoded-strings-mini/up.sh] $*" >&2; }

mkdir -p "$SRC_DIR"

for tpl in "$FIXTURE_ROOT/templates"/*.tpl; do
  base="$(basename "$tpl" .tpl)"
  dest="$SRC_DIR/$base"
  cp "$tpl" "$dest"
  log "Generated: $dest"
done

log "Done — generated/ ready for scan."
