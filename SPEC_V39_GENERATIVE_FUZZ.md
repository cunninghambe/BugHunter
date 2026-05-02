# SPEC — v0.39 "Generative / property-based fuzz"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor / hard dependency:** `SPEC_V32_DETERMINISTIC_MODE.md` (seed propagation; this spec assumes the V32 `RunSeed` and per-context derivation utilities exist) · **Sibling:** v0.5 mutation palette (the fixed palette this spec sits alongside, never replaces).

This spec adds a `--fuzz <strategy>` opt-in flag that augments the existing fixed mutation palette (`null`/`happy`/`edge`/`out_of_bounds`) with property-based generators. The fixed palette catches ~80% of input-class bugs at low compute cost. The remaining ~20% (Unicode normalization bugs, missing-required-field handlers, schema-boundary off-by-ones) require random generation. Per `SPEC_PATH_TO_EXHAUSTIVE.md` §3.4, the chosen library is `fast-check`; per §6.1 / V32, every fuzz draw is deterministic given the run seed; per §3.6 cluster-stability constraints, stochastic discoveries collapse to the same cluster signature on rerun so reruns do not fragment.

---

## 1. Objective

Add four property-based fuzz strategies (`unicode`, `shape`, `boundary`, `all`) that mint additional `TestCase` rows alongside (not in place of) the fixed palette. Tests are deterministic with seeded generation — same `--seed` plus same inputs yields byte-identical fuzz draws. Fuzz is off by default; runs are gated by `--fuzz <strategy>` and capped per-input via `--fuzz-runs <N>` (default 16, max 256).

**In scope:**
- A new `mutation/fuzz.ts` module exporting four strategy generators built on `fast-check`.
- Wiring in `mutation/apply.ts` so `formTestCases` and `apiTestCases` append fuzz cases when enabled.
- A new `PaletteVariant` family member: `'fuzz'` (single value; the strategy + seed disambiguate inside `TestCase.fuzzMeta`).
- Cluster-signature extension so two fuzz hits with different draws but same root cause collapse to one cluster (see §6).
- `--fuzz`, `--fuzz-runs`, `--fuzz-strategies` CLI flags + `runConfig.fuzz` config block.
- Determinism: seed propagates via the V32 `deriveSubSeed(runSeed, 'fuzz', formSig|toolId, fieldName)` utility.
- Failure-shrinking: rely on fast-check's built-in shrinker; minimal counterexample is recorded in `TestCase.fuzzMeta.shrunkValue` when the framework reports a shrunk reproduction.
- `fast-check` added as a `dependencies` (not `devDependencies`) entry in `packages/cli/package.json` — justified in §3.5.

**Out of scope (deferred):**
- Time-fuzz combined with V23 (DST/leap/Y2038) — separate V40 spec; the seed propagation pattern here is its blueprint.
- Multi-context fuzz (concurrent fuzz on N tabs) — V41; orthogonal to this work.
- Coverage-guided fuzz (libfuzzer-style feedback) — out of scope forever; we are black-box.
- Stateful fuzz (sequence of API calls with carried state) — V42; this spec does single-call only.
- Mutating user code or auto-fixing — fuzz reports findings; remediation is upstream of BugHunter.
- Replacing the fixed palette. The fixed palette stays the default and is never removed by this spec.

