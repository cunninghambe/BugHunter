# SPEC: Phase 2.5 — `strict-boolean-expressions` cleanup

Status: ready for `@coder` implementation
Branch base: `main`
Lint config touched: `eslint.config.js` (one-line addition)
Total measured violations (strictest options, current main): **184**

## 1. Problem

`@typescript-eslint/strict-boolean-expressions` flags every implicit truthy
coercion in conditionals (`if`, `&&`, `||`, ternary, predicate returns). It is
the single highest-yield TypeScript bug-finder for this codebase because
BugHunter routinely handles values where `0`, `""`, and `false` are not just
"missing" — they are valid signals (HTTP `status: 0`, empty CSS selector,
empty action-log entry, `limit: 0`).

The rule is configured (per Phase 2.5 plan) in **strictest mode**:

```js
'@typescript-eslint/strict-boolean-expressions': ['warn', {
  allowString: false,
  allowNumber: false,
  allowNullableObject: false,
  allowNullableBoolean: false,
  allowNullableString: false,
  allowNullableNumber: false,
  allowAny: false,
}]
```

Every truthy check must be explicit. No exceptions outside `// eslint-disable-next-line`
escape hatches with a one-line rationale.

## 2. Measurement (actual count, run on this branch)

After enabling the rule with the strictest options on
`main` (commit base of this spec), `npm run lint` produces:

| Bucket (rule message)                                                               | Count |
| ----------------------------------------------------------------------------------- | ----: |
| Unexpected nullable object value in conditional                                     |    67 |
| Unexpected nullable string value in conditional                                     |    60 |
| Unexpected string value in conditional                                              |    27 |
| Unexpected nullable boolean value in conditional                                    |    18 |
| Unexpected nullable number value in conditional                                     |     5 |
| Unexpected any value in conditional                                                 |     3 |
| Unexpected nullable boolean value in array predicate return type                    |     2 |
| Unexpected number value in conditional                                              |     1 |
| Unexpected value in conditional (discriminated union with `undefined`)              |     1 |
| **Total**                                                                           | **184** |

(The pre-spec estimate was 163. The current count is 184; the codebase grew
between the estimate and now, primarily under `discovery/` and `phases/`.)

### Per-file top 10 (target order for the cleanup PR)

| Count | File |
| ----: | ---- |
| 21 | `packages/cli/src/phases/discover.ts` |
| 21 | `packages/cli/src/phases/execute.ts` |
| 13 | `packages/cli/src/adapters/browser-mcp-snapshot.ts` |
| 12 | `packages/cli/src/adapters/browser-mcp.ts` |
| 11 | `packages/cli/src/cli/run.ts` |
| 11 | `packages/cli/src/discovery/crawler.ts` |
|  8 | `packages/cli/src/cli/main.ts` |
|  8 | `packages/cli/src/discovery/browser-login.ts` |
|  8 | `packages/cli/src/phases/cluster.ts` |
|  7 | `packages/cli/src/ops/retest.ts` |

Remaining 64 violations are spread across 20 files (≤6 each).

## 3. Per-bucket cleanup pattern

Each bucket has a default fix. Bug candidates in §4 override the default —
do not apply the mechanical fix to a violation listed there without first
fixing the underlying logic.

### Bucket A — `nullable object` (67)

Pattern — value is `T | null | undefined` where `T` is an object/array/regex match.
Default fix: explicit non-null check.

```ts
// Before
if (refMatch) { ... }
if (!cluster) throw ...
if (!browser && uiQueue.length > 0) ...

// After
if (refMatch !== null) { ... }
if (cluster === undefined) throw ...
if (browser === undefined && uiQueue.length > 0) ...
```

For boolean expressions with multiple object/string operands, prefer the
explicit form per operand. **Do not use `!= null`** — the project's `eqeqeq`
rule allows `null` comparisons but the pattern is to be specific.

Examples:

* `adapters/browser-mcp-snapshot.ts:35` `if (!refMatch) continue;`
  → `if (refMatch === null) continue;`
* `phases/cluster.ts:200` `if (toolId) return ...;`
  → `if (toolId !== undefined) return ...;` (also see §4 Bug B-2 for empty-string semantics)
* `ops/retest.ts:46` `if (!cluster) throw ...;`
  → `if (cluster === undefined) throw ...;`
