# SPEC — Phase 2.5 Stage 2: promote `strict-boolean-expressions` from `warn` to `error`

**Status:** ready for `@coder` · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** Stage 1 (PR #17, merged) · **Sibling spec:** `SPEC_LINT_PHASE_2_5.md` (defines Stage 1 + Stage 2)

This is the Stage 2 promotion described in `SPEC_LINT_PHASE_2_5.md` §5. Stage 1 landed the rule at `warn` and burnt down the 184 violations to zero. Stage 2 is a one-line config change that flips the rule to `error`, plus the verification that nothing has crept back in since Stage 1 merged.

The spec is intentionally small. The work is small. But the verification is non-trivial — code merged after Stage 1 may have introduced new violations that the `warn` level let through (CI enforces `--max-warnings 0`, but a `warn` next to a real `error` in a noisy run can be missed by reviewers).

---

## 1. Problem

`@typescript-eslint/strict-boolean-expressions` is currently registered at level `'warn'` in `eslint.config.js` (line 21-29). Stage 1 (`SPEC_LINT_PHASE_2_5.md` §5) promised:

> ### Stage 2 — Promote `warn` → `error` (separate PR)
> Once Stage 1 lands and CI is green:
> 1. Change the rule to `'error'` in `eslint.config.js`.
> 2. Run `npm run lint` to confirm zero violations.
> 3. Commit "Lint: promote strict-boolean-expressions to error."

This spec executes that step **with** an explicit verification protocol because:

1. **CI may have masked drift.** `npm run lint` enforces `--max-warnings 0`, so any new `strict-boolean-expressions` warning would fail CI — but only if every PR since Stage 1 ran the full type-aware lint (`ESLINT_FAST` not set). If anyone merged a PR via `lint:fast` or with the type-aware rules disabled locally, drift could be sitting in `main` right now.
2. **Confounding lint errors.** A separate `no-promise-executor-return` error at `discovery/crawler.ts:155` currently fails `npm run lint`. That error is **unrelated** to Stage 2 but blocks the verification step until it's resolved or carved out. See §3.
3. **New v0.5 / v0.7 code.** Since PR #17, the v0.5 security cluster (cross-user, header-probe, resource-id-extractor, auth-flow) and v0.7 XSS / auth-flows landed. Any of those could have introduced violations that the `warn` level silently absorbed.

Stage 2 is a one-line config flip **plus** a clean lint pass **plus** an explicit fix for any drift discovered during the pass.

---

## 2. Existing state

### 2.1 Current `eslint.config.js` (lines 21-29)

```js
'@typescript-eslint/strict-boolean-expressions': ['warn', {
  allowString: false,
  allowNumber: false,
  allowNullableObject: false,
  allowNullableBoolean: false,
  allowNullableString: false,
  allowNullableNumber: false,
  allowAny: false,
}],
```

The strictness options are **already strict** (per Stage 1). Stage 2 changes only the severity from `'warn'` to `'error'`.

### 2.2 Current `npm run lint` output

```
$ npm run lint
/root/BugHunter/packages/cli/src/discovery/crawler.ts
  155:38  error  Return values from promise executor functions cannot be read  no-promise-executor-return

✖ 1 problem (1 error, 0 warnings)
```

Zero `strict-boolean-expressions` warnings. **One unrelated error** in `crawler.ts`. This must be resolved or scoped before Stage 2 lands.

### 2.3 Current CI gating

`package.json` (line 13): `"lint": "eslint packages/*/src --max-warnings 0"`. CI fails on any warning. The `crawler.ts` error fails CI today regardless of Stage 2.

---

## 3. Pre-flight: clear the unrelated `no-promise-executor-return` error

**This must land before the Stage 2 promotion** — otherwise the verification step (clean lint pass) cannot complete.

### 3.1 The violation

`packages/cli/src/discovery/crawler.ts:155` returns a value from a `Promise` executor function. The `no-promise-executor-return` rule (already at `error` in `eslint.config.js`) flags this.

### 3.2 Two options

**Option A (preferred).** Read the offending line; rewrite to not return from the executor.

Typical patterns:

```ts
// Before (executor returns something):
new Promise((resolve, reject) => resolve(value));   // implicit return

// After:
new Promise((resolve, reject) => { resolve(value); });
```

If the actual code is more involved (e.g. returning a `setTimeout(..., handle)`, awaiting inside the executor), apply the equivalent rewrite.

**Option B (escape hatch — only if the rewrite is non-obvious and the line is intentionally written this way).** Add `// eslint-disable-next-line no-promise-executor-return -- <one-line rationale>`. This costs one of the budgeted 5 disables.

### 3.3 Verification

```bash
cd /root/BugHunter
npm run lint                    # should now pass (zero errors, zero warnings)
npm run typecheck               # unchanged
npm run test                    # unchanged
```

The fix lands in this same Stage 2 PR (one commit, one rationale). It is **not** a separate PR; the goal is to deliver a green `npm run lint` at level error in one go.

---

## 4. Drift verification: scan for violations re-introduced since PR #17

Before flipping the rule, run an explicit scan to catch any `strict-boolean-expressions` violations that may have been introduced by the v0.5 + v0.7 PRs landed since Stage 1.

### 4.1 Scan command

```bash
cd /root/BugHunter

# Run eslint with strict-boolean-expressions promoted locally to 'error',
# without modifying the committed config. This is a verification-only run.
ESLINT_TEMP_RULE_OVERRIDE='{"@typescript-eslint/strict-boolean-expressions":["error",{"allowString":false,"allowNumber":false,"allowNullableObject":false,"allowNullableBoolean":false,"allowNullableString":false,"allowNullableNumber":false,"allowAny":false}]}' \
  npx eslint packages/*/src --rule "@typescript-eslint/strict-boolean-expressions: ['error', { allowString: false, allowNumber: false, allowNullableObject: false, allowNullableBoolean: false, allowNullableString: false, allowNullableNumber: false, allowAny: false }]" \
  --max-warnings 0 \
  2>&1 | tee /tmp/sbe-stage2-scan.log
```

Simpler equivalent (no env shenanigans — eslint accepts inline rule overrides via `--rule`):

```bash
cd /root/BugHunter
npx eslint packages/*/src \
  --rule "@typescript-eslint/strict-boolean-expressions: ['error', { allowString: false, allowNumber: false, allowNullableObject: false, allowNullableBoolean: false, allowNullableString: false, allowNullableNumber: false, allowAny: false }]" \
  2>&1 | tee /tmp/sbe-stage2-scan.log
```

### 4.2 Expected outputs

**Scenario A — Zero `strict-boolean-expressions` errors.** This is the desired state. Stage 2 reduces to a one-line config flip + a clean `npm run lint` run (assuming §3 is also resolved).

**Scenario B — N `strict-boolean-expressions` errors are flagged.** The scan reveals drift. For each violation:

1. Apply the appropriate bucket fix from `SPEC_LINT_PHASE_2_5.md` §3 (Buckets A through I).
2. Cross-check `SPEC_LINT_PHASE_2_5.md` §4 — if the violation pattern matches one of the documented bug candidates (B-1 through B-12), apply the bug fix instead of the mechanical pattern.
3. Add a unit test if the underlying logic was wrong (matches a bug-candidate pattern).
4. Re-run the scan; iterate until zero.

The Stage 1 spec's bucket reference is the contract — do not invent new patterns. If a violation doesn't fit any documented bucket, escalate to `@architect` rather than silently inventing a fix.

### 4.3 Files most likely to drift

The cleanup pattern from Stage 1 stayed inside `packages/cli/src/`, but the v0.5 / v0.7 PRs added the following new files (any of which may have new SBE violations):

- `packages/cli/src/security/auth-probes.ts`
- `packages/cli/src/security/dom-id-harvester.ts`
- `packages/cli/src/security/header-probe.ts`
- `packages/cli/src/security/header-rules.ts`
- `packages/cli/src/security/injection-palette.ts`
- `packages/cli/src/security/rate-limit-discovery.ts`
- `packages/cli/src/security/resource-id-extractor.ts`
- `packages/cli/src/security/xss-observer.ts`
- `packages/cli/src/phases/auth-flow.ts`
- `packages/cli/src/phases/cross-user.ts`
- `packages/cli/src/static/runner.ts`
- `packages/cli/src/static/sqlmap-runner.ts`
- `packages/cli/src/static/tools/*.ts` (semgrep/eslint/npm-audit adapters)

The scan in §4.1 covers all of these automatically — no special-casing needed. This list is for review-time triage if drift is found.

---

## 5. The Stage 2 change

### 5.1 The single edit

`eslint.config.js`, line 21:

```diff
-      '@typescript-eslint/strict-boolean-expressions': ['warn', {
+      '@typescript-eslint/strict-boolean-expressions': ['error', {
```

The strictness options block (`allowString: false, ...`) is unchanged — Stage 1 already used the strictest configuration.

### 5.2 No other changes

- No code changes in this PR **beyond** §3 and §4 (clearing pre-existing errors and any drift discovered during the scan).
- No comment edits (the "intentionally deferred" comment was already removed in Stage 1).
- No `package.json` changes.
- No new dependencies.

---

## 6. Test plan

### 6.1 Pre-flight (verifies §3 is clean)

```bash
cd /root/BugHunter
npm run typecheck            # must pass — Stage 2 does not touch TS
npm run lint                 # must pass — §3 fix landed
npm run test                 # must pass — Stage 2 does not touch tests
npm run build                # must succeed
```

### 6.2 Drift scan (verifies §4)

```bash
npx eslint packages/*/src \
  --rule "@typescript-eslint/strict-boolean-expressions: ['error', { allowString: false, allowNumber: false, allowNullableObject: false, allowNullableBoolean: false, allowNullableString: false, allowNullableNumber: false, allowAny: false }]"
# Expected: zero output (clean exit code 0).
```

### 6.3 Promotion (the actual change)

```bash
# Edit eslint.config.js per §5.1
# Then:
npm run lint                 # must pass with zero output
```

### 6.4 Negative check — verify the rule is now blocking

Add a deliberate violation (do not commit) to confirm the promotion took effect:

```ts
// Temporarily in any source file:
const x: string | undefined = process.env.NODE_ENV;
if (x) console.log('hi');     // SBE error
```

Run `npm run lint`; expect an `error` (not `warning`) on this line. Revert the change.

This is an optional sanity check — `@coder` may skip it if confident in the toolchain.

### 6.5 Full regression

```bash
npm run typecheck && npm run lint && npm run test && npm run build
# All four must pass back-to-back.
```

---

## 7. Acceptance criteria

The Stage 2 PR is mergeable when **all** of the following hold:

1. `eslint.config.js` line 21 reads `'error'` (not `'warn'`) for `@typescript-eslint/strict-boolean-expressions`.
2. The strictness options block is unchanged from Stage 1 (all seven `allow*: false`).
3. `npm run lint` reports **zero** problems (zero errors, zero warnings).
4. `npm run typecheck` is green.
5. `npm run test` is green.
6. `npm run build` succeeds.
7. The pre-flight `no-promise-executor-return` error in `crawler.ts:155` is resolved (rewrite or one rationale-tagged disable).
8. Any drift discovered during §4.2 is fixed via the bucket patterns in `SPEC_LINT_PHASE_2_5.md` §3 (or escalated). PR description lists each drift hit (file:line, bucket applied) — even if it's zero.
9. **Maximum 0 new** `eslint-disable-next-line @typescript-eslint/strict-boolean-expressions` directives introduced in this PR. (Stage 1 budgeted 5 across the whole codebase; Stage 2 must not eat into that budget — the rule is now enforceable, no new escapes needed.)
10. The PR commit message uses `Lint: promote strict-boolean-expressions from warn to error (Stage 2)`.

---

## 8. Files

### 8.1 Files to modify

- `eslint.config.js` — single-line edit per §5.1.
- `packages/cli/src/discovery/crawler.ts` — fix the `no-promise-executor-return` error per §3.
- **Drift-dependent.** Any files surfaced by the §4.2 scan. List them in the PR body.

### 8.2 Files NOT to touch

- `packages/cli/src/types.ts`
- `packages/cli/src/cli/main.ts`
- Any test file (Stage 2 changes no behavior).
- `package.json` / `package-lock.json`
- Any spec file in the repo root (do not amend `SPEC_LINT_PHASE_2_5.md`).

### 8.3 Files to create

- None.

---

## 9. Risk

### R-1 — Drift is larger than expected

If §4.2 surfaces > 20 violations, Stage 2 grows from a one-line PR to a small cleanup PR. **Mitigation:** the bucket patterns are documented; the work is mechanical. If > 50 violations surface, escalate to `@architect` — that level of drift suggests a CI gap that needs investigation **before** the promotion lands.

### R-2 — `no-promise-executor-return` fix breaks unrelated tests

The crawler executor return is in a piece of crawl-state-management code. **Mitigation:** the `npm run test` suite covers `discovery/crawler.test.ts`; run it after the fix and before committing. If a behavior change is detected, escalate.

### R-3 — `--rule` override syntax differs across eslint versions

The §4.1 scan uses `eslint --rule` with an inline rule object. Eslint 9 (which the repo uses) accepts this; older eslint versions may not. **Mitigation:** the repo is pinned to eslint 9.27.0 (see `package.json`); the override syntax is supported.

### R-4 — A future PR introduces a violation that this rule should catch but doesn't

`strict-boolean-expressions` is comprehensive but has known edge cases (e.g. a value typed as `'foo' | 'bar'` may not fire because the rule only flags nullable / empty-string-permitting types). **This is a Phase 2.5 gap, not a Stage 2 gap.** Document any new edge case as a Phase 2.6 candidate; do not block Stage 2 on it.

### R-5 — `@typescript-eslint/eslint-plugin` major version bump

The plugin is pinned to `8.59.1` in `package.json`. If a future PR bumps to 9.x and changes the rule defaults, Stage 2's behavior may shift. **Mitigation:** the strictness options block is explicit (all `allow*: false`); even if defaults change, our config is unaffected. Document in the PR body that the strict options stand on their own merit, not on plugin defaults.

### R-6 — Type-aware lint timeouts on slow CI

Type-aware lint (`@typescript-eslint/strict-boolean-expressions` is type-aware) can take 10-30s on a cold cache. **Mitigation:** CI already runs the full type-aware lint per the existing `ESLINT_FAST` machinery; Stage 2 does not change that. No new perf risk.

---

## 10. Open questions

- **OQ-1.** Should we run `lint:fast` in CI as a sibling check? **Decision:** out of scope for Stage 2; the existing `lint` script is the gate. If `lint:fast` becomes a CI hook later, it skips type-aware rules — not a Stage 2 concern.
- **OQ-2.** The roadmap mentions Phase 2.6 (flipping `noUncheckedIndexedAccess: true`). When does that land? **Decision:** out of scope. Phase 2.6 is its own spec; Stage 2 is the close-out for Phase 2.5.
- **OQ-3.** Should the PR include a CI badge update or README mention of the promoted rule? **Decision:** no. The eslint config is the contract; README does not need to track per-rule severities.

---

## 11. Estimated effort

If §4.2 finds zero drift: **15 minutes** (one-line config edit + lint run + crawler.ts fix).

If §4.2 finds 1-10 drift hits: **30-60 minutes** (apply bucket fixes from `SPEC_LINT_PHASE_2_5.md` §3).

If §4.2 finds 11-30 drift hits: **2-4 hours** (mechanical but high-touch).

If §4.2 finds > 30 drift hits: **escalate to `@architect`** — that level of drift indicates a process gap that must be resolved before the promotion.

The expected case (Scenario A) is the 15-minute path; the spec is sized for that. Anything more is a sign Stage 1 didn't actually hold the line.

---

End of spec.
