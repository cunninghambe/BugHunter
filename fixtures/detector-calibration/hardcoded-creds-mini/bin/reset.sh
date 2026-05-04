#!/usr/bin/env bash
# hardcoded-creds-mini — reset.sh
# Re-generates the source tree from templates (idempotent).

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$FIXTURE_ROOT/bin/down.sh"
bash "$FIXTURE_ROOT/bin/up.sh"