* `phases/discover.ts:246` `if (!browser || !visionClient || ...) return [];`
  → `if (browser === undefined || visionClient === undefined || visionBudget === undefined || config.vision?.enabled !== true) return [];`

### Bucket B — `nullable string` (60)

Pattern — value is `string | null | undefined`.
Default fix: explicit `!== undefined` (or `!== null` if the type is `string | null`).
**Do not collapse undefined and `""` unless §4 confirms the empty-string case is invalid.**

```ts
// Before
if (entry.selector) await browser.click(entry.selector);
const browser = config.browserMcpUrl ? new Adapter(config.browserMcpUrl) : undefined;

// After (mechanical, when empty-string is not a valid signal)
if (entry.selector !== undefined && entry.selector !== '') {
  await browser.click(entry.selector);
}
const browser = config.browserMcpUrl !== undefined && config.browserMcpUrl !== ''
  ? new Adapter(config.browserMcpUrl)
  : undefined;
```

For the very common "default to a fallback" pattern, prefer **nullish coalescing**:

```ts
// Before
const x = optional || 'fallback';
// After (preserves "" as a valid value)
const x = optional ?? 'fallback';
```

Use `??` only when an empty string is a legitimate value. Otherwise keep `||`
but rewrite the condition explicitly (`optional !== undefined && optional !== ''`).

### Bucket C — `string` standalone (27)

Pattern — value is `string` (not nullable). The rule fires because `""` is
treated as a different signal than non-empty.
Default fix: explicit `!== ''` (or `length > 0`).

```ts
// Before
if (!line) continue;
if (!route) return '/';

// After
if (line === '') continue;
if (route === '') return '/';
```

Several violations here are CLI argv access (`args[0]`) where the underlying
type is `string` because of `noUncheckedIndexedAccess` being off; the
mechanical fix is to compare against `length` of the parent array. See §9.

### Bucket D — `nullable boolean` (18)

Pattern — value is `boolean | null | undefined`. Common in optional config flags.
Default fix: explicit `=== true` / `=== false` comparison.

```ts
// Before
if (self.capabilities.enumerateRoutesRuntime) return [];
const config = opts?.noInteractive ? a : b;

// After
if (self.capabilities.enumerateRoutesRuntime !== true) return [];
const config = opts?.noInteractive === true ? a : b;
```

Note: `=== true` is intentionally narrow (treats `undefined` as "not enabled").
This matches the existing project convention of `flags['reset'] === true` (used
already in `cli/main.ts`).

### Bucket E — `nullable number` (5)

Pattern — value is `number | null | undefined`. Almost always semantically
loaded — `0` may or may not be a valid value.
Default fix: explicit per-call decision.

```ts
// Before (count check)
if (samples?.samples.length) ...
if (cluster.relatedClusterIds?.length) ...

// After (count > 0 is the intent — the rule wants explicit)
if ((samples?.samples.length ?? 0) > 0) ...
if ((cluster.relatedClusterIds?.length ?? 0) > 0) ...
```

```ts
// Before (status / limit — see §4)
if (callResult.status) ...           // BUG — see B-1
if (args.limit) clusters.slice(...); // BUG — see B-3
```

### Bucket F — `number` standalone (1)

```
phases/discover.ts:155
  ? dedupRoutes.filter(r => !micromatch([r.route], excluded).length)
```

Mechanical:

```ts
? dedupRoutes.filter(r => micromatch([r.route], excluded).length === 0)
```

### Bucket G — `any` (3)

All three are in `surface-mcp.ts` reading `parsed.error` / `json.error` typed
as `unknown`. Default fix: narrow to "present" via explicit nullish check.

```ts
// Before
if (parsed.error) throw ...

// After
if (parsed.error !== undefined && parsed.error !== null) throw ...
```

### Bucket H — `nullable boolean` in array predicate return type (2)

Both are in `phases/discover.ts` filter callbacks where one operand is a
`boolean | undefined` config flag. Filter predicates returning `undefined` are
silently coerced to `false`, which keeps the existing "missing flag = exclude"
behavior — but the rule wants the predicate to return a real boolean.

```ts
// Before
.filter(t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed)

// After
.filter(t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed === true)
```

### Bucket I — `Unexpected value in conditional` (1)

`packages/cli/src/cli/run.ts:182` — `if (abortReason)` where
`abortReason: 'budget' | 'max_clusters' | 'max_infra_failures' | 'timeout' | undefined`.
Mechanical: `if (abortReason !== undefined)`.

