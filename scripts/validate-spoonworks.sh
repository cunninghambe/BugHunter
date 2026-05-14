#!/usr/bin/env bash
# Validation: run BugHunter against spoonworks with the v0.51 FP fixes,
# compare precision to the pre-fix baseline (run yg0qspnwqe8egeqdv7rrsd9l).
#
# Predicted: 7.8 % → ~50 % precision (~12 clusters vs 77 before).
#
# Usage: scripts/validate-spoonworks.sh [BUGHUNTER_REPO_DIR]
#   BUGHUNTER_REPO_DIR defaults to /root/BugHunter

set -euo pipefail

BUGHUNTER_DIR="${1:-/root/BugHunter}"
SPOONWORKS_DIR="/root/spoonworks"
BASELINE_RUN="yg0qspnwqe8egeqdv7rrsd9l"

if [[ ! -d "$SPOONWORKS_DIR/.bughunter" ]]; then
  echo "❌ $SPOONWORKS_DIR has no .bughunter config. Run \`bughunter init\` first." >&2
  exit 1
fi

if ! pgrep -f spoonworks-web > /dev/null; then
  echo "⚠️  spoonworks-web not running. Start: pm2 start spoonworks-web" >&2
fi

# Build BugHunter if dist is missing or stale.
if [[ ! -f "$BUGHUNTER_DIR/packages/cli/dist/cli/main.js" ]]; then
  echo "Building BugHunter…"
  (cd "$BUGHUNTER_DIR" && npm run build -w packages/cli)
fi

BH_BIN="$BUGHUNTER_DIR/packages/cli/dist/cli/main.js"

echo "=== Pre-fix baseline (run $BASELINE_RUN) ==="
if [[ -f "$SPOONWORKS_DIR/.bughunter/runs/$BASELINE_RUN/bugs.jsonl" ]]; then
  HIGH=$(wc -l < "$SPOONWORKS_DIR/.bughunter/runs/$BASELINE_RUN/bugs.jsonl")
  LOW=$(wc -l < "$SPOONWORKS_DIR/.bughunter/runs/$BASELINE_RUN/bugs-low-confidence.jsonl" 2>/dev/null || echo 0)
  echo "  high-conf clusters: $HIGH"
  echo "  low-conf clusters:  $LOW"
  echo "  total:              $((HIGH + LOW))"
else
  echo "  (baseline run not found locally)"
fi

echo ""
echo "=== Running v0.51 BugHunter against spoonworks ==="
cd "$SPOONWORKS_DIR"
node "$BH_BIN" run

echo ""
echo "=== Latest run ==="
LATEST=$(ls -t "$SPOONWORKS_DIR/.bughunter/runs/" | head -1)
HIGH_NEW=$(wc -l < "$SPOONWORKS_DIR/.bughunter/runs/$LATEST/bugs.jsonl" 2>/dev/null || echo 0)
LOW_NEW=$(wc -l < "$SPOONWORKS_DIR/.bughunter/runs/$LATEST/bugs-low-confidence.jsonl" 2>/dev/null || echo 0)
echo "  run: $LATEST"
echo "  high-conf clusters: $HIGH_NEW"
echo "  low-conf clusters:  $LOW_NEW"
echo "  total:              $((HIGH_NEW + LOW_NEW))"

echo ""
echo "=== Cluster kinds in latest run ==="
cat "$SPOONWORKS_DIR/.bughunter/runs/$LATEST/bugs.jsonl" \
    "$SPOONWORKS_DIR/.bughunter/runs/$LATEST/bugs-low-confidence.jsonl" 2>/dev/null \
  | python3 -c "
import json, sys, collections
c = collections.Counter()
for line in sys.stdin:
    if line.strip():
        c[json.loads(line)['kind']] += 1
for k, n in c.most_common():
    print(f'  {n:3d}  {k}')
"

echo ""
echo "=== Next step: triage the latest run vs BENCHMARK_SPOONWORKS.md ==="
echo "  Goal: classify each cluster as real-bug / fp-known / fp-new / out-of-scope"
echo "  Expected: ~6 real (vulnerable_dependency_high collapsed to ~3), 0 dom_error_text on policy pages, 0 unresolved-:id"
