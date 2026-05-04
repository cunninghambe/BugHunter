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

# P1+P2: Substitute placeholders — main file with hardcoded credentials (fires)
sed \
  -e "s|@@STRIPE_KEY@@|${STRIPE_VAL}|g" \
  -e "s|@@AWS_ACCESS_KEY@@|${AWS_VAL}|g" \
  "$FIXTURE_ROOT/templates/auth.ts.tpl" \
  > "$GENERATED_DIR/src/lib/auth.ts"

# Negative: env-var file — no hardcoded value, gitleaks silent
cp "$FIXTURE_ROOT/templates/auth-safe.ts.tpl" \
   "$GENERATED_DIR/src/lib/auth-safe.ts"

# Edge: credential in a comment — gitleaks still fires (comments are scannable)
sed \
  -e "s|@@STRIPE_KEY@@|${STRIPE_VAL}|g" \
  "$FIXTURE_ROOT/templates/auth-comment.ts.tpl" \
  > "$GENERATED_DIR/src/lib/auth-comment.ts"

# Note: templates/auth-template-placeholder.ts.tpl is intentionally NOT expanded
# here — it stays as a committed template file scanned directly by gitleaks as
# part of the templates/ directory. Its @@STRIPE_KEY@@ placeholder is not a
# real secret pattern and should not fire. See expected-clusters.jsonl.

log "Generated $GENERATED_DIR/src/lib/auth.ts (hardcoded creds — fires)."
log "Generated $GENERATED_DIR/src/lib/auth-safe.ts (env-var — silent)."
log "Generated $GENERATED_DIR/src/lib/auth-comment.ts (cred in comment — fires)."
log "Run gitleaks against: $GENERATED_DIR"
log "(This fixture has no server — harness scans the generated source tree.)"
