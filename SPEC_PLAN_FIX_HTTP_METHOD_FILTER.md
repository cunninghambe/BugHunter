# SPEC — planner respects HTTP method when minting test cases

**Status:** Draft 1 — ready for `@coder` · **Author:** `@architect` (Opus) · **Date:** 2026-04-30 · **Sibling specs:** `SPEC_RETEST_FIX_RELATIVE_URL.md`, `SPEC_RETEST_FIX_STATIC_RERUN.md`

The planner currently mints mutating-palette test cases (POST/PUT/PATCH/DELETE-shaped) against tools whose SurfaceMCP-registered HTTP method is GET. The result is a `network_5xx` cluster filed against a route that, in reality, returns 405 Method Not Allowed (a perfectly correct response from Next.js's App Router for an unsupported method). These are false positives that waste architect-refusal cycles.

Surfaced during OpeningBell autofix: cluster `szmxric2egok2rva4j73dgmg` filed `HTTP 500 from POST 98815bd5ee00` for `/api/import/history`, but:
- The route only exports a GET handler.
- BugHunter's own surface-map in `state.json:1996–2008` registers tool `98815bd5ee00` with `method: "GET"`.
- `network/` directory contains zero matching `.har` files for that route.
- Real Next.js would return 405, not 500.

The cluster was synthetic — no actual HTTP request was made. The planner generated the test, the executor "ran" it (probably hit a code path that bailed early), and a 500 was inferred from the absence of evidence.

---

## 1. Objective

Add a method-aware filter at plan time:

> For each tool from SurfaceMCP, if `tool.method === 'GET'` (or any safe method per RFC 9110: `GET | HEAD | OPTIONS`), do not mint test cases that imply mutating bodies (`xss_inject`, `null` body, `out_of_bounds` numeric overflow, etc.). Only mint `happy` and `edge` palette variants for safe methods.

This is one filter at a small set of call sites in `phases/plan.ts` / `mutation/apply.ts`. Probably ≤30 lines of net change.

**In scope:**
- New helper `isSafeMethod(method: string): boolean` returning true for `GET | HEAD | OPTIONS`.
- Filter in plan/mutation: `palette: 'xss_inject' | 'null' | 'out_of_bounds'` only mints for non-safe methods.
- Filter applied to API tools (`action.via === 'api'`) — UI form submissions are not affected (they always go through their form's HTTP verb anyway).
- Unit test at `phases/plan.test.ts` asserting GET tools get `happy + edge` palette only.

**Out of scope:**
- Inferring method from route file path (we trust SurfaceMCP's tool metadata).
- Filtering UI palette variants — they ride form `<method>` attribute, which the planner doesn't synthesize.
- Bug 1 (replay relative URL) — separate spec.
- Bug 2 (static-rerun retest) — separate spec.

---

## 2. Existing code map

### 2.1 Files to read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/phases/plan.ts` | Where API test cases are minted from `ToolMeta`. Find the loop that iterates `enrichedTools` and produces `apiTestCases` for each palette variant. |
| `packages/cli/src/mutation/apply.ts` | The palette factories: `nullTestCase`, `xssCanaryTestCase`, `outOfBoundsTestCase`, etc. Some of these may be where the filter belongs. |
| `packages/cli/src/types.ts` | `ToolMeta.method` is already typed as `string`. No schema change. `Action.kind` includes `api_call`. |
| `packages/cli/src/phases/plan.test.ts` | Existing plan tests. Add new test cases for the method filter. |

### 2.2 Patterns to follow

- **Pure helper:** `isSafeMethod` is a single-line function. Put it in `mutation/apply.ts` near the palette factories, or in a tiny `phases/plan-helpers.ts` if cleaner.
- **Filter at the source.** Don't generate then filter — gate the test-case-minting decision so we never create the doomed test in the first place.
- **No new external types.** RFC 9110 list is small and stable.

### 2.3 DO NOT

- Do NOT add a global "skip this tool" flag — only filter the specific palette variants that imply mutation.
- Do NOT change `ToolMeta` — we read `method` as-is.
- Do NOT change SurfaceMCP — its method registration is already correct.
- Do NOT filter `kind: 'click'` UI test cases for safe-method routes; the click is on a UI element, not the API directly.

---

## 3. Implementation

### 3.1 Helper

```ts
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string | undefined): boolean {
  return method !== undefined && SAFE_METHODS.has(method.toUpperCase());
}
```

### 3.2 Filter in `phases/plan.ts` (or wherever API palette variants are generated)

Trace the API test-case minting loop. Pseudocode:

```ts
for (const tool of enrichedTools) {
  for (const palette of palettes) {
    if (palette === 'xss_inject' || palette === 'null' || palette === 'out_of_bounds') {
      if (isSafeMethod(tool.method)) {
        // skip — safe-method tools shouldn't get mutating-input tests
        continue;
      }
    }
    // mint test case
  }
}
```

Actual loop structure may be flatter (per-palette factory call). Adapt accordingly. The decision should be made BEFORE the test case is constructed.

### 3.3 Tests

`phases/plan.test.ts`:
- Tool with `method: 'GET'` → resulting test cases have palettes only from `{happy, edge}` (no `xss_inject`/`null`/`out_of_bounds`).
- Tool with `method: 'POST'` → all palette variants present, including mutating ones.
- Tool with `method: 'HEAD'` and `method: 'OPTIONS'` → same as GET (safe).
- Tool with `method: 'PUT'` / `'PATCH'` / `'DELETE'` → mutating palettes generated (those are mutation-intent verbs).
- Tool with `method: undefined` → fallback: assume mutation-allowed (preserves current behavior for tools without method metadata).

---

## 4. Edge cases

### EC-1. SurfaceMCP returns `method: ''` (empty string)
`isSafeMethod('')` → false → mutating palettes generated. Document: empty-method should never happen in practice (SurfaceMCP requires method); if it does, we err on the side of running the test.

### EC-2. Method is mixed-case, e.g. `'Get'`
`toUpperCase()` normalizes. Set membership is case-canonical.

### EC-3. Custom HTTP method (e.g. `'PURGE'`)
Not in safe set → mutating palettes generated. Conservative.

### EC-4. Tool's `method` is `'GET'` but the implementation accepts a body (some routes ignore method)
Out of scope. We trust the registered method.

---

## 5. Acceptance

| Criterion | Verifier |
|---|---|
| New unit tests pass | `npm test -- plan.test` |
| Existing tests pass | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Re-run BugHunter against OpeningBell: cluster `szmxric` (and similar GET-only-with-mutating-test false positives) does NOT recur | manual smoke |

---

## 6. Files to touch

- `packages/cli/src/mutation/apply.ts` (add `isSafeMethod` helper + use it)
- `packages/cli/src/phases/plan.ts` (call the filter)
- `packages/cli/src/phases/plan.test.ts` (new tests)

3 files, ≤30 lines of net change.

---

## 7. Negative requirements

- Do not change `ToolMeta` schema.
- Do not change SurfaceMCP.
- Do not filter UI test cases.
- Do not add per-tool overrides — the method itself is the signal.

---

## 8. Risks

- **Risk: real bugs in GET handlers that mishandle malformed query params get missed.** Mitigated: GET tools still get `happy` + `edge` palette which can include malformed query strings. We only suppress *body-shaped* mutating inputs against bodyless verbs.
