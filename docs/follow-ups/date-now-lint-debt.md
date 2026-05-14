# Follow-up: Date.now lint debt

**Status:** 58 ESLint errors on main from `no-restricted-syntax` rule (added in PR #88 V32 determinism).

The rule bans `Date.now()` in favor of `nowMs(clock)` so frozen-clock runs are deterministic.

## Why this is not a mechanical fix

Most call sites measure *elapsed duration*, not "now":

```ts
const start = Date.now();
// ... work ...
const durationMs = Date.now() - start;
```

Replacing both calls with `nowMs(clock)`:

- With `clock.kind === 'wall'`: identical behavior.
- With `clock.kind === 'frozen'`: both calls return the same value. **All durations become 0**, which changes test outcomes that assert non-zero elapsed time.

This is a real design tradeoff, not a syntax fix.

## Options to resolve

### A. Scope the rule out of duration measurements

Allow `Date.now()` when the value is consumed as a delta. Pragmatic; preserves real durations under all clock modes; rule still catches misuse for timestamp generation.

Implementation: change the lint rule to a custom rule (or selector that whitelists `Date.now() - <Identifier>` patterns), OR introduce a `perfNowMs()` helper that always uses wall clock and is exempt from the ban.

### B. Thread `clock` and accept frozen-duration=0

Mechanical sweep: every site gets `clock` passed in, every `Date.now()` becomes `nowMs(clock)`. Frozen-clock test runs see all durations as 0 and assertions adjust accordingly.

Cost: significant surface-area churn (~60 call sites, signatures change on race-runner, multi-context-runner, browser-mcp, execute, harness, etc.).

### C. Suppress per-line with `// eslint-disable-next-line`

Defers the question. Keeps the rule active for new code. Acceptable as a one-time cleanup before deciding A vs B.

## Files with errors

```
packages/cli/src/phases/execute.ts                   17 errors
packages/cli/src/phases/form-reachability-probe.ts    6 errors
packages/cli/src/phases/multi-context-runner.ts       6 errors
packages/cli/src/phases/race-runner.ts                3 errors
packages/cli/src/phases/form-submit-runner.ts         2 errors
packages/cli/src/phases/cross-user.ts                 2 errors
... (additional file-level details: run `npm run lint 2>&1 | grep error`)
```

## Recommendation

**Option A**, scoped to delta patterns. Reasoning: the determinism concern is about *what timestamp ends up in stored output* (action logs, run state), not about elapsed-time measurements inside the phase. A wall-clock duration of "108 ms" is fine to record because it's a measurement of the harness, not of the system-under-test. The lint rule overreaches by banning the elapsed-time pattern.

## Decision needed from Brad

Pick A / B / C. Until decided, this PR keeps the lint debt in place and CI gates on typecheck + tests only.