## 4. Bug candidates (NOT mechanical)

These violations look like real bugs or latent gaps. **Each must be resolved
by the @coder via a logic change — not the mechanical pattern.** If the @coder
disagrees after reading the surrounding code, escalate to @architect; do not
silently apply the mechanical fix.

### B-1 — `phases/execute.ts:505` — HTTP status `0` is silently dropped

```ts
// Network classification via status
if (callResult.status) {
  const req: NetworkRequest = { method: 'POST', path: tc.action.toolId, status: callResult.status, ... };
  bugs.push(...classifyNetworkRequests([req], tc.expectedOutcome, true));
}
```

`callResult.status: number | undefined` (`SurfaceCallResult.status`). Status `0`
is the canonical XHR signal for "request never completed" (network failure,
CORS rejection, abort). The current code treats `status === 0` identically to
"no status field at all" and **never enters network classification** — so a
real connectivity bug becomes invisible.

**Fix:** treat `undefined` as "no status reported" and `0` as a real signal:

```ts
if (callResult.status !== undefined) {
  const req: NetworkRequest = { method: 'POST', path: tc.action.toolId, status: callResult.status, ... };
  bugs.push(...classifyNetworkRequests([req], tc.expectedOutcome, true));
}
```

If `classifyNetworkRequests` does not handle status `0`, that's a follow-up —
add the test, add the case, then ship.

### B-2 — `packages/mcp/src/tools.ts:140` — `limit: 0` silently returns full list

```ts
if (args.limit) clusters = clusters.slice(0, args.limit);
```

`args.limit` is declared `z.number().int().optional()` — so `0` is a legal
caller value. `clusters.slice(0, 0)` would (correctly) return an empty array,
but the truthy check skips the slice and the caller receives the **full list**
when they explicitly asked for zero results. This is silent caller breakage.

**Fix:** explicit undefined check, OR tighten the schema.

```ts
if (args.limit !== undefined) clusters = clusters.slice(0, args.limit);
```

If the product intent is "limit must be ≥ 1," update the Zod schema instead:
`z.number().int().positive().optional()`. **Pick one** — current code does
neither. @coder: prefer the schema tightening.

Same line: `if (args.kind)` (line 139) — `kind: string | undefined`. An empty
string filter would match no clusters. The rule fires here too. Mechanical
`!== undefined` is correct **and** the Zod schema should reject empty strings:
`z.string().min(1).optional()`.

### B-3 — `cli/init.ts:40-41` and `:50-51` — interactive default + `|| undefined` is dead code

```ts
const surfaceMcpUrl = await rl.question('SurfaceMCP URL [http://127.0.0.1:3102]: ') || 'http://127.0.0.1:3102';
const browserMcpUrl = await rl.question('Browser MCP URL [http://127.0.0.1:3100]: ') || 'http://127.0.0.1:3100';
const resetCommand = await rl.question('Reset command (e.g. npm run db:seed): ');
const resetPolicy  = await rl.question('Reset policy [per-page]: ') || 'per-page';

return {
  ...
  browserMcpUrl: browserMcpUrl || undefined, // ← line 50, dead branch
  resetCommand: resetCommand || undefined,
  ...
};
```

After line 41, `browserMcpUrl` is always a non-empty string (defaults applied).
At line 50, `browserMcpUrl || undefined` is therefore **always** the URL —
the `|| undefined` branch can never fire. Compare with `resetCommand`
which is *not* defaulted on line 42 and so genuinely needs the `|| undefined`
collapse on line 51. The bug is that the interactive flow forces a browser
URL even when the user wants to leave it unset, while the non-interactive
flow (line 75) correctly defaults to `undefined`.

**Fix:** drop the `|| 'http://127.0.0.1:3100'` default on line 41 (browser is
optional and the non-interactive flow already treats it as such), then the
`browserMcpUrl || undefined` on line 50 starts doing real work.

```ts
const browserMcpUrl = await rl.question('Browser MCP URL (blank to skip): ');
// ...
browserMcpUrl: browserMcpUrl !== '' ? browserMcpUrl : undefined,
```

