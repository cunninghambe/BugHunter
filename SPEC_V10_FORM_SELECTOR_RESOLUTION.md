# BugHunter v0.10 — Form Selector Resolution

## §1 Objective + Boundaries

### Objective
Eliminate the dominant remaining infra-failure class on TraiderJo (41/41 of `browser_element_not_found` clustered as `No matching ref in snapshot or DOM` against `form:nth-of-type(1)`-style selectors) by changing **how form fields are filled and submitted** so that the camofox accessibility-tree snapshot is never asked to resolve a compound CSS descendant selector against an unnamed `<input>`.

### Boundaries
- **In scope:** `packages/cli/src/phases/form-submit-runner.ts` and its tests; `packages/cli/src/phases/execute-form-submit.test.ts`; one new unit-test file for the new evaluate-based fill path; one smoke acceptance gate.
- **Out of scope:** changes to camofox-mcp (`/root/camofox-mcp`); changes to `dom-walker.ts` (the `formSelector` string it emits stays exactly as-is); changes to `browser-mcp.ts` (the `scope.type`/`scope.click` selector pipeline stays untouched for non-form callers); changes to `replay.ts` semantics (it still calls `runFormSubmit` with the same args); the planner / `mutation/apply.ts` / discovery types.
- **External dependencies:** none added. The fix uses only `scope.evaluate`, which already exists and is already a privileged unsandboxed channel directly to the Playwright page in camofox-mcp (`evaluate` tool registers a raw `expression` on the tab — see `/root/camofox-mcp/src/core/tools.ts:127`).

