#!/usr/bin/env bash
# i18n-hardcoded-strings-mini — reset.sh
# Re-materialises generated/ from templates.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$FIXTURE_ROOT/bin/down.sh"
bash "$FIXTURE_ROOT/bin/up.sh"