Apply the same explicit form to the other two interactive defaults (`?? '...'`
won't work because `rl.question` returns `string`, not `string | undefined`):

```ts
const surfaceMcpUrl = (await rl.question('SurfaceMCP URL [http://127.0.0.1:3102]: ')) || 'http://127.0.0.1:3102';
// → surfaceMcpUrl is always non-empty; emit as-is, no `|| undefined` needed
```

### B-4 — `repro/replay.ts:67/71/75` and `phases/execute.ts:225/228/231/236` — empty selector silently no-ops

In replay and execute, an action with an empty `selector` is silently skipped:

```ts
case 'click':
  if (entry.selector) await browser.click(entry.selector);
  break;
```

If an action log was recorded with an empty selector (a planning bug, a
trigger-resolve regression, a corrupted file), the replayer/executor reports
**success** because the click never happened. Same for `fill`, `submit`,
`navigate`. This breaks the "replay verifies the action ran" invariant.

**Fix:** distinguish "selector intentionally absent" (some `entry.kind`s
support no selector) from "selector empty" (logic error). Throw on empty.

```ts
case 'click':
  if (entry.selector === undefined) throw new Error('replay: click action missing selector');
  if (entry.selector === '') throw new Error('replay: click action has empty selector — corrupted log?');
  await browser.click(entry.selector);
  break;
```

If the existing per-`kind` schema already guarantees `selector` for `click` /
`fill` / `submit`, the `=== undefined` branch is type-only; keep the
`=== ''` runtime guard.

Apply the same treatment in `phases/execute.ts:225-236`.

### B-5 — `phases/cluster.ts:204` — `match[1]` empty-string case unreachable but the assertion is wrong

```ts
const match = /links to (\S+) which returned/.exec(cluster.rootCause);
if (match?.[1]) return `path:${normalizePath(match[1])}`;
```

The regex `(\S+)` guarantees ≥1 non-space char, so `match[1]` cannot be empty
**at runtime**. The truthy check then conflates "no match" with "match[1]
empty," which is fine today but couples the validity of this branch to the
exact regex shape. If someone later loosens the regex to `(\S*)`, the empty
group will silently be skipped.

**Fix:** mechanical `!== undefined`, but add a one-line comment that documents
the regex invariant.

```ts
// Regex requires \S+ — match[1] is non-empty when it's defined.
if (match?.[1] !== undefined) return `path:${normalizePath(match[1])}`;
```

Not strictly a bug today; flagged for review during cleanup.

### B-6 — `cli/run.ts:122` — `opts.reset && resolved.resetCommand` mixes two semantics

```ts
if (opts.reset && resolved.resetCommand) {
  ...execSync(resolved.resetCommand, ...);
}
```

`opts.reset: boolean | undefined`, `resolved.resetCommand: string | undefined`.
Empty `resetCommand` would be silently swallowed (no reset, no warning) — but
empty resetCommand is a config error, not a "skip reset" signal. The
non-interactive init in `init.ts:75-80` allows undefined; nothing in the Zod
schema rejects `""`.

**Fix:** mechanical (`opts.reset === true && resolved.resetCommand !== undefined && resolved.resetCommand !== ''`)
**plus** add `.min(1)` to the `resetCommand` Zod field in `config.ts`. If
`opts.reset === true` but no command is configured, log a warning ("--reset
specified but no resetCommand configured; ignoring").

### B-7 — `discovery/crawler.ts:165` — empty-router-list logged as `'none'`

```ts
log.info(`runtime_enum: ${post.summary.detectedRouters.join(',') || 'none'}, ...`);
```

This is a pure logging concern, but it conflates "no routers detected" with
"routers detected but all empty strings" — the latter would be a SurfaceMCP
contract violation worth flagging. Mechanical fix is fine but consider
`detectedRouters.length === 0 ? 'none' : detectedRouters.join(',')`.
Not a true bug; flagged for awareness.

### B-8 — `phases/cluster.ts:123` — empty `testId` defeats state lookup

```ts
const captured = occ.testId ? stateByTestId?.get(occ.testId) : undefined;
```

`occ.testId: string | undefined`. Empty `testId` would skip `stateByTestId.get`
and silently fall back to the synthesised `preState` / `postState`. The runtime
contract is "every executed test has a non-empty testId" — see `cluster.ts:77`
which throws on empty `occId`. Inconsistent: `occId` throws, `testId`
silently degrades.

**Fix:** mechanical (`!== undefined && !== ''`) + log a warning when
`captured === undefined` for an `occ` with `testId !== undefined`.

### B-9 — `discovery/browser-login.ts:293` — `currentUrl !== loginUrl` skipped when URL empty

```ts
if (currentUrl && currentUrl !== loginUrl) { ... }
```

`currentUrl: string`. Empty `currentUrl` would skip the success check entirely.
If the browser returns an empty URL after submit (page in a weird transient
state), this silently treats it as "still on login" — which then triggers
the failure branch downstream. Logic is probably correct (empty URL == not
ready) but mechanical `=== ''` would lose the subtlety.

**Fix:** explicit form preserves intent:

```ts
if (currentUrl !== '' && currentUrl !== loginUrl) { ... }
```

If empty currentUrl should produce a different signal than "still on login,"
add a `else if (currentUrl === '')` branch with a `log.debug`.

### B-10 — `discovery/element-collapse.ts:9` — empty `testId` collapses with all other empties

```ts
const testIdPrefix = el.testId ? el.testId.split(':')[0] : '';
```

`el.testId: string | undefined`. Both undefined and empty produce `''`, so
distinct DOM elements with `data-testid=""` (legal HTML) collide with elements
that have **no** `data-testid` at all in the collapse signature. Not a
crash bug, but a deduplication false-positive.

**Fix:** treat empty testId as a distinct signal:

```ts
let testIdPrefix: string;
if (el.testId === undefined) testIdPrefix = '';
else if (el.testId === '') testIdPrefix = '<empty>';
else testIdPrefix = el.testId.split(':')[0] ?? '';
```

Lower priority — if `data-testid=""` is rare in practice, leave a TODO and
move on. **At minimum, mechanical fix + comment.**

### B-11 — `adapters/browser-mcp.ts:307` and `:406` — empty `outputPath` writes nothing

```ts
async screenshot(outputPath?: string) { ...
  if (outputPath) {
    fs.writeFileSync(outputPath, ...);
    return { path: outputPath, data: base64 };
  }
  return { data: base64 };
}
```

If a caller passes `outputPath: ""`, no file is written and the caller
receives `{ data }` with no `path` — but the type signature is
`outputPath?: string`, so the caller has no way to express "skip writing"
distinct from "I forgot to set the path." Today `outputPath: ""` is treated
identical to `undefined`, which silently masks the misuse.

**Fix:** mechanical + assertion.

```ts
if (outputPath !== undefined) {
  if (outputPath === '') throw new Error('screenshot: outputPath is empty');
  fs.writeFileSync(outputPath, ...);
  return { path: outputPath, data: base64 };
}
```

### B-12 — `mutation/domain-hints.ts:28` — empty domain hint silently treated as "missing"

```ts
const hint = domainHints?.[type]?.[0];
if (!hint) {
  log.warn(`No domain hint for ${type} — skipping happy-path value`);
}
return hint;
```

`hint: string | undefined`. Empty string hint **does** log "no domain hint"
but **also** returns the empty string — the warning is inconsistent with the
return value. Caller receives `''` as the happy-path value, which downstream
becomes an empty-string param.

**Fix:**

```ts
if (hint === undefined || hint === '') {
  log.warn(`No domain hint for ${type} — skipping happy-path value`);
  return undefined;
}
return hint;
```

### Bug-candidate summary

12 candidates total: B-1 through B-12. Of these:

* **3 are real bugs requiring logic changes** (B-1, B-2, B-3) — high priority.
* **3 are silent-degradation gaps that should throw or warn** (B-4, B-11, B-12).
* **3 are inconsistencies between sibling code paths** (B-6, B-8, B-9).
* **3 are robustness flags / TODOs** (B-5, B-7, B-10) — mechanical fix + comment is acceptable.

## 5. Stage strategy

The cleanup is **two PRs**, gated by spec review at each step.

### Stage 1 — Land the rule as `warn`, fix violations file-by-file

`@coder` task in this PR:

1. Add the rule to `eslint.config.js` at level `'warn'` (not error). This
   keeps `npm run lint` (which enforces `--max-warnings 0`) red until all
   violations are resolved — but does not break unrelated CI.
2. Walk the per-file list (top to bottom in §2). For each file:
   * Read the §3 bucket pattern.
   * Cross-check §4 — if any line is in B-1 through B-12, apply the bug fix
     instead of the mechanical pattern.
   * Apply mechanical fixes for the rest.
   * Run `npm test -w packages/cli` after every file — do not batch.
3. After all 184 violations are zero, run the full verification suite
   (§6) and commit.
4. Open a single PR titled "Lint: clean up Phase 2.5 strict-boolean violations
   + 12 latent bug fixes."

### Stage 2 — Promote `warn` → `error` (separate PR)

Once Stage 1 lands and CI is green:

1. Change the rule to `'error'` in `eslint.config.js`.
2. Run `npm run lint` to confirm zero violations.
3. Commit "Lint: promote strict-boolean-expressions to error."

This two-stage approach matches the Phase 1 / Phase 2 pattern and keeps the
diff reviewable.

## 6. Test plan

For Stage 1:

```bash
# 0. Sanity: pre-cleanup baseline (capture before the cleanup commit)
cd /root/BugHunter
npm run typecheck    # must pass
npm run test         # must pass
npm run lint         # currently red on the 184 SBE warnings; that is expected

# 1. After EACH file's cleanup, smoke the unit tests for that area:
npx vitest run packages/cli/tests/<area>     # whichever is closest

# 2. After all files are clean:
npm run typecheck                            # zero errors
npm run lint                                 # zero warnings (--max-warnings 0)
npm run test                                 # all green
npm run build                                # succeeds

# 3. Bug-candidate verification (§4):
#    Add unit tests for every B-x where one is missing today:
#    - B-1: classifyNetworkRequests called with status=0 input shape
#    - B-2: bughunt_latest_bugs handler returns [] when limit=0 (or asserts schema rejection)
#    - B-3: init non-interactive vs interactive parity (both produce identical config when blank input ≡ flag absent)
#    - B-4: replay throws on empty selector for click/fill/submit
#    - B-11: screenshot throws on empty outputPath
#    - B-12: domain-hints returns undefined for empty hint
```

Existing tests must continue to pass without modification. The cleanup is
**behavior-preserving for mechanical fixes** — only the bug fixes (§4) intentionally
change behavior, and each is paired with a new test.

## 7. Risk

The rule has known overreach in three patterns. Reviewers should accept these
documented escapes without complaint; @coder may use them where the type is
already correct.

### R-1 — Already-correct `Boolean(x)` / `!!x` wraps

`phases/discover.ts:41` already does `!!browser` to be explicit — yet the rule
still fires on the surrounding `&&` chain because the *first* operand is
nullable boolean. **Do not** add a redundant Boolean wrap; rewrite the whole
chain explicitly per Bucket D. The `!!` itself is fine.

### R-2 — Predicate return types

Bucket H violations are array predicate returns. The fix is to add `=== true`
on the nullable operand; do **not** wrap the whole expression in `Boolean(...)`
(produces a worse diff for no benefit).

### R-3 — `eslint-disable-next-line` is allowed only with rationale

If a violation is genuinely intentional (e.g. accumulating candidate strings
where empty really does mean "skip"), use:

```ts
// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- empty string is a valid skip signal
if (textContent) candidates.push(textContent);
```

Rationale must be one line, must explain *why* the truthy form is intentional.
"because the test passes" is not acceptable. **Maximum 5 disables across the
whole cleanup PR.** If the cleanup needs more, escalate.

### R-4 — `prefer-nullish-coalescing` interaction

Several mechanical rewrites of `string | undefined` introduce new `??`
operators. The `prefer-nullish-coalescing` rule (warn) may flag adjacent
`||`-vs-`??` decisions. Resolve in favor of `??` when both branches are
type-correct; the test suite is the tiebreaker.

### R-5 — `noUncheckedIndexedAccess` is currently OFF

CLI argv access (`args[0]`, `rest[i+1]`) types as `string`, not `string | undefined`,
so the rule fires under "Unexpected string value." Fixing this *properly*
would require flipping `noUncheckedIndexedAccess: true` in `tsconfig.json` —
explicitly **out of scope** for Phase 2.5. Use the mechanical pattern
(`args.length === 0`) instead. Document this gap as a Phase 2.6 candidate
in the cleanup PR description.

## 8. Acceptance criteria

The Stage 1 PR is mergeable when **all** of the following hold:

1. `eslint.config.js` registers `@typescript-eslint/strict-boolean-expressions`
   at level `'warn'` with the strict options listed in §1. The
   "intentionally deferred" comment is removed.
2. `npm run lint` reports **zero** strict-boolean-expressions warnings.
3. `npm run lint` overall reports zero warnings (the project enforces
   `--max-warnings 0`).
4. `npm run typecheck` is green for both packages.
5. `npm run test` is green for both packages.
6. `npm run build` succeeds.
7. Every bug candidate in §4 (B-1 through B-12) is either:
   * **Fixed** with a logic change, with a unit test demonstrating the
     fixed behavior (preferred for B-1, B-2, B-3, B-4, B-11, B-12), **or**
   * **Documented in-line** with an `eslint-disable-next-line` and a
     one-line rationale explaining why the truthy form is intentional
     (acceptable only for B-5, B-7, B-10 if @coder concludes after re-reading
     that the current behavior is correct).
8. **Maximum 5** `eslint-disable-next-line @typescript-eslint/strict-boolean-expressions`
   directives across the entire codebase after Stage 1.
9. PR body lists the 12 bug candidates with each one marked **fixed** or
   **disabled-with-rationale**.

The Stage 2 PR (rule → error) is a separate one-line config change with no
violations to fix. Acceptance: `npm run lint` is green at level `error`.

## 9. Files to touch

Top 10 by violation count (already in §2). Full list below — all 30 files
that contain at least one violation:

```
packages/cli/src/phases/discover.ts                  21
packages/cli/src/phases/execute.ts                   21
packages/cli/src/adapters/browser-mcp-snapshot.ts    13
packages/cli/src/adapters/browser-mcp.ts             12
packages/cli/src/cli/run.ts                          11
packages/cli/src/discovery/crawler.ts                11
packages/cli/src/cli/main.ts                          8
packages/cli/src/discovery/browser-login.ts           8
packages/cli/src/phases/cluster.ts                    8
packages/cli/src/ops/retest.ts                        7
packages/cli/src/adapters/surface-mcp.ts              6
packages/cli/src/cli/init.ts                          6
packages/cli/src/classify/vision.ts                   5
packages/cli/src/mutation/apply.ts                    5
packages/cli/src/phases/validate.ts                   5
packages/cli/src/cli/inspect.ts                       4
packages/cli/src/mutation/domain-hints.ts             4
packages/cli/src/repro/replay.ts                      4
packages/cli/src/cli/replay.ts                        3
packages/cli/src/discovery/trigger-resolve.ts         3
packages/mcp/src/tools.ts                             3
packages/cli/src/cluster/normalize.ts                 2
packages/cli/src/cluster/signature.ts                 2
packages/cli/src/discovery/dom-walker.ts              2
packages/cli/src/discovery/filesystem-pages.ts        2
packages/cli/src/phases/classify.ts                   2
packages/cli/src/phases/emit.ts                       2
packages/cli/src/phases/plan.ts                       2
packages/cli/src/discovery/element-collapse.ts        1
packages/cli/src/discovery/pages.ts                   1
```

Plus:

```
eslint.config.js              (one-line addition: register the rule)
packages/cli/src/config.ts    (B-6: tighten Zod for resetCommand to .min(1))
packages/mcp/src/tools.ts     (B-2: tighten Zod for limit/kind in bughunt_latest_bugs)
```

Plus tests for each fixed bug candidate (B-1, B-2, B-3, B-4, B-11, B-12).

Suggested commit shape: **one cleanup commit per file** plus **one
bug-fix commit per B-x with its test**, all on a single feature branch.
~30 mechanical commits + ~6 bug-fix commits ≈ 36 commits in Stage 1.
That's larger than usual; the small-commit rule is more important than the
ceremony — review will be much easier.

## 10. Open questions

* **OQ-1.** Is `data-testid=""` (literal empty value) used anywhere in the
  fixture corpus? If yes, B-10 must be a real fix. If no, it can be
  comment-only.
* **OQ-2.** Should `bughunt_latest_bugs` reject `limit: 0` at the schema
  level (B-2) or accept it and slice correctly? Product call. Default
  recommendation: tighten the schema (`positive()`).
* **OQ-3.** `phases/execute.ts:505` (B-1) — is `classifyNetworkRequests`
  prepared to accept `status: 0`? @coder should verify before applying the
  fix and add coverage if not.

Out-of-scope (Phase 2.6+):
* Flipping `noUncheckedIndexedAccess: true` (R-5).
* Tightening empty-string handling in `surface_call` Zod schemas
  (e.g. `toolId: z.string().min(1)` everywhere).
