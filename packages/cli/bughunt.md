# bughunt — BugHunter skill for Claude

This skill teaches you how to run BugHunter, interpret its output, and act on findings.

## When to invoke BugHunter

Run `bughunter run` when asked to:
- Find bugs in the app
- Check for regressions
- Run a full quality sweep
- Verify a feature before shipping

Run `bughunter run --auto-fix` when also asked to fix what's found.

## Running BugHunter

```bash
# Full run from current project directory
bughunter run

# Scoped run
bughunter run --route "/admin/**" --role owner

# With auto-fix
bughunter run --auto-fix

# Time-boxed (1 hour)
bughunter run --budget 3600000

# Resume a paused run
bughunter run --resume <runId>
```

## Interpreting bugs.jsonl

Each line in `.bughunter/runs/<runId>/bugs.jsonl` is a cluster. When reporting to the user:

1. **Group by kind** — `network_5xx` and `console_error` are usually higher severity
2. **Rank by clusterSize** — larger clusters = more pages/roles affected = higher priority
3. **Cite cluster ids** — always cite the `id` field so the user can inspect
4. **Check thirdPartyOrGenerated** — skip these in your summary; they're not actionable

Example summary format:
```
Found 3 clusters:
- [bug-abc123] react_error (×7): TypeError in ProductList.tsx — products.map called on undefined
- [bug-def456] network_5xx (×3): POST /api/orders returns 500
- [bug-ghi789] missing_state_change (×1): Edit button on /admin/users produces no change
```

## infrastructure.jsonl is NOT bugs

Entries in `infrastructure.jsonl` are browser MCP crashes, SurfaceMCP timeouts, or camofox errors. They are NOT bugs in the app. Do not report them as bugs. Mention the count briefly: "3 infrastructure failures (browser MCP timeouts) — not app bugs."

## Drilling into a cluster

```bash
bughunter inspect <clusterId>       # Summary + artifact paths
bughunter inspect <occurrenceId>    # Focus on one occurrence
bughunter replay <occurrenceId>     # Re-run the exact steps that triggered it
```

## After an auto-fix run

Report the verified vs persistent split:

```
Auto-fix results:
- verified_fixed: 2 clusters (ClaudeMCP fixed and retest passed)
- partially_verified: 1 cluster (some occurrences confirmed fixed)
- bugs_persistent: 1 cluster (fix attempted but bug still reproduced)
- bugs_skipped: 1 cluster (touched prisma/schema.prisma — forbidden path reset)
```

## Forbidden-path policy

When a cluster shows `bugs_skipped: { reason: "touched_forbidden_path" }`, explain to the user:

> Claude's fix attempt modified `<paths>`, which are on the forbidden list (schema migrations, lockfiles, env files). The fix branch was reset. This cluster needs manual attention.

## Fix loop without re-running

```bash
bughunter fix   # Read latest run, dispatch fixes, no new discovery
```

## Managing runs

```bash
bughunter list                  # Last 20 runs
bughunter status <runId>        # Detailed state
bughunter prune                 # Delete runs older than 30 days
bughunter palette               # Show active mutation palette
```