**Acceptance target on Aspectv3:**
With `--fuzz all --fuzz-runs 32 --seed 7777` set, the smoke produces:
- `summary.json.fuzz.enabled === true` and `summary.json.fuzz.strategies` lists the four strategies.
- `summary.json.fuzz.draws` is the integer count of fuzz `TestCase` rows minted.
- Two consecutive runs with the same seed produce byte-identical `bugs.jsonl` (per V32 acceptance), with fuzz cases included.
- ≥ 0 net new bug clusters allowed; the test that the run *completes* without error is the gate. Genuine new bug discoveries are bonus, not required.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/mutation/apply.ts` | `formTestCases` and `apiTestCases` are the two minting sites. Fuzz cases append onto the array these return. Do NOT fork these functions; pass an `options` arg through. |
| `packages/cli/src/mutation/palette.ts` | The fixed-palette generators. Pattern reference for per-`InputType` dispatch. Fuzz module mirrors this dispatch shape so per-type generators are co-located conceptually. |
| `packages/cli/src/types.ts` | `PaletteVariant`, `TestCase`, `FormField`, `ToolMeta`, `InputType`. ADD a `'fuzz'` variant to `PaletteVariant`. ADD an optional `fuzzMeta` field to `TestCase` (see §4.4). Do NOT split into a sibling type. |
| `packages/cli/src/config.ts` | `RunConfigSchema`. ADD a `fuzz` block (see §7). Do NOT introduce a new top-level config file. |
| `packages/cli/src/cli/run.ts` | Where CLI flags are parsed and merged into `resolved`. Fuzz flags wire here, then pass into the planner. |
| `packages/cli/src/phases/plan.ts` | Calls `formTestCases` / `apiTestCases`. Fuzz options thread through here. |
| `packages/cli/src/cluster/signature.ts` | Cluster signature derivation. EXTEND the relevant cases so fuzz draws cluster identically to fixed-palette draws — they MUST NOT add the random value into the signature. |
| `packages/cli/src/mutation/apply.test.ts` | Test pattern reference. Mirror with fuzz-specific test file. |
| `SPEC_V32_DETERMINISTIC_MODE.md` | V32 defines `RunSeed`, `deriveSubSeed`, and how the seed is materialized at run start. This spec consumes those. If V32 is not yet merged, fuzz wiring blocks on it. |

### 2.2 Patterns to follow

- **Per-type dispatch.** `fuzz.ts` exports one function per fuzz strategy that takes `(type: InputType, field: FormField, seed: SubSeed, runs: number)` and returns `MutationCase[]` with `variant: 'fuzz'`. Mirror `generatePaletteCases` shape.
- **Append, don't replace.** Existing palette cases ALWAYS mint. Fuzz appends only when the strategy is enabled for the matching surface (form vs API).
- **Seeded generation.** Call `fc.sample(arbitrary, { numRuns: N, seed: subSeed })` (not `fc.assert`). We are minting test cases, not running properties — so we want the generated values, not pass/fail outcomes. The shrinker is invoked separately at the executor layer when a fuzz case actually triggers a bug (see §5).
- **Discriminated-union returns.** `MutationCase` keeps its existing shape; `fuzz` is a `PaletteVariant` value, and `fuzzMeta` lives on `TestCase` (the test row), not on `MutationCase` (the value).
- **Telemetry.** `summary.json.fuzz` is the single fuzz telemetry field. No fuzz-specific log channels.

### 2.3 DO NOT

- Do **not** make fuzz the default. `--fuzz` MUST be opt-in. The default behavior of `bughunter run` with no flag MUST be byte-identical to the pre-V39 default.
- Do **not** use `fast-check`'s `fc.assert` in the planner. We are minting deterministic test rows, not running the framework's property loop. `fc.sample` is the correct API.
- Do **not** include the fuzz-drawn value in the cluster signature. If two runs draw different values that hit the same root cause, they MUST cluster together. The signature uses the same fields as the fixed-palette path (endpoint, error message normalization, status, etc.).
- Do **not** add per-strategy logging at info level — gate at debug. Fuzz can mint thousands of cases per run; flooding info would obscure real signals.
- Do **not** attempt coverage-guided generation, code instrumentation, or in-process fuzz. We are external-API fuzz only.
- Do **not** replace any existing `MutationCase` from the fixed palette. Fuzz only ever appends.
- Do **not** import `fast-check` outside `mutation/fuzz.ts`. Quarantine the dependency to one module so we can swap it later if needed.
- Do **not** persist the entire fuzz draw set to disk. Persist only the failing draw + the shrunken counterexample (V32 already mandates `bugs.jsonl` is the primary durable output).

---

## 3. Strategy subsections

Each strategy is a pure function `(type, field, subSeed, runs) → MutationCase[]`. All generators are byte-deterministic given identical `(field, subSeed, runs)`.

### 3.1 `unicode` — text/string fuzz

**Applies to:** `text`, `email` (local-part only — domain stays valid), `url` (path/query — scheme/host stay valid), `tel`, `slug`, `password`, plus any JSON-body string field on API tools.

**Arbitrary:** custom `unicodeStringArb` built from `fc.string` extended with:
- RFC 3629 valid 4-byte sequences (e.g. CJK `中文`, emoji `\u{1f600}`).
- RTL marks (`‮`, `‭`) and bidirectional override sequences.
- Zero-width characters: `​` (ZWSP), `‌` (ZWNJ), `‍` (ZWJ), `⁠` (word joiner), `﻿` (BOM).
- C0 control characters (`\x00-\x1f`) and DEL (`\x7f`).
- Combining marks (`̀-ͯ`) attached to ASCII bases.
- Surrogate-pair edge cases via `fc.unicodeString({ minLength: 1, maxLength: maxLen })` and explicit `fc.constantFrom(...curated)`.

**Length:** clamp output by `field.maxLength ?? 1024`. We respect declared schema bounds — fuzz of length is the `boundary` strategy's job, not `unicode`'s.

**Sample size:** `--fuzz-runs` (default 16) per field per surface.

**Curated seeds in `fc.constantFrom`:** approx. 30 known-malicious strings (Big List of Naughty Strings excerpt — keep MIT-license attribution in the file header). The arbitrary mixes generated and curated so a given seed deterministically picks among them.

### 3.2 `shape` — JSON shape mutations

**Applies to:** API tools only (forms have a fixed DOM shape; you cannot drop a `<input>`). Specifically `apiTestCases` and `xssApiTestCases` paths.

**Mutations applied to a base happy-path body (`samples[0]` or schema-derived defaults):**
1. **Drop a required field.** Pick a random `tool.inputSchema.required` member and `delete body[key]`. One draw per required field, capped by `--fuzz-runs`.
2. **Reorder keys.** `Object.keys(body)` permuted. Most servers don't care, but some JSON-body parsers and signature middlewares (HMAC over canonical JSON) do.
3. **Type-substitute.** Replace a string with a number, a boolean with a string, an array with an object, etc. Use `fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}))` per chosen field.
4. **Inject extra unknown key.** `body.__bughunter_unknown_field = '<random>'`. Detects servers that unsafely echo or trust unknown keys.
5. **Wrap top-level.** `{ data: <body> }` and `[<body>]` (array-wrap). Catches servers that accept loose top-level shapes.

**Skipped on safe methods.** GET/HEAD/OPTIONS — no body to mutate. (`isSafeMethod` already exists in `apply.ts`; reuse it.)

**Sample size:** runs are spread across the five mutation classes. With `--fuzz-runs 16`, that's 3-4 per class. Distribution is round-robin so each class gets at least one draw when `runs ≥ 5`.

### 3.3 `boundary` — schema-aware edge fuzz

**Applies to:** API tools with a non-empty `inputSchema.properties`. Forms with declared `min`/`max`/`minLength`/`maxLength`/`enum` on `FormField`.

**Generators per JSON Schema constraint (or `FormField` analog):**
- `enum: [a, b, c]` → draw from `enum` ∪ `[a + suffix, '__not_in_enum__', '']`. Suffix from `unicodeStringArb` so case-insensitive servers are stressed.
- `minimum: M` → draw from `[M-1, M, M+1, M+epsilon, -M]`.
- `maximum: M` → draw from `[M-1, M, M+1, MAX_SAFE_INTEGER, Infinity, NaN]`.
- `minLength: L` / `maxLength: L` → draw lengths around `L` (`L-1, L, L+1`) using `unicodeStringArb` — composes with `unicode` strategy when `all` is selected.
- `format: 'email' | 'date' | 'date-time' | 'uri' | 'uuid'` → known invalid-but-close values. For `uuid`: drop a hex digit, swap a hyphen, change the version nibble.
- `pattern: <regex>` → fast-check `fc.stringMatching` (when fast-check version supports it; fall back to curated near-misses otherwise).

**Sample size:** `--fuzz-runs` distributed across declared constraints. If a tool has 3 constrained fields × 2 boundary points each = 6 draws, and `--fuzz-runs 16`, we round-robin to fill 16 slots without duplicates.

### 3.4 `all` — combination

`all` runs `unicode`, `shape`, `boundary` in sequence with separately-derived sub-seeds (`deriveSubSeed(runSeed, 'fuzz-unicode', ...)`, `'fuzz-shape'`, `'fuzz-boundary'`). The total draw count is `--fuzz-runs × 3` per applicable surface — document this in `--help` so users picking `all` know the multiplier.

`--fuzz-strategies <list>` (comma-separated subset of `unicode,shape,boundary`) is an alternative spelling of `all` that lets users subset. If both `--fuzz` and `--fuzz-strategies` are passed, `--fuzz-strategies` wins. Empty `--fuzz-strategies` after parsing is an error.

---

## 4. fast-check integration

### 4.1 Dependency add

`packages/cli/package.json` `dependencies`:
```json
"fast-check": "3.23.2"
```
Pinned exact version (per `/root/.claude/CLAUDE.md`). 3.x is current as of 2026-04. Pure JS, zero runtime deps, ~50KB minified — well under the 20KB-gzipped justification threshold but justifiable because:
- Hand-rolling deterministic Unicode generators with proper shrinking is a multi-week project (fast-check has invested years).
- `fc.sample(arb, { numRuns, seed })` gives byte-identical output across machines and Node versions.
- `fc.pre` and shrinker contract are reused by V40 (time fuzz) and any future property work.
- Battle-tested: used by tc39 test262 author tooling and major TypeScript libs.

### 4.2 API surface used

Quarantined to `mutation/fuzz.ts`. Only these fast-check exports are imported:
- `fc.sample(arbitrary, { numRuns, seed })` — minting deterministic draws.
- `fc.string`, `fc.unicodeString`, `fc.integer`, `fc.float`, `fc.double`, `fc.boolean`, `fc.constantFrom`, `fc.oneof`, `fc.tuple`, `fc.record`, `fc.array`, `fc.constant` — primitive arbitraries.
- `fc.stringMatching` — pattern boundary, when present in the installed fast-check version.
- `fc.pre` — discard invalid draws inside an arbitrary's mapping when needed (rare).
- `fc.Arbitrary<T>` type — for typed builders.

NOT used (banned from this module): `fc.assert`, `fc.property`, `fc.statefulCommands`, `fc.scheduler`. We are minting test cases, not running properties.

### 4.3 Determinism contract

Every `fc.sample` call in `fuzz.ts` MUST pass `{ seed: <number>, numRuns: <number> }`. No call may rely on Math.random/process.hrtime. Lint rule: a CI grep gate that fails the build if `fc.sample(` appears without a `seed:` literal in the same call expression.

### 4.4 `TestCase.fuzzMeta`

Add to `TestCase` (in `types.ts`):
```ts
fuzzMeta?: {
  strategy: 'unicode' | 'shape' | 'boundary';
  subSeed: number;        // the deriveSubSeed-produced numeric seed
  drawIndex: number;      // 0..numRuns-1 — index inside the sample array
  shrunkValue?: unknown;  // populated post-execution if fast-check shrinks a failing case
};
```
Optional. Absent on fixed-palette cases. Present on every fuzz-minted case.

---

## 5. Failure-shrinking

When a fuzz `TestCase` triggers a `BugDetection`, the executor (NOT the planner) re-invokes fast-check in shrinking mode to find a minimal reproduction.

### 5.1 Where shrinking runs

`packages/cli/src/phases/execute.ts` (or its successor for the test-execution phase) detects when a failing `TestCase.fuzzMeta` is set. After the bug is recorded but BEFORE retest, it calls `fuzz.shrink(testCase, replayFn)`:
- `replayFn(value: unknown) → Promise<boolean>` returns true when the bug repros.
- `fuzz.shrink` rebuilds the same arbitrary using `testCase.fuzzMeta.subSeed`, then runs fast-check's `Arbitrary.shrink` iteratively (bounded to 50 steps and a 30-second wall-clock budget) until no smaller value reproduces.
- Result: `shrunkValue` is recorded on `TestCase.fuzzMeta` and surfaces in the bug occurrence.

### 5.2 Bounded budget

Shrinking has hard caps (`shrinkMaxSteps: 50`, `shrinkBudgetMs: 30_000`) to prevent runaway. Default off when `--fuzz-runs > 64` to avoid pathological cases (caps total shrink wall-time at 30s × number-of-failing-fuzz-cases). Explicit `--fuzz-shrink=on|off` overrides.

### 5.3 What shrinking is NOT

- Not a coverage signal — fast-check's shrinker is structural (bisect-style on the arbitrary's tree).
- Not a generator of new bugs — it only minimizes already-failing inputs.
- Not retried if it fails to find a smaller reproduction — original draw is kept.

---

## 6. Determinism (seed propagation)

This section is the V32 contract from this spec's perspective. V32 owns `runSeed` materialization; V39 consumes it.

### 6.1 Seed flow

```
CLI: --seed 7777
  └─→ runConfig.seed: 7777                                  (V32)
        └─→ runState.runSeed                                 (V32)
              └─→ planner.planRunForRole(role, runSeed, …)   (V32 wires)
                    ├─→ deriveSubSeed(runSeed, 'fuzz-unicode', formSig | toolId, fieldName)
                    ├─→ deriveSubSeed(runSeed, 'fuzz-shape',   toolId)
                    └─→ deriveSubSeed(runSeed, 'fuzz-boundary', toolId | formSig, fieldName)
```

`deriveSubSeed` is a pure FNV-1a or xxhash32 hash mix — V32 picks the algorithm; V39 just uses it. Output is a 32-bit unsigned int suitable for fast-check's `seed` parameter.

### 6.2 No global RNG

`mutation/fuzz.ts` MUST NOT use `Math.random`, `crypto.randomBytes`, `Date.now()`, or any process-time-derived value. The only entropy source is `subSeed`. Lint guard: a vitest unit test imports `fuzz.ts`, runs each strategy twice with identical inputs, and asserts byte-identical output (including key ordering of object draws — use `JSON.stringify` with sorted keys for the assertion).

### 6.3 Cluster-stability invariant

Stochastic discoveries MUST cluster identically across runs. Concretely:
- `clusterSignature(detection)` for a network-5xx triggered by fuzz draw `'‮Admin'` MUST equal the signature for the same endpoint triggered by fuzz draw `'​​x'` if both produce the same response-body shape and status.
- Test gate: `signature.test.ts` adds a case that constructs two `BugDetection` records with different `triggeringAction.input` values but identical other fields, asserts equal `clusterSignature`.

This is achieved by NOT including `triggeringAction.input` (or its hash) in any cluster signature — current code already does this. The spec verifies the invariant rather than introducing it.

### 6.4 Re-run identity

V32 acceptance: `bughunter run --seed 7777 --fuzz all` twice produces byte-identical `bugs.jsonl`. V39 inherits this and adds: `summary.json.fuzz.draws` MUST be identical across re-runs (same seed → same number of draws).

---

## 7. Cost control

### 7.1 Default off

No fuzz runs without an explicit `--fuzz <strategy>` flag (or `runConfig.fuzz.enabled: true` in config). The pre-V39 cost model is preserved exactly when no flag is passed.

### 7.2 Per-input, not per-test

`--fuzz-runs N` is the count of fuzz draws PER FIELD PER SURFACE PER STRATEGY. NOT per test case (a test case has multiple fields). Document explicitly in `--help`.

Cost upper bound for `--fuzz all --fuzz-runs 16`:
```
draws_per_form = unicodeFields × 16 + (no shape/boundary on forms beyond enum/min/max ≈ 16)
draws_per_tool = stringFields × 16 (unicode) + 5 × 16 (shape) + constrainedFields × 16 (boundary)
```
For an Aspectv3-sized app (~20 forms × 4 fields, ~30 tools × 6 fields): ≈ 1280 form fuzz draws + ≈ 5760 tool fuzz draws ≈ 7000 extra TestCase rows. At ~200ms per case execution, this adds ~24 minutes of wall time. The user MUST opt in.

### 7.3 Hard caps

`--fuzz-runs` clamps to `[1, 256]`. Above 256 the diminishing-returns curve flattens (per fast-check's own benchmark guidance) and shrinker cost becomes a problem.

`runConfig.fuzz.maxTotalDrawsPerRun` (default `25_000`) is a global ceiling. When exceeded, planner truncates at the ceiling and emits a `summary.json.fuzz.truncated: true` flag with `truncatedAtSurface` so users can see where the cut happened. Truncation order: alphabetical by `(role, surface_id)` so re-runs truncate identically.

### 7.4 Time-budget interaction

The existing `--budget <ms>` wall-clock budget continues to apply. Fuzz cases are scheduled AFTER the fixed palette in `phases/execute.ts` so a tight budget keeps the fixed-palette guarantee and only drops fuzz cases. (This is a planner ordering concern documented here for Task 4.)

---

## 8. CLI

```
--fuzz <strategy>           One of: none (default), unicode, shape, boundary, all
--fuzz-strategies <list>    Comma-separated subset of unicode,shape,boundary; takes precedence over --fuzz
--fuzz-runs <N>             Draws per field per surface per strategy (default 16, range 1..256)
--fuzz-shrink on|off        Failure-shrinking (default on; auto-off when fuzz-runs > 64)
--no-fuzz                   Hard disable, overrides config.fuzz.enabled = true
```

`runConfig.fuzz` schema (in `config.ts`):
```ts
fuzz: z.object({
  enabled: z.boolean().optional(),
  strategy: z.enum(['none', 'unicode', 'shape', 'boundary', 'all']).optional(),
  strategies: z.array(z.enum(['unicode', 'shape', 'boundary'])).optional(),
  runs: z.number().int().min(1).max(256).optional(),
  shrink: z.boolean().optional(),
  maxTotalDrawsPerRun: z.number().int().positive().optional(),
}).optional()
```

CLI flag values override config values. `--no-fuzz` is the kill switch; it disables fuzz even when config has `enabled: true`. Mirror the `--race-conditions` / `--no-race-conditions` precedence rules already in `config.ts:813-846`.

---

## 9. Edge cases

### EC-1. fast-check `fc.sample` returns fewer than `numRuns` items
Happens when an arbitrary has too few inhabitants (small enums, etc.). Accept the smaller set silently; don't error.

### EC-2. A field has both `enum` and `minLength`
`boundary` strategy prefers `enum` (the stronger constraint). `minLength` is applied only to draws sourced from `unicode` or to non-enum fields.

### EC-3. JSON Schema `pattern` is a regex fast-check can't compile
Catch the throw inside the boundary strategy, fall back to curated near-miss values, log at debug. Do not surface as a bug.

### EC-4. `inputSchema` is empty (no properties)
`shape` and `boundary` skip the tool entirely. `unicode` skips because there are no string fields to fuzz.

### EC-5. `--fuzz unicode` on an API tool with no string fields
Skip that tool. No-op. Telemetry records `fuzz.skippedTools.<reason>: <count>`.

### EC-6. Seed is 0 or undefined
`0` is a legal seed for fast-check. `undefined` is rejected at config parse — V32 makes the seed mandatory when `--fuzz` is set. Error message: `--fuzz requires --seed (or runConfig.seed) for deterministic generation`.

### EC-7. Two strategies generate the same draw (`unicode` and `boundary` both pick `''`)
Acceptable — they execute as separate test cases with distinct `fuzzMeta.strategy`. Cluster signature collapses them post-detection if they hit the same root cause.

### EC-8. Shrunken counterexample diverges (the smaller value doesn't repro)
fast-check's shrinker handles this — only smaller values that repro are accepted. If shrinking finds nothing, `shrunkValue` is left unset.

### EC-9. fast-check throws during sample (memory pressure, etc.)
Catch in the strategy wrapper, log at warn, skip the failing draw, continue with the rest. A complete strategy failure is recorded in `summary.json.fuzz.errors[]` with `{ strategy, surface, message }`.

### EC-10. `--fuzz-strategies` with an unknown name
Hard error at CLI parse. Don't auto-correct typos. Mirror `--race-variants` behavior at `config.ts:839`.

### EC-11. Fuzz mints zero cases overall (no eligible surfaces)
Run completes normally; `summary.json.fuzz.draws: 0`, `summary.json.fuzz.skippedReason: 'no eligible surfaces'`. Not a failure.

### EC-12. `--fuzz` with V11 (discovery-execute DOM consistency) enabled
No interaction. Fuzz operates at the planner layer; V11 operates at execute. Both run.

### EC-13. SSRF / open-redirect targets in unicode draws
The `unicode` arbitrary may draw `'http://169.254.169.254/...'`-shaped strings by accident. That's fine — those go through the same execute pipeline and either produce a bug (good) or are rejected by the server (also good). We do NOT filter draws.

### EC-14. Fuzz value crashes the test harness (e.g. extremely long string serialized in URL)
`text` length is clamped by `field.maxLength ?? 1024` (§3.1). For unconstrained API string fields, we clamp to 4096 by default. Document in §3.1.

---

## 10. Acceptance criteria

| Criterion | Verifier |
|---|---|
| `--fuzz none` (or no flag) is byte-identical to pre-V39 behavior on a fixture run | diff `bugs.jsonl` between pre-merge main and post-merge with `--seed 1234` |
| `--fuzz all --seed 7777` twice produces byte-identical `bugs.jsonl` | diff after two consecutive runs |
| `summary.json.fuzz` is populated with `enabled`, `strategies`, `draws`, `truncated` | jq |
| Fuzz minted cases carry `fuzzMeta` with `strategy`, `subSeed`, `drawIndex` | jq into `bugs.jsonl` occurrence |
| Cluster signature ignores fuzz draw value (two different draws → same cluster when other fields match) | unit test in `signature.test.ts` |
| Failed fuzz cases produce a `shrunkValue` in `fuzzMeta` when shrinker finds one | execute.test.ts |
| `--fuzz` without `--seed` (and no config seed) errors at CLI parse | run.test.ts |
| `--fuzz-strategies bogus` errors at CLI parse | run.test.ts |
| `npx tsc --noEmit` clean | tsc |
| `npx eslint . --max-warnings 0` clean | eslint |
| `npx vitest run` clean | vitest |
| `npm run build` succeeds | tsc + esbuild |
| Aspectv3 smoke with `--fuzz all --fuzz-runs 16 --seed 7777` completes | manual smoke |

---

## 11. Negative requirements

- Do **not** make fuzz a default-on behavior.
- Do **not** import `fast-check` outside `packages/cli/src/mutation/fuzz.ts` and its co-located test.
- Do **not** include `fuzzMeta` in cluster signature derivation.
- Do **not** add a runtime dep beyond `fast-check@3.23.2`.
- Do **not** persist all fuzz draws to disk — only failing draws and their shrunk reproductions.
- Do **not** use `Math.random`, `Date.now`, or `process.hrtime` inside fuzz code paths.
- Do **not** call `fc.assert`, `fc.property`, `fc.statefulCommands`, or `fc.scheduler`.
- Do **not** modify the fixed palette generators in `palette.ts`.
- Do **not** silently swallow fast-check errors — record them in `summary.json.fuzz.errors[]`.
- Do **not** apply fuzz to GET/HEAD/OPTIONS API tools (no body to mutate; reuse `isSafeMethod`).

---

## 12. Files to modify / create

### Create

| File | Purpose |
|---|---|
| `packages/cli/src/mutation/fuzz.ts` | Strategy implementations + `fc.sample` orchestration + `shrink()` |
| `packages/cli/src/mutation/fuzz.test.ts` | Determinism, per-strategy correctness, cluster-stability invariant |

### Modify

| File | Change |
|---|---|
| `packages/cli/src/types.ts` | Add `'fuzz'` to `PaletteVariant`; add optional `fuzzMeta` to `TestCase` |
| `packages/cli/src/mutation/apply.ts` | Thread `FuzzOptions` into `formTestCases` / `apiTestCases`; append fuzz cases when enabled |
| `packages/cli/src/mutation/apply.test.ts` | Add tests for the `FuzzOptions` thread-through and append-don't-replace invariant |
| `packages/cli/src/cluster/signature.ts` | Verify (and assert via test) the fuzz-stability invariant — no code change expected, only confirm; add a comment block documenting it |
| `packages/cli/src/cluster/signature.test.ts` | Add cases proving two fuzz draws with different inputs cluster identically |
| `packages/cli/src/config.ts` | Add `fuzz` block to `RunConfigSchema` + resolver/precedence (mirror race-conditions precedence) |
| `packages/cli/src/cli/run.ts` | Parse `--fuzz`, `--fuzz-strategies`, `--fuzz-runs`, `--fuzz-shrink`, `--no-fuzz`; pass into planner |
| `packages/cli/src/phases/plan.ts` | Wire `FuzzOptions` from config into `formTestCases` / `apiTestCases` calls |
| `packages/cli/src/phases/execute.ts` | Hook shrink invocation when a fuzz case fails (bounded budget) |
| `packages/cli/package.json` | Add `fast-check@3.23.2` to `dependencies` |

No new top-level files. No new directories.

---

## 13. Task breakdown

| # | Task | Assignee | Files | Test command | Done when | DO NOT |
|---|---|---|---|---|---|---|
| 1 | Add `'fuzz'` PaletteVariant + `fuzzMeta` shape to `types.ts` | @coder | `packages/cli/src/types.ts` | `npx tsc --noEmit` | TS compiles cluster-wide | Forking PaletteVariant into a sibling type |
| 2 | Add `runConfig.fuzz` Zod schema + resolver | @coder | `packages/cli/src/config.ts`, `packages/cli/src/config.test.ts` | `npx vitest run config` | Schema parses; precedence (`--no-fuzz` > `--fuzz` > config) is unit-tested | Adding new top-level config keys |
| 3 | `fast-check` dep + lockfile update | @coder | `packages/cli/package.json`, root lockfile | `npm install` | `import fc from 'fast-check'` resolves | Installing a different fuzz library |
| 4 | Implement `mutation/fuzz.ts` (the four strategies + shrink) | @coder | `packages/cli/src/mutation/fuzz.ts` | `npx vitest run fuzz` | All four strategies emit byte-identical draws across two invocations with same seed | Importing fast-check anywhere else |
| 5 | Determinism unit tests | @coder | `packages/cli/src/mutation/fuzz.test.ts` | `npx vitest run fuzz` | Run-twice-same-seed test asserts identical output | Testing only happy paths |
| 6 | Wire fuzz into `apply.ts` (append behavior) | @coder | `packages/cli/src/mutation/apply.ts`, `apply.test.ts` | `npx vitest run apply` | Fuzz cases appended; fixed palette unchanged when fuzz disabled | Modifying fixed-palette generators |
| 7 | Wire CLI flags + planner threading | @coder | `packages/cli/src/cli/run.ts`, `packages/cli/src/phases/plan.ts` | `npx vitest run run plan` | Flags parse; planner passes fuzz options through | Adding fuzz logic to plan.ts itself |
| 8 | Cluster-stability invariant test | @coder | `packages/cli/src/cluster/signature.test.ts` | `npx vitest run signature` | Two distinct fuzz draws with same downstream effect cluster identically | Modifying signature derivation |
| 9 | Shrink hook in execute.ts (bounded) | @coder | `packages/cli/src/phases/execute.ts`, execute.test.ts | `npx vitest run execute` | Failing fuzz cases get `shrunkValue` populated when shrinker finds one | Running shrinker un-bounded |
| 10 | `summary.json.fuzz` telemetry | @coder | wherever summary is written (`packages/cli/src/cli/run.ts` end-of-run write) | `npx vitest run run` | Telemetry block present with all required keys | Adding a separate fuzz-log file |
| 11 | Manual Aspectv3 smoke + acceptance verification | @qa | (manual) | (see §14) | All §10 acceptance gates pass | Filling fuzz on every smoke run by default |

Each task: ≤ 3 files modified, single responsibility, independently testable.

---

## 14. Killer-demo runbook (Aspectv3)

```bash
# Pre: assume V32 deterministic mode is merged and runSeed wiring exists.
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --max-bugs 200 --budget 2400000 \
    --seed 7777 \
    --fuzz all --fuzz-runs 16

# Confirm telemetry
RUN1=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.fuzz' /root/Aspectv3/.bughunter/runs/$RUN1/summary.json
# Expect:
# {
#   "enabled": true,
#   "strategy": "all",
#   "strategies": ["unicode","shape","boundary"],
#   "runs": 16,
#   "draws": <int>,
#   "truncated": false,
#   "shrunkCount": <int>,
#   "errors": []
# }

# Re-run with same seed, diff bugs.jsonl — must be byte-identical
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --max-bugs 200 --budget 2400000 \
  --seed 7777 \
  --fuzz all --fuzz-runs 16
RUN2=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
diff /root/Aspectv3/.bughunter/runs/$RUN1/bugs.jsonl /root/Aspectv3/.bughunter/runs/$RUN2/bugs.jsonl
# Expect: no output (byte-identical)
```

---

## 15. Risks + escape hatches

- **Risk: fast-check 3.x bumps a major between spec-write and implementation.** Mitigation: pin exact version. Pinning + lockfile prevents drift.
- **Risk: deterministic re-run breaks because some downstream phase introduces nondeterminism.** Mitigation: V32 owns this gate; V39 inherits it. If V32's determinism gate fails on `--fuzz all`, file a V32 follow-up rather than papering over it in V39.
- **Risk: fuzz cases swamp `--max-bugs 200` cap, masking fixed-palette bugs.** Mitigation: planner orders fixed palette before fuzz (§7.4). `--max-bugs` is a deduplicated-cluster cap, not a TestCase cap, so this is mostly cosmetic — but document in fuzz `--help`.
- **Risk: shrinker hangs on a pathological reproducer.** Mitigation: hard 30-second wall-clock budget per shrink (§5.2).
- **Risk: fast-check imports something incompatible with our ESM-only runtime.** Mitigation: 3.x is dual-published (CJS + ESM). Verify in Task 3 that `import fc from 'fast-check'` resolves under our existing `"type": "module"` and `tsconfig.json` settings before continuing.
- **Escape hatch:** `--no-fuzz` forces disable. `runConfig.fuzz.enabled: false` forces disable. Default is disabled. Removing this entire feature requires only removing one config block — no cross-cutting cleanup.

---

## 16. Open questions

1. **Should `unicode` strategy fuzz emails' domain part too, or only local-part?** Spec says local-part only (we want valid-shape emails). Domain fuzz might catch RFC 5321 edge cases (Punycode, internationalized TLDs) but adds noise. Defer to V40 if a target needs it.
2. **Should `boundary` strategy run on tools without an `inputSchema` by inferring from `samples[0]`?** Spec says no — too speculative; users with unknown-confidence tools already get one happy-path call. Inferring would require schema-induction logic that belongs in a separate spec.
3. **Should we expose a `--fuzz-curated-only` mode that uses ONLY the curated naughty-string list (no fast-check generation)?** Smaller, faster, more reproducible — but loses property-based coverage. Out of scope for V39; revisit if curated mode is requested.
4. **Should `summary.json.fuzz.draws` break down per-strategy / per-surface, or just the total?** Spec lands on total for now; users wanting detail can re-derive from `bugs.jsonl` `fuzzMeta`. Adding the breakdown adds 4 lines and is forward-compatible — open question whether to land it now.
5. **Should fast-check's `verbose: true` mode (which records every shrink step) be exposed via `--fuzz-shrink-trace`?** Useful for debugging shrinker failures; noisy otherwise. Not in V39 scope; if shrinking proves unreliable in production, file as V41.
6. **What's the right interaction between `--fuzz` and `--retest`?** A re-tested fuzz cluster should re-mint with the original `subSeed` and `drawIndex` (deterministic replay), not draw fresh. V32 + the existing retest dispatch should make this free, but verify in Task 11.

---

## 17. Definition of done

- All §10 acceptance criteria pass.
- All §13 tasks complete.
- `npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && npm run build` clean.
- Aspectv3 smoke runbook (§14) executed; output recorded.
- `bugs.jsonl` byte-identical between two `--seed 7777 --fuzz all` runs.
- `fast-check` is the ONLY new dependency added; no transitive bloat (verify with `npm ls fast-check` and a bundle-size check).
- No regression in pre-V39 default behavior (no `--fuzz` flag → identical output to pre-merge `main`).
- Spec linked from `SPEC_PATH_TO_EXHAUSTIVE.md` §3.4 (the existing reference paragraph) and Phase E (§9 of that spec).
