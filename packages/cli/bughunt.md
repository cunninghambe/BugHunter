# bughunt — BugHunter skill for Claude

This skill teaches you how to run BugHunter, interpret its output, and orchestrate fixes via the `/bughunt fix` workflow.

## When to invoke BugHunter

Run `bughunter run` when asked to:
- Find bugs in the app
- Check for regressions
- Run a full quality sweep
- Verify a feature before shipping

## Running BugHunter

```bash
# Full run from current project directory
bughunter run

# Scoped run
bughunter run --route "/admin/**" --role owner

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
4. **Check thirdPartyOrGenerated** — skip these in your summary; they are not actionable

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

## Managing runs

```bash
bughunter list                  # Last 20 runs
bughunter status <runId>        # Detailed state
bughunter prune                 # Delete runs older than 30 days
bughunter palette               # Show active mutation palette
```

---

# /bughunt fix — auto-fix orchestrator

When the user says `/bughunt fix`, "fix the bugs from the latest run", or asks you to fix BugHunter findings, follow the steps below precisely. This is the complete orchestration protocol per § 3.9 of the BugHunter spec.

## Overview

You will walk through every actionable cluster in the latest run's `bugs.jsonl`. For each cluster you spawn an architect sub-agent to write a focused spec, then a coder sub-agent to implement it. After the coder commits, you run two safety checks: a forbidden-path gate (to ensure the fix does not touch schema, lockfiles, or env files) and a retest (to verify the bug no longer reproduces). You record every outcome in `fix-state.json` and print a summary table when done.

## Step-by-step instructions

### Step 1 — Find the latest run

Run `bughunter list` and read its output. Pick the most recent run ID. Call it `{{runId}}`.

### Step 2 — Read the bug log

Read `.bughunter/runs/{{runId}}/bugs.jsonl`. Each line is a JSON object representing one cluster. Parse each line. Note the current branch with `git rev-parse --abbrev-ref HEAD` — call it `{{baseBranch}}`.

### Step 3 — Initialize fix state

Check whether `.bughunter/runs/{{runId}}/fix-state.json` already exists. If it does, load it (you are resuming an interrupted run). If not, start with an empty array. Maintain this array throughout the loop — you will append one entry per cluster and write the file after each entry so progress is not lost if interrupted.

### Step 4 — Loop over clusters

For each cluster in `bugs.jsonl`, in order:

**Skip condition:** If the cluster's `thirdPartyOrGenerated` field is `true`, skip it without recording anything — generated and third-party code is not actionable.

**Also skip:** If you loaded an existing `fix-state.json` in step 3 and this cluster already has an entry there, skip it — you are resuming.

For every other cluster, follow phases A through D below, using the cluster's `id` field as `{{clusterId}}`.

#### Phase A — Create the fix branch

Run:
```bash
git checkout -b bughunter/{{runId}}/{{clusterId}} {{baseBranch}}
```

This creates the branch the architect and coder will commit to. After this command, the branch exists locally.

#### Phase B — Architect spec (Opus)

Spawn a sub-agent using the Agent tool: `Agent(subagent_type='architect', model='opus', prompt=<architect brief below with variables filled in>)`.

**Architect brief template:**

```
You are an architect writing a focused fix spec for a single BugHunter cluster.
You DO NOT implement the fix — you produce a spec for the implementer.

Project: {{projectName}}
Cluster: {{clusterId}}
Bug log: .bughunter/runs/{{runId}}/bugs.jsonl

Suspected files: {{suspectedFiles}}
Fix hints: {{fixHints}}
Exemplar occurrence (full repro context): {{exemplarOccurrenceJson}}

Investigate the root cause. Read the suspected files. Form a hypothesis.
If gitnexus is registered for this project, use gitnexus_impact to assess
blast radius before recommending the fix.

Write a focused spec to:
  .bughunter/runs/{{runId}}/specs/{{clusterId}}.md

Use the project's spec discipline (Problem / Root cause with file:line /
Boundaries / Interface change if any / Edge cases / Acceptance criteria /
Files to touch).

If the fix is impossible or unsafe (requires schema migration, forbidden-path
changes, or genuinely uncertain root cause), instead write a spec whose
first non-blank line is "REFUSE: <reason>". The implementer will see this
and skip the cluster.

