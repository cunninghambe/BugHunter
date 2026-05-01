# BugHunter Self-Test Fixture

**DO NOT DEPLOY this fixture to any public or shared network.**

This is a composite, deliberately-buggy fixture that exercises every wired `BugKind`
in `DETECTOR_REGISTRY`. It is the regression gate for the `bughunter self-test` command.

## What this is

- A coordinator that boots all existing sub-fixtures (`race-bad`, `idor-bad`,
  `v24-deferred-bugs`, `a11y-bad`, `seo-bad`, `pen-bad`) on their designated ports.
- A new minimal Vite SPA (`web/`, port 5790) and Node API (`api/server.js`, port 5791)
  that cover the ~30 wired kinds not exercised by existing fixtures.
- Static analysis targets (`web/src/leaked.ts`, `web/src/swallow.ts`,
  `package.json`) for credential-scanning and empty-catch detection.

## How to run

```bash
# From repo root
bughunter self-test --budget 1800000

# Or manually boot fixtures then run BugHunter:
bash fixtures/bughunter-self-deliberate-bugs/bin/up.sh
bughunter run --project-dir fixtures/bughunter-self-deliberate-bugs
bash fixtures/bughunter-self-deliberate-bugs/bin/down.sh
```

## Structure

```
bughunter-self-deliberate-bugs/
├── reuse-manifest.json      — which fixture covers which BugKind
├── golden-bugs.jsonl        — expected clusters (positive) and absent kinds (negative)
├── .bughunter/config.json   — pre-baked BugHunter project config
├── surfacemcp.config.json   — SurfaceMCP composite surface config
├── bin/up.sh                — boot all sub-fixture ports
├── bin/down.sh              — graceful teardown
├── api/server.js            — Node API for self-covered kinds (port 5791)
└── web/                     — Vite SPA for self-covered kinds (port 5790)
```

## Ports

| Port | Fixture |
|------|---------|
| 9994 | race-bad |
| 4090 | idor-bad |
| 5780 | v24-deferred-bugs |
| 5781 | a11y-bad (static) |
| 5782 | seo-bad (static) |
| 4091 | pen-bad |
| 5790 | self SPA (Vite) |
| 5791 | self API (Node) |

## Lockstep rule

Three files must stay in sync. A unit test enforces this at `npm test` time:

1. `packages/cli/src/detectors/registry.ts` — wired/deferred status
2. `fixtures/bughunter-self-deliberate-bugs/reuse-manifest.json` — coverage mapping
3. `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` — expectations

To add a new wired kind: update all three files atomically in one PR.