### Why this is the right next fix
v0.9 (PR #29) closed `state-page trigger re-establishment` and `form-submit missing selector`. Smoke run `w07xdntnuvb08pd3my7dg9v3` against TraiderJo: 10 clusters / 41 infra failures, every one of the form

```
{"kind":"browser_element_not_found",
 "detail":"No matching ref in snapshot or DOM",
 "page":"/?setTab=profile",
 "action":{"kind":"submit","selector":"form:nth-of-type(1)", ...}}
```

The selector is the form. The actual failure happens earlier: `runFormSubmit` calls `scope.type("form:nth-of-type(1) [name=<field>]", value)` per field, and that compound selector goes through `browser-mcp.ts → resolveRef → resolveSelectorInSnapshot → evaluate fallback → resolveByHtml`, which only resolves an element if the underlying snapshot node has an accessible name (aria-label / placeholder / title / alt / textContent). TraiderJo's profile-form `<input>`s have none. The fallback returns null and we report the error against the *form* selector (because that's what's in `tc.action.selector`), masking the real failure point.

Closing this single class is sufficient to take TraiderJo's infra failure count from 41 to <5 (acceptance criterion §9).

---

## §2 Existing Code Map

### Files agents MUST read before writing any code
- `/root/BugHunter/packages/cli/src/phases/form-submit-runner.ts` — **EDIT THIS FILE.** This is where the fix lands. Currently 65 lines; the new version stays under 100.
- `/root/BugHunter/packages/cli/src/phases/execute-form-submit.test.ts` — **EDIT THIS FILE.** Existing tests assert `scope.type` is called per field; those assertions change. Replace, do not delete.
- `/root/BugHunter/packages/cli/src/phases/execute.ts` (lines 463–469) — **DO NOT EDIT.** Read only, to confirm the call site signature is preserved.
- `/root/BugHunter/packages/cli/src/repro/replay.ts` (line 95) — **DO NOT EDIT.** Read only, to confirm `runFormSubmit(browser, entry.selector, input)` still works.
- `/root/BugHunter/packages/cli/src/discovery/dom-walker.ts` (lines 53–73) — **DO NOT EDIT.** Read only, to confirm `formSelector` continues to be either `#<id>` or `form:nth-of-type(N)`. The fix must work for both.
- `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` (lines 363–367 — `evaluate`) — **DO NOT EDIT.** Read only, to confirm `scope.evaluate(expr)` returns `{ value: unknown }` where `value` is whatever the expression evaluates to.
- `/root/BugHunter/packages/cli/src/adapters/browser-mcp-snapshot.ts` (lines 126–159 — `resolveStringSelector`) — **DO NOT EDIT.** Read only, to understand why `form:nth-of-type(1) [name="x"]` cannot be resolved by the current pipeline.
- `/root/camofox-mcp/src/core/tools.ts` (lines 127–142 — `evaluate` tool) — **DO NOT EDIT** (not in this repo). Read only, to confirm camofox-mcp's `evaluate` accepts an arbitrary `expression: string` and returns its value verbatim through the Playwright page.

### Patterns to follow
- **Build a JS expression with `JSON.stringify` for every interpolated string.** This is the existing pattern in `buildSubmitScript` (`form-submit-runner.ts:40`) and `evaluateClickByCss` / `evaluateClickByText` (`browser-mcp.ts:248-265`). Never concatenate raw user-controlled strings into JS — always `JSON.stringify`.
- **Discriminated-union return shape from page-side scripts.** Existing convention: `{ ok: true, via: '<channel>' }` or `{ ok: false, reason: '<slug>' }`. Reuse the slugs already in `buildSubmitScript`: `form_not_found`. Add new slugs only as listed below.
- **Throw a single `Error` with `submit: <reason> (formSelector=<sel>)`** on non-`ok` results. The current shape (`form-submit-runner.ts:35`) is matched verbatim by tests downstream; do not change the prefix.
- **Coerce values via `String(value)`** before inserting into the page (`form-submit-runner.ts:29`). Continue this; it's how the planner's odd shapes (numbers, arrays-as-strings) reach the page today.
- **Field-name CSS escaping uses `cssEscape` (only `\\` and `"`).** Keep this helper. Move it into the new evaluate script's input map keys via `JSON.stringify`-style escaping (the keys are object literals, so JSON-stringify handles all escaping for free).

### DO NOT
- DO NOT add a new module in `packages/cli/src/`. The fix lives in `form-submit-runner.ts`. No new files.
- DO NOT modify `browser-mcp.ts`, `browser-mcp-snapshot.ts`, `dom-walker.ts`, `execute.ts`, `replay.ts`, `phases/plan.ts`, `mutation/apply.ts`, or any types in `types.ts`.
- DO NOT touch `/root/camofox-mcp` — it's a separate repo and a separate worktree. Changes to camofox-mcp would be a v1.0+ direction (Design E, rejected — see §4).
- DO NOT introduce a new selector schema (`fields[i].selector`, `formSelector[]`, etc.) — the discovery output stays exactly as it is today.
- DO NOT use `as any` to silence types. Use `as { ok?: boolean; ... } | undefined` like the current code does.
- DO NOT mutate the page under test with `data-bughunter-id` or any attribute injection. The site under test must be observed, not modified.

---

## §3 Investigation Findings (verified, not guessed)

### What camofox-mcp actually accepts
Verified by reading `/root/camofox-mcp/src/core/tools.ts`:

| Tool | Argument | Server interpretation |
| ---- | -------- | --------------------- |
| `click` | `{ tabId, ref }` | `ref` is required and must be a snapshot ref like `e3`. **No CSS support.** No `selector` argument. |
| `type` | `{ tabId, ref, text, submit? }` | Same — `ref` only. **No CSS support.** No `selector` argument. |
| `evaluate` | `{ tabId, expression }` | Raw JS string evaluated in page context via Playwright. Returns `{ result }` (or `value`) verbatim. **This is the escape hatch.** |
| `snapshot` | `{ tabId, offset? }` | Returns the a11y tree text. Refs (`e1`, `e2`, …) are stable per snapshot. |

There is no support in camofox-mcp for raw CSS selectors, `:has-text()`, `aria-label=...` shorthand, role-based shorthand, or any selector form other than a snapshot-bound `ref`.

All client-side (`browser-mcp.ts`) translation from selector → ref happens in `resolveSelectorInSnapshot` (snapshot walk) and `resolveViaEvaluate` (querySelector → re-snapshot → resolveByHtml). Both paths require the element to have an accessible name reflected in the snapshot to round-trip back to a ref.

### Why the current evaluate fallback fails on `form:nth-of-type(1) [name="bio"]`
1. `resolveStringSelector` sees `:nth-of-type(` in the string and returns `null` (line 127–129).
2. `resolveViaEvaluate` runs `document.querySelector('form:nth-of-type(1) [name="bio"]')?.outerHTML?.slice(0, 200) ?? null`. This succeeds and returns e.g. `<input name="bio" />`.
3. `resolveByHtml` extracts candidate accessible-name strings from the HTML: aria-label, placeholder, title, alt, textContent. For an `<input name="bio" />` with no aria-label and no placeholder, **all candidates are empty.**
4. The for-loop over candidates never finds a match → `resolveByHtml` returns `null`.
5. `resolveViaEvaluate` throws `BrowserMcpError('element_not_found', 'Element exists in DOM but has no accessible name in snapshot')` — but the user-reported detail is `"No matching ref in snapshot or DOM"`, which is the OTHER null branch (querySelector returned null).

The detail string is truthful: on `?setTab=profile`, the form is rendered but bare. Even if `querySelector` finds the input, the snapshot does not record an accessible name for it, so the round-trip can't complete.

### The escape hatch exists, and it's already used elsewhere
`scope.evaluate(expr)` is a thin proxy to camofox-mcp's `evaluate` tool, which is a thin proxy to Playwright's `page.evaluate`. There is no a11y-tree intermediation. The existing `buildSubmitScript` already uses this channel to `document.querySelector(formSelector)` and dispatch a `click()`/`requestSubmit()`/`submit()` — and that part works fine. The only piece still going through the snapshot pipeline is the per-field `scope.type` call.

**Conclusion:** the cheapest fix is to move the per-field fill into the same evaluate script that already does the submit. The snapshot pipeline never gets the chance to fail.

---

## §4 Design Choice

### Chosen: **Design B (sharpened) — single-evaluate fill+submit in `runFormSubmit`**

Rationale (one paragraph): Design B is the only candidate that (a) requires zero changes to camofox-mcp, (b) requires zero changes to `dom-walker.ts` or the discovery schema, (c) does not mutate the page under test, and (d) closes the entire failure class — not just `:nth-of-type` but ANY compound CSS selector that contains an a11y-invisible descendant. The original framing of Design B in the prompt ("retry via `scope.evaluate` when the snapshot lookup fails") creates a split code path with two sources of truth; the sharpened form replaces the split with a single evaluate that does fill+submit atomically. The form-submit pathway is already privileged (it has `scope.evaluate` and uses it for submit) — extending it to also do the field fills is a 30-line change, fully unit-testable without a browser, and leaves all other selector flows (`scope.click` from the planner, `scope.type` in non-form contexts, `replay.ts`'s click steps) untouched.

### Why the others were rejected
- **Design A — emit ARIA-friendly selectors from `dom-walker.ts`.** TraiderJo's profile form has no `aria-label` on the form and no `aria-label`/`placeholder` on the inputs — there is no ARIA-friendly selector to emit. Design A doesn't fix the failure. (And synthesising one would be the discovery telling itself a fiction.)
- **Design C — capture multiple selector forms and try them in priority order.** Schema growth across `DiscoveredForm`, the planner, mutation/apply.ts, and downstream consumers. Higher blast radius for a problem solved without a schema change.
- **Design D — inject `data-bughunter-id` attributes.** Mutates the page under test. Anti-pattern. Breaks XSS reflection probes (the very palette this product runs) because the planted attributes change the DOM the security probes reason about. Hard veto.
- **Design E — change camofox-mcp to accept raw CSS Locators.** Cross-repo change. The right long-term direction (we should eventually let camofox-mcp accept selectors when the app is happy to use Playwright Locators) but it's a v1.x architectural shift, not a stop-the-bleed v0.10 fix. Defer.

### What Design B (sharpened) does, in one sentence
Replace `runFormSubmit`'s per-field `scope.type` calls with one `scope.evaluate` that resolves the form, sets each `<input>`/`<textarea>`/`<select>`'s value, fires React-friendly synthetic events, and then runs the existing submit logic — all in a single round-trip.

### What it does NOT do
- It does not change `Action.selector` semantics. The action's `selector` is still the `formSelector` and is passed through unchanged.
- It does not change `scope.type`'s behaviour for non-form callers — the planner's `kind: 'fill'` action path (`execute.ts:470-474`) still uses `scope.type` and continues to work for elements that DO have accessible names (the common case).
- It does not change replay's call shape — `runFormSubmit(browser, entry.selector, input)` keeps the same signature.

---

## §5 Edge Cases

Each must be enumerated in tests (§6).

1. **Form not found** — `document.querySelector(formSelector)` returns `null`. Page-side returns `{ ok: false, reason: 'form_not_found' }`. Existing behaviour, preserved.
2. **Field present in input but absent in DOM.** `form.querySelector('[name="x"]')` returns `null`. **New behaviour: skip the field, continue with remaining fields, record the missing field name in the result.** Reason slug: none thrown; return `{ ok: true, ..., missingFields: ['x'] }`. Don't fail the action — the field set was discovered, but the form may have been re-rendered.
3. **Field is a `<select>`.** Setter must dispatch a `change` event (React/controlled-component pattern). Use the native value setter (see implementation note in §8 Task 2) so React picks up the change.
4. **Field is a `<input type="checkbox">` or `<input type="radio">`.** Set `.checked = Boolean(value)` (truthy → checked) and dispatch `change`. Out-of-scope inputs that the planner never reaches today but cheap to handle.
5. **Field is a `<input type="file">`.** Cannot be set via `.value =` for security reasons. **New slug: `file_field_unsettable`.** Return `{ ok: false, reason: 'file_field_unsettable', field: '<name>' }` so the failure has a clear diagnostic rather than masquerading as a submit error.
6. **Field name contains `"`, `\`, `'`, or unicode.** Use `JSON.stringify` for the entire input map; the field-name escaping is handled by JSON. The page-side reads the map by exact-match key lookup (`input[name]`), no string concatenation into a selector. (This is strictly safer than the current `cssEscape` because it removes the selector layer entirely.)
7. **Empty input map (`input = {}`).** Skip the fill loop; run submit only. Identical to current behaviour.
8. **Submit button missing AND `requestSubmit` unavailable AND native `submit` throws.** Page-side returns `{ ok: false, reason: 'submit_failed', via: 'submit_native' }`. Caller throws `Error('submit: submit_failed (formSelector=...)')`. Same shape as today.
9. **`formSelector` itself is a compound CSS selector with a descendant.** Today not produced by `dom-walker.ts` (it always emits `#<id>` or `form:nth-of-type(N)`), but the script must not assume otherwise. `document.querySelector(formSelector)` accepts any valid CSS, so this is automatically handled.
10. **Page-side script throws (e.g. CSP forbids inline `MouseEvent` constructor).** The evaluate call throws upstream; `runFormSubmit` re-throws as `Error('submit: page_eval_threw: <message>')`. Distinguishable from `ok: false` cases. Camofox v0.1 has no CSP issue today, but future-proofing.
11. **`scope.evaluate` itself returns `{ value: undefined }`** (transport oddity). Treat as `{ ok: false, reason: 'no_result' }` and throw `Error('submit: no_result (formSelector=...)')`.
12. **Concurrent forms on the page** (e.g. two `<form>` siblings, `formSelector === 'form:nth-of-type(2)'`). `document.querySelector(formSelector)` resolves correctly because `:nth-of-type` is a real CSS pseudo-class that browsers implement natively. Verified — this works today via the existing `buildSubmitScript` for the submit half. The fill half will work for the same reason.

---

## §6 Test Plan

### Unit tests (file: `packages/cli/src/phases/execute-form-submit.test.ts` — REPLACE existing tests)

Replace the existing `runFormSubmit` test suite. The contract changes in this PR.

```
runFormSubmit (v0.10 single-evaluate path)
  ✓ zero fields → calls scope.evaluate exactly once with a script that contains the formSelector, does NOT call scope.type
  ✓ N fields → still calls scope.evaluate exactly once (no per-field scope.type calls)
  ✓ never calls scope.type — scope.type is removed from the FormSubmitScope type, this is enforced by structural typing
  ✓ skips null and undefined values (they don't reach the page-side input map)
  ✓ coerces non-string values via String(): { count: 7 } → page receives { count: '7' }
  ✓ field name with double-quote / backslash / unicode is preserved verbatim through JSON.stringify (no shell of cssEscape)
  ✓ throws "submit: form_not_found (formSelector=#missing)" when evaluate returns { ok: false, reason: 'form_not_found' }
  ✓ throws "submit: file_field_unsettable (formSelector=#f)" when evaluate returns { ok: false, reason: 'file_field_unsettable', field: 'avatar' }
  ✓ throws "submit: submit_failed (formSelector=#f)" when evaluate returns { ok: false, reason: 'submit_failed' }
  ✓ throws "submit: no_result (formSelector=#f)" when evaluate returns { value: undefined }
  ✓ throws "submit: page_eval_threw: <msg>" when scope.evaluate rejects
  ✓ resolves silently when evaluate returns { ok: true, via: 'button', missingFields: [] }
  ✓ resolves (does NOT throw) when evaluate returns { ok: true, via: 'requestSubmit', missingFields: ['stale_field'] } — missing fields are warnings, not errors

buildFillSubmitScript (new, exported helper)
  ✓ JSON-stringifies the formSelector exactly once
  ✓ JSON-stringifies the input map exactly once
  ✓ output is a single self-invoking IIFE expression
  ✓ output references each of: querySelector(formSelector), iteration over input keys, native value setter, dispatchEvent('input'/'change'), submit-button resolution, requestSubmit fallback
  ✓ formSelector with embedded double-quote: 'form[data-id="x"]' → contains JSON-encoded "form[data-id=\"x\"]"
  ✓ input map with field name containing double-quote: { 'a"b': 'v' } → contains JSON-encoded {"a\"b":"v"}
  ✓ output length is bounded — fails the test if the script exceeds 4 KiB (sanity guard against runaway concatenation)

isStringKeyedRecord
  (existing tests retained, no change)
```

### Replay smoke (manual — runbook only, no automated assertion)
Pick one infra failure from `w07xdntnuvb08pd3my7dg9v3` and replay it through `replay.ts` post-fix. Expect: action runs, no `browser_element_not_found` infra failure on the form-submit step. (Documented in §11.)

### Smoke acceptance (the gate)
Run a full smoke scan against TraiderJo on the new branch. Pass when **`No matching ref in snapshot or DOM` infra failures < 5** across all clusters (down from 41). See §9 for the exact command and counting method.

### Lint, types, build, existing tests
```
cd /root/BugHunter && pnpm -C packages/cli typecheck   # zero errors
cd /root/BugHunter && pnpm -C packages/cli lint --max-warnings 0
cd /root/BugHunter && pnpm -C packages/cli test         # all green, including existing form-submit tests as updated
cd /root/BugHunter && pnpm -C packages/cli build
```

---

## §7 Negative Requirements

- No new files outside this spec's "Files to Create" list (which is **none**).
- No `as any` anywhere. Use `unknown` and narrow.
- No `try { ... } catch { /* swallow */ }` patterns. Every catch logs or rethrows with context.
- No changes to `browser-mcp.ts`, `browser-mcp-snapshot.ts`, `dom-walker.ts`, `execute.ts`, `replay.ts`, `types.ts`, `mutation/apply.ts`, `phases/plan.ts`, `phases/discover.ts`, or any test other than `execute-form-submit.test.ts`.
- No introducing a new dependency. The fix is a string template + page-side IIFE.
- No re-export of internal helpers from new public surfaces. `buildFillSubmitScript` is exported solely for unit testing — it is not consumed elsewhere.
- No copy-paste of `evaluateClickByCss` / `evaluateClickByText` — they live on `CamofoxBrowserMcpAdapter` for click hints, not for forms. Don't reach into them.
- No retry-on-failure logic added to `runFormSubmit`. One evaluate, one outcome. The existing single-retry in `scope.type` (which is no longer called from this path) is unrelated.
- No `:nth-of-type`-aware parsing in client TypeScript code. The browser implements `:nth-of-type` natively; we delegate to it via `document.querySelector`.
- No tests that boot a real browser. All tests stub `scope.evaluate` and assert on the script string and on the dispatched-result handling.
- Functions max 40 lines. The page-side IIFE in `buildFillSubmitScript` is a single template literal — count it as one expression for the line budget.
- No emoji in code, comments, or commit messages.

---

## §8 Task Breakdown

### Task 1 — Update `FormSubmitScope` type and contract (5 min)
**Assignee:** @coder
**Depends on:** none
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts`
**Files to create:** none
**Test:** `pnpm -C packages/cli typecheck` passes
**Done when:** `FormSubmitScope` no longer requires `type`. The new type is:
```ts
type FormSubmitScope = {
  evaluate(script: string): Promise<EvaluateResult>;
};
```
Existing callers (`execute.ts:467`, `replay.ts:95`) are structurally compatible because `BrowserMcpAdapter` and `TabScope` both have `evaluate`.
**DO NOT:** delete `cssEscape` yet — Task 2 may still want it as a fallback (it won't, but verify before deletion in Task 4).

### Task 2 — Implement `buildFillSubmitScript` (20 min)
**Assignee:** @coder
**Depends on:** Task 1
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts`
**Files to create:** none
**Test:** unit tests in Task 5 pass
**Done when:** new exported function exists with this contract:

```ts
export function buildFillSubmitScript(
  formSelector: string,
  input: Record<string, string>,  // already-coerced to strings
): string;
```

The returned string is an IIFE that:
1. `const f = document.querySelector(<formSelector>);` — if null → `{ ok: false, reason: 'form_not_found' }`.
2. `const missingFields = [];`
3. For each `[name, value]` in the JSON-encoded input map:
   - `const el = f.querySelector('[name="' + name + '"]');` (name is JSON-key lookup; the page-side `[name="..."]` uses the literal name verbatim — no cssEscape needed because we control the page-side string).
   - If `el === null` → push name into `missingFields`, continue.
   - If `el.type === 'file'` → return `{ ok: false, reason: 'file_field_unsettable', field: name }`.
   - If `el.type === 'checkbox'` or `el.type === 'radio'` → set `el.checked = Boolean(value) && value !== 'false' && value !== '0';` then `el.dispatchEvent(new Event('change', {bubbles:true}))`.
   - If `el.tagName === 'SELECT'` → set value via the **native value setter** pattern (`Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value)`), then `el.dispatchEvent(new Event('change', {bubbles:true}))`.
   - Otherwise (`<input>` text-likes, `<textarea>`) → use the corresponding native setter (`HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype`), then dispatch `'input'` then `'change'`. **This is critical for React controlled components** — directly assigning `.value` does not trigger React's onChange.
4. Resolve submit button: `f.querySelector('button[type="submit"], input[type="submit"]') ?? f.querySelector('button:not([type="button"])')`. If found → `btn.click()` → `{ ok: true, via: 'button', missingFields }`.
5. Else if `typeof f.requestSubmit === 'function'` → `f.requestSubmit()` → `{ ok: true, via: 'requestSubmit', missingFields }`.
6. Else → `try { f.submit(); return { ok: true, via: 'submit_native', missingFields }; } catch { return { ok: false, reason: 'submit_failed', via: 'submit_native' }; }`.

Implementation note: the entire IIFE is one template literal. Use `JSON.stringify(formSelector)` and `JSON.stringify(input)` for the only two interpolations. No `+` string concatenation across host/page boundaries.

**DO NOT:** call `cssEscape` anywhere in the new script. The page-side selector is `'[name=' + JSON.stringify(name) + ']'` which is safe for any string by JSON-quoting rules.

### Task 3 — Rewrite `runFormSubmit` to call only `scope.evaluate` (10 min)
**Assignee:** @coder
**Depends on:** Task 2
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts`
**Files to create:** none
**Test:** unit tests in Task 5 pass
**Done when:** `runFormSubmit`:
1. Coerces input values: build `coerced: Record<string, string>` by iterating `Object.entries(input)`, skipping `null`/`undefined`, and `String(value)` for the rest.
2. Calls `await scope.evaluate(buildFillSubmitScript(formSelector, coerced))`.
3. Wraps the call in `try { ... } catch (err) { throw new Error('submit: page_eval_threw: ' + String(err)); }`.
4. Treats `result.value === undefined` → throw `Error('submit: no_result (formSelector=<sel>)')`.
5. Narrows result.value via `as { ok?: boolean; reason?: string; via?: string; field?: string; missingFields?: string[] } | undefined`.
6. If `v.ok !== true` → throw `Error('submit: <reason ?? "unknown"> (formSelector=<sel>)')`. If `reason === 'file_field_unsettable'` and `field !== undefined`, append `(field=<name>)` to the thrown message for diagnostic clarity.
7. If `v.ok === true` and `missingFields !== undefined && missingFields.length > 0` → log a `log.warn('runFormSubmit: missing fields skipped', { formSelector, missingFields })`. Do not throw. Import `log` from `../log.js` (already used in `dom-walker.ts:5`).

Function stays under 40 lines.

**DO NOT:** keep the per-field `scope.type` loop. It is removed entirely.

### Task 4 — Remove `cssEscape` if unused (2 min)
**Assignee:** @coder
**Depends on:** Task 3
**Files to modify:** `packages/cli/src/phases/form-submit-runner.ts`
**Files to create:** none
**Test:** `pnpm -C packages/cli build` passes; grep confirms zero callers
**Done when:** `cssEscape` is deleted iff it has no remaining callers. If it does (it shouldn't after Task 3), leave it alone and explain in a comment.

### Task 5 — Replace unit tests in `execute-form-submit.test.ts` (25 min)
**Assignee:** @coder
**Depends on:** Tasks 2, 3, 4
**Files to modify:** `packages/cli/src/phases/execute-form-submit.test.ts`
**Files to create:** none
**Test:** `pnpm -C packages/cli test --run execute-form-submit` — all green
**Done when:** the test cases in §6 all exist and pass. Each test stubs `scope.evaluate` and inspects either the script (string contains assertions) or the resolved/rejected outcome. No real browser. Existing `isStringKeyedRecord` tests retained verbatim.

**Test stub pattern:**
```ts
function makeScope(value: unknown = { ok: true, via: 'button', missingFields: [] }) {
  return { evaluate: vi.fn().mockResolvedValue({ value }) };
}
```

**DO NOT:** retain assertions about `scope.type` being called — `type` is no longer on the scope type and not on the stub.

### Task 6 — Smoke acceptance run on TraiderJo (15 min, mostly waiting)
**Assignee:** @qa
**Depends on:** Tasks 1–5 merged onto `spec/v10-form-selector` (or whatever feat branch implements this spec)
**Files to modify:** none
**Files to create:** none
**Test:** smoke run against TraiderJo, then count infra failures by message
**Done when:** the run produces fewer than 5 `browser_element_not_found` infra failures with detail starting `No matching ref in snapshot or DOM`. See §9 and §11 for the exact command.

**DO NOT:** modify production data. Use the existing TraiderJo smoke target.

---

## §9 Acceptance Criteria

The TraiderJo smoke run on `spec/v10-form-selector` (or the implementing feature branch) produces **fewer than 5** infra failures matching the regex `^No matching ref in snapshot or DOM` across all clusters, where the baseline run `w07xdntnuvb08pd3my7dg9v3` produced 41.

Counting method (deterministic):
```
jq -c '.findings[] | select(.kind == "browser_element_not_found") | .detail' \
  /root/BugHunter/runs/<new-run-id>/findings.json \
  | grep -c '^"No matching ref in snapshot or DOM'
```
Substitute the actual JSON path used by the run output. The number must be `< 5`.

Secondary acceptance (no regressions):
- All existing unit tests in `packages/cli` pass.
- TypeScript compiles with zero errors.
- ESLint passes with zero warnings.
- `runs/<new-run-id>` produces at least as many test cases as the baseline (i.e. fix did not silently skip planning the form submits).
- No new infra-failure class introduced (e.g. no spike in `browser_crash` or `transport`).

---

## §10 Risks

1. **React 18 controlled-component edge cases.** Setting `.value` directly on a React-controlled input does not propagate. The native-value-setter pattern + `'input'`/`'change'` event dispatch handles React 16/17/18 and Preact, but if TraiderJo uses Solid / Lit / a custom binding library, the field may not register the new value before submit fires. Mitigation: `requestSubmit()` triggers the form's native submission pipeline regardless of framework state; the back end will see the input's `name=value` pair from the form serialization, not from the framework state. The form submission as a network request is what the security probe inspects.
2. **`<select>` and `<textarea>` paths are tested only against jsdom-style stubs in unit tests.** Real-browser behaviour with the native-value-setter pattern is well-known but unverified for our specific camofox/Playwright build. Mitigation: §11 includes a manual replay step against TraiderJo's profile form, which has a `<textarea>` (the bio field) — exercising at least one non-text input shape on the live target.
3. **`missingFields` warnings drown the logs.** If the planner's input map and the live DOM diverge on every action (e.g. the form was re-rendered with different field names), every action logs a warning. Mitigation: log at `warn` level (already noisy is fine for a smoke run); follow up in v0.11 if this becomes signal pollution.
4. **`replay.ts` unintended behaviour change.** Replay calls `runFormSubmit(browser, entry.selector, input)` with `browser` (full adapter, not a scope). The new `FormSubmitScope` type only requires `evaluate`, so structurally the adapter is still compatible. **Verify in Task 1's typecheck.**
5. **The infra failures might not all be this class.** If the 41 failures aren't all `:nth-of-type` form-fill failures (e.g. some are state-page failures despite v0.9), the gate of <5 could be unmet even if this fix is perfect. Mitigation: if the gate fails, count the non-form-fill subset before declaring failure; the success criterion is the form-fill subset < 5. Phrase the smoke acceptance as: "infra failures whose `action.kind === 'submit'` AND `detail` starts with 'No matching ref' must be < 5."

---

## §11 Killer-Demo Runbook

```bash
# 1. Implement the spec on a feature branch off main
cd /root/BugHunter
git checkout -b feat/v10-form-selector main
# ... apply Tasks 1-5 ...

# 2. Local verification
pnpm -C packages/cli typecheck
pnpm -C packages/cli lint --max-warnings 0
pnpm -C packages/cli test --run execute-form-submit
pnpm -C packages/cli test
pnpm -C packages/cli build

# 3. Replay one baseline failure to confirm fix at the unit level
#    (pick any test case from runs/w07xdntnuvb08pd3my7dg9v3 with action.kind === 'submit')
node packages/cli/dist/index.js replay \
  --run-id w07xdntnuvb08pd3my7dg9v3 \
  --test-id <pick-one-submit-test-id> \
  --target https://traiderjo.example
# Expect: no "browser_element_not_found" in the replay output;
# instead, either the form submits successfully or the planner's
# expected security finding is reproduced.

# 4. Full smoke against TraiderJo
node packages/cli/dist/index.js scan \
  --target https://traiderjo.example \
  --run-id-prefix v10-smoke

# 5. Count post-fix form-fill infra failures
RUN=$(ls -td /root/BugHunter/runs/v10-smoke-* | head -1)
jq '.findings[] | select(.kind == "browser_element_not_found") | select(.action.kind == "submit") | .detail' \
  "$RUN/findings.json" | grep -c '^"No matching ref'
# Expect: < 5.

# 6. Diff cluster counts vs baseline
jq '.clusters | length' /root/BugHunter/runs/w07xdntnuvb08pd3my7dg9v3/clusters.json
jq '.clusters | length' "$RUN/clusters.json"
# Expect: equal-or-fewer, NOT new clusters.

# 7. Open PR
gh pr create --title "v0.10: form fill+submit via single evaluate" \
  --body "Closes the form-fill-against-unnamed-input infra-failure class. Run: $RUN."
```

---

## Spec self-checklist

- [x] Objective and boundaries declared (§1)
- [x] Existing code map (§2) — every file the agent must read or must NOT touch is named with absolute path
- [x] Investigation findings (§3) backed by file:line references — no hallucinated APIs
- [x] One design picked with rationale (§4); other four rejected with reasons
- [x] Edge cases enumerated, 12 of them (§5)
- [x] Test plan (§6) — unit assertions named, smoke gate quantified
- [x] Negative requirements (§7) — explicit DO NOTs, no `any`, no new files, no cross-repo changes
- [x] Tasks (§8) — 6 tasks, each ≤30 min, each with assignee/deps/files/test/done-when/do-not
- [x] Acceptance gate (§9) — quantitative, copy-pasteable jq command
- [x] Risks (§10) — 5 risks with mitigations
- [x] Runbook (§11) — copy-pasteable from branch creation to PR open
