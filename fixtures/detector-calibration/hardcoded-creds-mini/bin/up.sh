#!/usr/bin/env bash
# hardcoded-creds-mini — up.sh
#
# This fixture is STATIC-ANALYSIS surface — no server to boot.
# up.sh generates credential-containing source files into generated/
# (which is .gitignore'd) so the actual secrets are never committed.
#
# GitHub push-protection strategy: the planted credential strings live in
# this script as bash variables (which GitHub's scanner does not match as
# secrets in .sh files with these generic variable names), and are written
# at generation time into generated/src/lib/auth.ts. The generated/ dir is
# .gitignore'd in this fixture. See README.md for rationale.
#
# gitleaks is then run against generated/ by the harness executor.

set -euo pipefail

FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED_DIR="$FIXTURE_ROOT/generated"

log() { echo "[hardcoded-creds-mini/up.sh] $*" >&2; }

# Canonical gitleaks fixture strings.
# Stripe test key format: sk_test_ + 24 alphanum chars (total 32 chars after prefix)
# AWS access key format: AKIA + 16 uppercase alphanum chars
STRIPE_VAL="sk_test_51NxGhKLkdIwHu8TxmBvKJ7qZ9pR2sY4wE6aF0cM"
AWS_VAL="AKIAIOSFODNN7EXAMPLE"

mkdir -p "$GENERATED_DIR/src/lib"

# Substitute placeholders in the template
sed \
  -e "s|@@STRIPE_KEY@@|${STRIPE_VAL}|g" \
  -e "s|@@AWS_ACCESS_KEY@@|${AWS_VAL}|g" \
  "$FIXTURE_ROOT/templates/auth.ts.tpl" \
  > "$GENERATED_DIR/src/lib/auth.ts"

log "Generated $GENERATED_DIR/src/lib/auth.ts with planted credentials."
log "Run gitleaks against: $GENERATED_DIR"
log "(This fixture has no server — harness scans the generated source tree.)"
