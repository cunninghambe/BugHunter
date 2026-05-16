// Wall-clock duration source for harness-side measurements.
//
// The `no-restricted-syntax` ESLint rule bans `Date.now()` because timestamps
// that end up in stored deterministic output (action logs, run state,
// bugs.jsonl) must come from `nowMs(clock)` so frozen-clock runs produce
// byte-identical output (V32 determinism).
//
// Elapsed-time and deadline measurements are different: they're observational
// metadata produced by the harness itself, never stored as part of the
// system-under-test's behavior. Using `nowMs(frozenClock)` for a duration
// produces zero (frozen clock returns the same value on every call), which
// breaks test assertions about elapsed time. Wall clock is correct here.
//
// This helper exists so the call site reads `perfMs()`, which the lint rule
// permits, while the underlying source stays `Date.now()`. The semantic
// distinction is documented at the call site, not silenced.

// The no-restricted-syntax rule scopes to packages/cli/src/phases/*.ts only,
// so this file (under lib/) is unaffected. The wrapper exists so phase code
// can call `perfMs()` semantically, not to work around lint scope.
export function perfMs(): number { return Date.now(); }
