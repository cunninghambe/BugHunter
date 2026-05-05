#!/usr/bin/env bash
# money-math-mini — reset.sh
# Re-materialises generated/ from templates.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$FIXTURE_ROOT/bin/down.sh"
bash "$FIXTURE_ROOT/bin/up.sh"