Commit the spec on branch bughunter/{{runId}}/{{clusterId}}. Do NOT implement
the fix. Do NOT push.
```

Fill in `{{projectName}}` from `.bughunter/config.json`. Fill in `{{suspectedFiles}}` and `{{fixHints}}` from the cluster's JSON fields. For `{{exemplarOccurrenceJson}}`, find the first occurrence in the cluster where `fullArtifacts` is `true` and inline its JSON; if none exist, use `null`.

Wait for the architect sub-agent to complete before proceeding.

#### Phase B — REFUSE check

After the architect completes, read `.bughunter/runs/{{runId}}/specs/{{clusterId}}.md`. Strip leading blank lines. If the first non-blank line begins with `REFUSE:`, record:

```json
{ "clusterId": "{{clusterId}}", "verdict": "architect_refused", "detail": "<the reason after REFUSE:>" }
```

Append this to `fix-state.json` and write the file. Then continue to the next cluster — do not proceed to phase C or D for a refused cluster.

#### Phase C — Coder implementation (Sonnet)

Spawn a sub-agent using the Agent tool: `Agent(subagent_type='coder', model='sonnet', prompt=<coder brief below with variables filled in>)`.

**Coder brief template:**

```
You are a coder. Implement the fix specified at:
  .bughunter/runs/{{runId}}/specs/{{clusterId}}.md

You're on branch bughunter/{{runId}}/{{clusterId}} which already has the spec
committed by the architect. Read the spec; treat it as the contract; do not
re-derive its decisions; do not exceed its boundaries.

Steps:
  1. Implement exactly as specified.
  2. Add a regression test exercising one of the cluster's occurrences.
  3. Run the project's tests; they must pass before you commit.
  4. Commit on the same branch with a message referencing {{clusterId}}.
  5. Output the last commit SHA.

Do NOT push. Do NOT touch (will be hard-reset by the post-hoc gate):
  prisma/migrations/**, prisma/schema.prisma, package.json, package-lock.json,
  yarn.lock, pnpm-lock.yaml, .env*, .gitignore, migrations/**, alembic/**,
  .next/**, node_modules/**, dist/**, build/**
```

Wait for the coder sub-agent to complete before proceeding.

#### Phase D — Forbidden-path gate

Run:
```bash
bughunter forbidden-path-gate bughunter/{{runId}}/{{clusterId}} --base {{baseBranch}} --reset
```

Parse the JSON output. If `ok` is `false`, record:

```json
{ "clusterId": "{{clusterId}}", "verdict": "touched_forbidden_path", "paths": ["<path1>", "<path2>"] }
```

Append to `fix-state.json` and write the file. Then continue to the next cluster — do not run retest for a forbidden-path cluster (the gate already hard-reset the branch).

#### Phase E — Retest

Run:
```bash
bughunter retest {{runId}} {{clusterId}} --base {{baseBranch}} --branch bughunter/{{runId}}/{{clusterId}}
```

Parse the JSON output. The output is a `RetestResult` object with a `verdict` field. Record:

```json
{ "clusterId": "{{clusterId}}", "verdict": "<verdict from RetestResult>", "replayedOccurrences": <N>, "passedOccurrences": <M> }
```

Append to `fix-state.json` and write the file.

### Step 5 — Print the summary

After the loop completes (all clusters processed), run:
```bash
bughunter fix-summary {{runId}}
```

Print its output to the user verbatim. Then give a one-sentence plain-English summary: "X clusters verified fixed, Y persistent, Z skipped."

## Variable substitution reference

When filling in the brief templates:

| Variable | Source |
|---|---|
| `{{runId}}` | The run ID from step 1 |
| `{{clusterId}}` | The `id` field of the current cluster |
| `{{baseBranch}}` | The branch name from `git rev-parse --abbrev-ref HEAD` |
| `{{projectName}}` | The `projectName` field from `.bughunter/config.json` |
| `{{suspectedFiles}}` | JSON array from the cluster's `suspectedFiles` field |
| `{{fixHints}}` | JSON array from the cluster's `fixHints` field |
| `{{exemplarOccurrenceJson}}` | JSON of the first occurrence where `fullArtifacts === true`, or `null` |

## Forbidden-path policy

When a cluster shows `verdict: "touched_forbidden_path"`, explain to the user:

> The fix attempt modified `<paths>`, which are on the forbidden list (schema migrations, lockfiles, env files). The fix branch was hard-reset. This cluster needs manual attention.

## Error handling

If any sub-agent fails or returns an error, record `{ "clusterId": "{{clusterId}}", "verdict": "not_fixed", "detail": "<error summary>" }` and continue to the next cluster. Do not abort the entire run for a single cluster failure.

If `bughunter forbidden-path-gate` or `bughunter retest` exits non-zero, treat it as an infrastructure problem and record `not_fixed` with a detail note.
