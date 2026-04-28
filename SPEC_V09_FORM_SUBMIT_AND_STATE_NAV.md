# SPEC — v0.9 Form Submit + State Navigation

**Status:** Draft 1, ready for `@coder` · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Source:** TraiderJo smoke run `mxbzhc08wag7m3riowd7ddzs` (post SurfaceMCP PR #18 closure-nav resolution).

This spec patches two **consumer-side** bugs in BugHunter that produced **34 infrastructure failures** out of 8 clusters in the latest TraiderJo smoke. SurfaceMCP PR #18 already resolved the closure-nav side of state navigation; the remaining failures are entirely BugHunter's. Both bugs are localised, scoped, and independently verifiable. Land them in a single PR `feat/v09-form-and-state-nav`.

When a phrase appears in **bold** in a Done-when clause, the verifier (test or human) should look for it literally.

---

## 0. Live evidence (from `mxbzhc08wag7m3riowd7ddzs`)

`/tmp/TraiderJo/.bughunter/runs/mxbzhc08wag7m3riowd7ddzs/`:

- Total clusters filed: **8**.
- Total infrastructure failures: **34**.
- Of the 34 infra failures:
  - **19+** carry detail `Browser action failed: Error: execute: submit action missing selector`. All originate on `/?setTab=profile` (a state-page) when `formTestCases` produces a 14-field profile form.
  - **15+** carry generic execute failures plus log noise of the shape `cluster: testId present but stateByTestId lookup missed` and `Element exists in DOM but has no accessible name in snapshot` / `No matching ref in snapshot or DOM`. All on state-suffixed pages: `/?setTab=trades`, `/?setTab=import`, `/?setTab=expenses`, `/?setTab=heatmap`.

Both classes share a single underlying cause for each respective failure path. § 3 and § 4 spec the fixes.

---

## 1. Objective

Two bug fixes, one PR.

**Bug 1 (form-submit infra failures).** `formTestCases` emits `action.kind: 'submit'` test cases without a `selector`, and `executeUiTestInner`'s `case 'submit':` requires one. Furthermore, even with a selector, the action's `input` Record (carrying every field's planted value) is never typed into the form; submit fires against an empty form. **Both gaps are fixed in this PR.**

**Bug 2 (state-page navigation).** `discovery/crawler.ts` reaches state-pages by clicking a navbar trigger after navigating to `baseRoute`. The discovery succeeds. But the synthetic route `"/?setTab=trades"` is then propagated to `TestCase.page` and execute treats it as a literal URL to navigate. TraiderJo (and other state-only SPAs) do **not** read URL query for tab state, so the test runs on the default-tab DOM. Tests that target state-page-specific elements fail with infra noise. **The fix re-establishes state by navigating to baseRoute and re-issuing the trigger click before the action runs.**

### 1.1 Boundaries

In scope:
- `mutation/apply.ts` (formTestCases shape).
- `phases/execute.ts` (submit handling + state-context pre-action).
- `phases/plan.ts` (propagate `stateContext` to TestCase).
- `types.ts` (add optional `TestCase.stateContext`; document semantics).

Out of scope:
- Discovery is **untouched**. `crawler.ts buildStatePage` already produces `DiscoveredPage.stateContext`; we consume it from there.
- `clickByHint` adapter behaviour is **untouched**. The fix only adds new call sites.
- No changes to `Action`'s union shape. `submit` keeps its existing `kind`. The action-log writer is untouched.
- No changes to cross-user / API paths. `executeApiTest` is untouched.
- No changes to the `formSignature` / `formCollapseSignature` dedup logic.
- No new dependencies. No new files outside test fixtures.
- Discovery-side submit-button selector enrichment is explicitly NOT done here — see §3.4 rationale.

External dependencies:
- `BrowserMcpAdapter.TabScope.evaluate`, `.type`, `.click`, `.clickByHint`. All exist; we only add new call sites.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `TestCase`, `Action`, `DiscoveredForm`, `DiscoveredPage`, `TriggerSelectorHint`. The `TestCase.stateContext` addition lives here. **Add to this file; do not create a parallel types module.** |
| `packages/cli/src/mutation/apply.ts` | `formTestCases` (lines 10–36) — sets `action.kind: 'submit'` today with NO `selector` and the field-value Record only on `action.input`. The Bug 1 fix changes this function. |
| `packages/cli/src/phases/execute.ts` | `executeUiTestInner` switch case `'submit'` at lines 432–436 — currently throws because `action.selector` is undefined. The Bug 1 fix rewrites this case. `executeUiTest` line 647 builds `pageUrl` — Bug 2 fix changes the URL choice when `tc.stateContext` is set. The pre-action hook for state re-establishment slots in `executeUiTestInner` after `preSnapshot` (around line 400) and before the action switch at line 425. |
| `packages/cli/src/phases/plan.ts` | `runPlan` iterates `discovery.pages`. Today it passes `page.route` to every test-case factory. The Bug 2 fix passes `page.stateContext` (when defined) through `renderTestCase`, `navigateTestCase`, `clickTestCase`, and `formTestCases`. |
| `packages/cli/src/discovery/crawler.ts` | `buildStatePage` (lines 121–138) is the **source of truth** for `DiscoveredPage.stateContext`. Read it to confirm the shape — DO NOT modify it. The synthetic-route `/?<stateVar>=<stateValue>` is the dedup key, not a real URL; honour that. |
| `packages/cli/src/discovery/dom-walker.ts` | Confirms that `DiscoveredForm.formSelector` is a CSS selector that uniquely identifies the form element on its host DOM (`#<id>` or `form:nth-of-type(N)`). Field `name` is the HTML `name` attribute (or `id` fallback or `field_<index>`). The submit-button-selector helper in §3.3 relies on this contract. |
| `packages/cli/src/adapters/browser-mcp.ts` | `TabScope.evaluate(script: string)` returns `{ tabId; result?; value? }`. `TabScope.type(selector, text)` and `TabScope.click(selector)` are the primitives the new submit-flow uses. `TabScope.clickByHint(hint)` is the primitive Bug 2 uses for re-establishing state — its return shape is `{ clicked: boolean, ...} `. |
| `packages/cli/src/adapters/browser-mcp-error.ts` | `BrowserMcpError.kind` discriminator: `'element_not_found' \| 'transport' \| 'timeout'`. The submit fallback chain catches `element_not_found` and proceeds to the next candidate; transport/timeout propagate. |
| `packages/cli/src/mutation/apply.test.ts` | Test pattern for `formTestCases`. Extend, do not replace. |

### 2.2 Patterns to follow

- **Logging:** structured logger from `packages/cli/src/log.ts`. No `console.log`, no new logger.
- **Errors:** typed `BrowserMcpError` for browser-side failures; otherwise wrap with `Error(\`...: ${String(err)}\`)` and rely on the executor's outer infra-failure capture (already present).
- **Types:** strict TypeScript. No `any`. Narrow `unknown` via the `Record<string, unknown>` pattern used elsewhere.
- **Side effects:** `executeUiTestInner` is the single place that drives DOM mutation per test. Do not push DOM-mutating logic into `executeUiTest`'s pre-flight or into the planner.

### 2.3 DO NOT

- DO NOT add new files outside the test fixtures listed in §7.
- DO NOT change `DiscoveredPage.stateContext` shape or `crawler.ts` behaviour.
- DO NOT change `clickByHint` semantics.
- DO NOT introduce a new `ActionKind`.
- DO NOT introduce a new HTML parser dependency (cheerio, jsdom, parse5). The submit-button-selector helper runs **inside** `scope.evaluate` against the live DOM via `document.querySelector`.
- DO NOT alter `formSignature` or `formCollapseSignature`. Form dedup behaviour stays identical.
- DO NOT widen `Action.input` to `Record<string, unknown>` on the type level. Today it is `unknown`; we narrow with a runtime guard at the call site (the type stays permissive for API tests that pass primitives).
- DO NOT reach into `runState.discovery.pages` from inside `executeUiTestInner`. The state-context must flow through `TestCase`. `executeUiTestInner` does not (and should not) know about `DiscoveryOutput`.
- DO NOT split a single submit test case into many fill+submit cases. The 1:1 invariant between TestCase and (preState, postState, occurrenceId) tuple is downstream-load-bearing (cluster.ts:127, action-log.ts).

---

## 3. Bug 1 — Submit action: no selector + no field fill

### 3.1 Problem (recap)

`mutation/apply.ts:10–36`:

```ts
return palettes.map(palette => ({
  id: createId(), runId, role, page, formSignature: formSig,
  action: {
    kind: 'submit',
    via: 'ui',
    expectedOutcome: ...,
    palette,
    input: buildFormInput(form.fields, palette, runIdForEmail, domainHints),
    // NO selector
  },
  ...
}));
```

`phases/execute.ts:432–436`:

```ts
case 'submit':
  if (tc.action.selector === undefined) throw new Error('execute: submit action missing selector');
  if (tc.action.selector === '') throw new Error('execute: submit action has empty selector — planning bug?');
  await scope.click(tc.action.selector);
  break;
```

The submit case has **no fill loop** anywhere — `action.input` is only touched by the action-log writer for context.

### 3.2 Design choice

Three options were considered:

1. **Extend the existing `submit` case.** Drive a fill loop from `action.input`'s Record, then click the form's submit button. Reuse existing `Action.selector` for the form-element selector. Net: planning churn near-zero, execute churn ~30 lines, no schema migration.
2. **Emit a sequence of `fill` test cases followed by one `submit` per palette.** Per 14-field TraiderJo profile form × 4 palettes = 56 fill cases plus 4 submits, vs. 4 today. Multiplies UI test count by ~14× per form. Breaks the 1-action-per-test invariant downstream relies on (cluster.ts:127 keys on `testId → preState/postState`; action-log writes one log per testId; missing-state-change classifier compares pre vs. post per single action). Significant downstream churn.
3. **New `ActionKind: 'form_submit'`.** Cleanest schema, but every consumer of `Action.kind` (action-log, classify, cross-user, replay) gets a new branch. ~10 call sites.

**Choice: Option 1.** Lowest churn, no schema migration, no downstream breakage. The semantic clarification — `Action.input` for `kind: 'submit'` drives a fill loop, not just action-log context — is documented in `types.ts` and `apply.ts`. Submit is the only action that already carries `input` as a Record-shaped value; promoting it to load-bearing is consistent.

The argument against Option 1 — coupling submit to an `unknown`-typed Record — is mitigated by a tight runtime guard at the single consumer site (§3.4 step 2). The argument against Option 2 (planner-budget blow-up + downstream invariant break) is decisive. The argument against Option 3 (cross-cutting churn for what is ultimately a missing-fill-loop bug) is decisive.

### 3.3 Submit-button selector resolution

**Problem:** `DiscoveredForm` does not carry a submit-button selector today, only `formSelector` (the form element). We MUST locate the submit button at execute time without round-tripping per candidate.

**Design:** one `scope.evaluate` call performs the resolve-and-click in a single browser round-trip. The script:

```js
((formSelector) => {
  const f = document.querySelector(formSelector);
  if (f === null) return { ok: false, reason: 'form_not_found', formSelector };
  const btn =
    f.querySelector('button[type="submit"], input[type="submit"]') ??
    f.querySelector('button:not([type="button"])');   // HTML5 implicit submit
  if (btn !== null) {
    btn.click();
    return { ok: true, via: 'button' };
  }
  if (typeof f.requestSubmit === 'function') {
    f.requestSubmit();
    return { ok: true, via: 'requestSubmit' };
  }
  f.submit();
  return { ok: true, via: 'submit_native' };
})(<formSelector>)
```

The helper lives in `mutation/apply.ts` (or, preferred, in a new const exported from `phases/execute.ts`) as a string template. The execute flow calls `scope.evaluate(script)`, parses `result.value`, and if `ok === false` returns an infra failure of kind `browser_element_not_found` with `detail: \`submit: form_not_found (formSelector=${selector})\``. If `ok === true`, fall through to the post-action settle-and-snapshot path.

**Why this approach:**
- No round-trip per fallback candidate. One evaluate, one decision tree.
- `requestSubmit()` triggers the React onSubmit handler (works in React 16+ with synthetic events).
- `f.submit()` is the legacy fallback; bypasses React handlers but at least dispatches a native submit. Forms that rely on it are vanishingly rare in 2026 SPAs but cost nothing to support.
- `button:not([type="button"])` is the HTML5 spec for implicit submit when no explicit submit button is declared.

### 3.4 Why not enrich `DiscoveredForm` with a submitSelector?

Tempting, but it adds a discovery-side change (dom-walker.ts) for what is ultimately a sub-100-line execute-side fix. The submit-button is uniquely determined by the form element in 99%+ of real forms; computing it at execute time is cheap (one evaluate). Spec discipline: **when a fix can be implemented in one layer, do not split it across three.**

If a future spec adds non-trivial submit-button heuristics (e.g. detecting a submit button outside the form via `form="..."` attribute, or distinguishing primary vs. secondary submit buttons), revisit. Out of scope here.

### 3.5 Fix detail — code surface

**Change A — `mutation/apply.ts` `formTestCases` (lines 10–36):**

Set `action.selector = form.formSelector`. The Record on `action.input` is unchanged in shape; its semantic role is upgraded to "drives the fill loop in execute."

```ts
return palettes.map(palette => ({
  id: createId(), runId, role, page, formSignature: formSig,
  action: {
    kind: 'submit',
    via: 'ui',
    expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
    palette,
    selector: form.formSelector,                          // NEW
    input: buildFormInput(form.fields, palette, runIdForEmail, domainHints),
  },
  expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
  palette,
}));
```

`xssFormTestCases` / `mintCanaryFormCase` already produce `kind: 'submit'` with no selector (lines 232–248). Apply the same change there: set `action.selector = form.formSelector`. The XSS canary fill loop reuses the same submit-flow in execute.

**Change B — `phases/execute.ts` `executeUiTestInner` `case 'submit':` (lines 432–436):**

Replace the body with a fill-then-submit sequence. Extract a helper `runFormSubmit(scope, formSelector, input)` to keep the switch under 40 lines.

```ts
case 'submit': {
  if (tc.action.selector === undefined) throw new Error('execute: submit action missing selector');
  if (tc.action.selector === '') throw new Error('execute: submit action has empty selector — planning bug?');
  const inputRecord = isStringKeyedRecord(tc.action.input) ? tc.action.input : {};
  await runFormSubmit(scope, tc.action.selector, inputRecord);
  break;
}
```

Where `runFormSubmit` is a top-level helper in `execute.ts`:

```ts
async function runFormSubmit(
  scope: TabScope,
  formSelector: string,
  input: Record<string, unknown>,
): Promise<void> {
  // Step 1: fill every named field. Skip undefined/null; coerce others to string.
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const fieldSelector = `${formSelector} [name="${cssEscape(name)}"]`;
    await scope.type(fieldSelector, String(value));
  }
  // Step 2: submit via single-evaluate resolver.
  const result = await scope.evaluate(buildSubmitScript(formSelector));
  const v = result.value as { ok?: boolean; reason?: string; via?: string } | undefined;
  if (v?.ok !== true) {
    throw new Error(`submit: ${v?.reason ?? 'unknown'} (formSelector=${formSelector})`);
  }
}

function buildSubmitScript(formSelector: string): string {
  // formSelector is a CSS selector emitted by dom-walker; pass via JSON.stringify
  // to defend against quote/escape issues. The script itself is a self-IIFE.
  const fs = JSON.stringify(formSelector);
  return `((formSelector) => {
    const f = document.querySelector(formSelector);
    if (f === null) return { ok: false, reason: 'form_not_found' };
    const btn =
      f.querySelector('button[type="submit"], input[type="submit"]') ??
      f.querySelector('button:not([type="button"])');
    if (btn !== null) { btn.click(); return { ok: true, via: 'button' }; }
    if (typeof f.requestSubmit === 'function') { f.requestSubmit(); return { ok: true, via: 'requestSubmit' }; }
    f.submit(); return { ok: true, via: 'submit_native' };
  })(${fs})`;
}

function isStringKeyedRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cssEscape(name: string): string {
  // Minimal escape: escape backslash and double-quote within a [name="..."] attribute selector.
  // Names from dom-walker are HTML name attributes; the harsh real-world set is
  // limited but defensive escaping is essential.
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
```

The `cssEscape` is intentionally minimal — full CSS.escape is not available in a TabScope and the field names we receive are HTML `name` attributes (already constrained). Don't pull in a polyfill.

**Change C — XSS variant.** `mintCanaryFormCase` at `mutation/apply.ts:219–249` also emits `kind: 'submit'`. Add `action.selector: form.formSelector`. The canary-fill semantics already match the new fill loop (the `input` Record holds the canary value on the targeted field plus empty strings on others; `runFormSubmit` types every named field).

**Edge case — empty-string fill values.** `mintCanaryFormCase` plants `''` on non-target fields. Today's pseudo-fill skipped these (the loop didn't run). After the fix, `runFormSubmit` will type empty strings into every non-target field. This is **acceptable and correct** — typing an empty string into a text input clears any placeholder-based default and reflects the test intent (the canary is the only meaningful input). Confirmed against `scope.type(selector, '')` semantics.

**Edge case — array/object fields.** `buildFormInput` may emit nested values for `array` fields. `String(value)` will produce `"[object Object]"` for objects or comma-joined for arrays. This is a known wart of the existing planner and is out of scope; document it in `runFormSubmit` with a code comment but do not fix it here.

### 3.6 Negative requirements specific to Bug 1

- DO NOT add a new `ActionKind`.
- DO NOT widen `Action.input` to a Record-typed field. The runtime guard `isStringKeyedRecord` is the contract.
- DO NOT loop fill with concurrency. `scope.type` ordering matters (some forms have dependent fields; e.g. country → state). Sequential by `Object.entries` order, which preserves insertion order on plain objects (ES2015+).
- DO NOT add retry on `scope.type` failure. If a single field can't be typed, surface the underlying `BrowserMcpError`; the executor's outer try/catch will convert to an infra failure.
- DO NOT log per-field type calls at `info` (would flood the log on 14-field forms). `log.debug` only, and only on type failure.

---

## 4. Bug 2 — State-page navigation

### 4.1 Problem (recap)

`crawler.ts:122` builds `syntheticRoute = "/${baseRoute}?${stateVar}=${stateValue}"` for state-pages. The synthetic route is a **dedup key**, not a real URL. State-pages are reached at crawl time via `navigate(baseRoute) → clickByHint(triggerHint)` (lines 273–284 in `crawler.ts`).

Plan emits TestCases with `tc.page = page.route = "/?setTab=trades"`. Execute does:

```ts
const pageUrl = tc.page.startsWith('http') ? tc.page : `${appBaseUrl ?? ''}${tc.page}`;
// → "http://127.0.0.1:8787/?setTab=trades"
result = await browser.withTab(pageUrl, headers, scope => executeUiTestInner(...));
```

For SPAs that don't read URL query for tab state (TraiderJo, most React/Redux apps), this lands on the default tab. Tests targeting tab-specific elements fail, generating infra noise.

### 4.2 Design choice

Three options were considered:

1. **Carry `stateContext` on `TestCase`; execute re-establishes state pre-action.** Schema-additive (one optional field), planner copies through, execute calls `scope.clickByHint(triggerHint)` after navigating to `baseRoute`. Per-state-page test coverage preserved.
2. **Collapse state-page tests into a single click test on the trigger.** Loses all DOM coverage of state-page-internal elements (forms, buttons, links discovered after the click). Throws away discovery work the crawler already did.
3. **Pre-action sequence on every TestCase via a new `Action.preActions` array.** Generalised model. ~3× the schema surface for a fix that has exactly one use case today.

**Choice: Option 1.** Preserves per-state-page DOM coverage (TraiderJo has 6 reached state-pages, each with distinct elements/forms/links — this is real signal). The schema delta is one optional field. The execute delta is one branch before the action switch. The planner delta is one parameter passed through four factory helpers.

Option 2 is a non-starter — it deletes discovery work. Option 3 is the right answer if and when a second use case appears (e.g. multi-step wizard navigation) but YAGNI today.

### 4.3 stateContext data flow

```
DiscoveredPage.stateContext (from crawler.ts:130–135)
   └→ runPlan iterates discovery.pages
        └→ when page.kind === 'state' && page.stateContext !== undefined,
           planner passes ctx to every test-case factory
              └→ TestCase.stateContext (NEW field, optional)
                   └→ executeUiTest reads tc.stateContext
                        ├→ navigate to appBaseUrl + ctx.baseRoute (instead of tc.page)
                        └→ executeUiTestInner re-establishes state via clickByHint(ctx.triggerHint)
                             before action switch (skipped for kind: 'navigate')
```

The synthetic route on `tc.page` is **preserved** — it remains the dedup/cluster key and the human-readable label in artifacts. State-context is the side-channel that tells execute how to physically reach that state.

### 4.4 Fix detail — code surface

**Change A — `types.ts` `TestCase`:**

Add an optional field. Reuse the existing `DiscoveredPage.stateContext` shape verbatim (do not rename fields).

```ts
export type TestCase = {
  id: string;
  runId: string;
  role: string;
  page: string;
  action: Action;
  expectedOutcome: ExpectedOutcome;
  palette: PaletteVariant;
  formSignature?: string;
  elementSignature?: string;
  /**
   * Set when the test case was discovered on a state-page (kind: 'state').
   * Execute uses this to navigate to baseRoute and re-issue the trigger click
   * before running the action — the synthetic `page` route ("/?setTab=trades")
   * is a dedup key, NOT a literal URL the SPA honours. Skipped for navigate actions.
   */
  stateContext?: {
    baseRoute: string;
    stateVar: string;
    stateValue: string;
    triggerHint: TriggerSelectorHint;
  };
};
```

Document the semantic in the JSDoc; do not weaken the optional-ness with a default.

**Change B — `phases/plan.ts`:**

Update the four factory helpers (`renderTestCase`, `navigateTestCase`, `clickTestCase`, `formTestCases`) to accept and propagate `stateContext`. Inside `runPlan`, derive `pageStateCtx = page.kind === 'state' ? page.stateContext : undefined` once per page-iteration and pass to every factory call for that page.

```ts
for (const page of discovery.pages) {
  const pageStateCtx = page.kind === 'state' ? page.stateContext : undefined;

  testCases.push(renderTestCase(runId, role, page.route, pageStateCtx));

  for (const link of page.links) {
    if (!seenLinks.has(link)) {
      seenLinks.add(link);
      testCases.push(navigateTestCase(runId, role, page.route, link, pageStateCtx));
    }
  }

  for (const el of page.elements) {
    if (el.tag === 'button' || el.roleAttr === 'button') {
      if (!elSigs.has(el.selector)) {
        elSigs.add(el.selector);
        testCases.push(clickTestCase(runId, role, page.route, el.selector, pageStateCtx));
      }
    }
  }

  for (const form of page.forms) {
    // ... dedup logic unchanged ...
    const cases = formTestCases(runId, role, page.route, form, runId, config.domainHints, pageStateCtx);
    testCases.push(...cases);

    if (xssEnabled && xssCount < xssMaxTestCases) {
      const xssCases = xssFormTestCases(runId, role, page.route, form, xssDepth, pageStateCtx);
      const allowed = Math.min(xssCases.length, xssMaxTestCases - xssCount);
      testCases.push(...xssCases.slice(0, allowed));
      xssCount += allowed;
    }
  }
}
```

Each factory adds the new optional param at the end of its signature and threads it onto the returned `TestCase.stateContext`. The `apiTestCases` / `xssApiTestCases` factories DO NOT receive `stateContext` — API tests don't traverse the browser DOM. (Server actions on a state-page page are not API-side anyway; they're filtered out at plan.ts:96.)

`xssFormTestCases` already exists in `mutation/apply.ts:163`. Add the same optional `stateContext` param. Same for `mintCanaryFormCase`.

**Change C — `phases/execute.ts` `executeUiTest` `pageUrl` derivation (line 647):**

When `tc.stateContext !== undefined`, navigate to `baseRoute`, not the synthetic state-page URL.

```ts
const navTarget = tc.stateContext !== undefined
  ? tc.stateContext.baseRoute
  : tc.page;
const pageUrl = navTarget.startsWith('http') ? navTarget : `${appBaseUrl ?? ''}${navTarget}`;
```

The `headers` and the `withTab` call are unchanged; the action-log still records `tc.page` (the synthetic route) as the `page` field for human-readable artifacts. Action-log gets one new field `stateContext` mirroring `tc.stateContext` (so the replay command can reproduce the state-establishment).

**Change D — `phases/execute.ts` `executeUiTestInner` pre-action state establishment:**

After `preSnapshot` (line 400) and after the `onPageBaseline` hook (line 404–409), and **before** the `MutationObserver` start (line 411), add a state-establishment block. Skip it when the action is `navigate` (the navigate target replaces the page entirely, so re-establishing state is wasted).

```ts
// State-page re-establishment: if discovery reached this page via a click trigger
// after navigating to a base route, re-issue the trigger click so the action
// runs against the correct DOM state. Skipped for `navigate` actions (those
// take us off the state-page anyway) and for `render` actions where the
// snapshot we already captured is already correct... — wait, no: even render
// needs the trigger so that postSnapshot reflects the state-page DOM. Skip ONLY
// for `navigate`.
if (tc.stateContext !== undefined && tc.action.kind !== 'navigate') {
  const triggerRes = await scope.clickByHint(tc.stateContext.triggerHint);
  if (!triggerRes.clicked) {
    return {
      testId: tc.id,
      occurrenceId,
      passed: false,
      bugs: [],
      infrastructureFailure: {
        id: createId(),
        runId,
        timestamp: new Date().toISOString(),
        kind: 'browser_element_not_found',
        detail: `state-nav: trigger_not_found (hint=${JSON.stringify(tc.stateContext.triggerHint)}, baseRoute=${tc.stateContext.baseRoute})`,
        role: tc.role,
        page: tc.page,
        action: tc.action,
      },
      durationMs: Date.now() - start,
    };
  }
  // Settle delay: same as crawler.stateSettleMs default (250ms).
  await new Promise<void>(r => { setTimeout(r, 250); });
}
```

The settle is hard-coded to 250ms — matches `crawler.ts:284`'s default. Do not plumb `crawl.stateSettleMs` into execute; it would couple two phases for a marginal benefit. If a project needs longer settle, document in a follow-up.

**Why insert before `MutationObserver` start, not after?** The MutationObserver tracks DOM changes during the test action. State-establishment is **setup**, not the action under test. Mutations from the trigger click are not the bug we're hunting. Placing the trigger before observer-start ensures the observer's window reflects only the action's DOM mutations — preserving the missing-state-change classifier's signal.

**Why before MutationObserver but after `onPageBaseline`?** The page-baseline hook (a11y axe scan, keyboard-trap probe) is per-route bookkeeping that runs on first visit to a route. The trigger has not yet established state; running axe on the default-tab DOM is acceptable for baseline (and arguably more correct — the state-page-internal DOM is a derived view; the route's "baseline" is the default landing). This matches the crawler's discovery semantics (axe-scan happens at the URL level, not the state-page level).

### 4.5 Edge cases

1. **`tc.action.kind === 'navigate'` on a state-page-discovered link.** Skip state re-establishment. The link target (e.g. `/wiki/x`) takes the browser fully off the state-page anyway; clicking the trigger first and then immediately navigating wastes a click and produces misleading network logs. The skip is documented in the code comment and the spec.
2. **`clickByHint` returns `{clicked: false, reason: 'no_hint'}`.** Means the discovered triggerHint had every field empty. Should not happen (crawler.ts:225 only enqueues a state item with a populated hint), but defensive infra failure with `detail: state-nav: trigger_no_hint`.
3. **`clickByHint` returns `{clicked: false, reason: 'not_found'}`.** Trigger element disappeared between discovery and execution (DOM drift, route moved, A/B flag flip). Treat as `browser_element_not_found` infra failure. Do not retry. Log once.
4. **`clickByHint` throws.** `BrowserMcpError` propagates and is caught by the outer try/catch in `executeUiTestInner` (lines 455–494) which already converts transport/timeout/element-not-found into infra failures. Do not double-handle.
5. **Multiple state-pages share the same `baseRoute`.** Each carries a distinct `triggerHint`. Test cases per state-page run independently; each opens its own tab and re-establishes state via its own trigger. No cross-test ordering dependency.
6. **State-page form tests.** A 14-field profile form on `/?setTab=profile`. Sequence: navigate to `/`, clickByHint(setTab=profile), settle 250ms, fill 14 fields via Bug 1's fix, submit. Both fixes compose.
7. **State-page XSS canary tests.** `xssFormTestCases` carries `stateContext` through `mintCanaryFormCase`. Same compose semantics as point 6.
8. **`appBaseUrl` undefined.** Existing fallback at `executeUiTest:647` (`${appBaseUrl ?? ''}${tc.page}`) — same behaviour preserved when stateContext is set: `${appBaseUrl ?? ''}${stateContext.baseRoute}`. If the project has no appBaseUrl, the navigate URL is bare path; existing legacy behaviour unchanged.

### 4.6 Negative requirements specific to Bug 2

- DO NOT modify `crawler.ts buildStatePage` or `DiscoveredPage.stateContext`.
- DO NOT change `clickByHint` behaviour. Add new call sites only.
- DO NOT plumb `crawl.stateSettleMs` config through to execute. Hard-code 250ms; matches the crawler default. If a future spec needs configurable settle, plumb it then.
- DO NOT re-establish state for `kind: 'navigate'` actions — see edge case 1.
- DO NOT carry `stateContext` on API test cases. API tests do not traverse the DOM.
- DO NOT cluster two infra failures with different `triggerHint` values into one cluster. The `detail` field carries the hint payload in stringified form; cluster signature already keys on detail.
- DO NOT short-circuit the test on a state-establishment failure with `passed: false` and no infra failure. The infra failure is the contract — it tells the executor that this test was uninvited noise, not a real product bug.

---

## 5. Type changes

Three deltas to `packages/cli/src/types.ts`:

1. **`TestCase.stateContext`** — new optional field. Shape mirrors `DiscoveredPage.stateContext`. JSDoc explains the semantic.
2. **`Action.input` semantic clarification** — JSDoc-only change. Add a comment to the existing `input?: unknown` field noting that for `kind: 'submit'`, this MUST be a `Record<string, unknown>` whose keys are HTML field `name` attributes and whose values are coerced to strings by `runFormSubmit`. No type-level change; the runtime guard `isStringKeyedRecord` enforces.
3. **`Action.selector` semantic clarification** — JSDoc-only. Add a comment noting that for `kind: 'submit'`, this is the form-element selector (e.g. `#login-form` or `form:nth-of-type(1)`), not the submit button.

No other type changes. No new BugKinds. No new InfrastructureFailure kinds (existing `'browser_element_not_found'` and `'generic'` cover both fix paths).

---

## 6. Edge cases (consolidated)

| # | Scenario | Behaviour |
|---|---|---|
| 1 | Submit on a form with zero fields. | Fill loop is empty (`Object.entries({})` yields nothing). Submit step still runs; correct for empty-form smoke tests. |
| 2 | Submit on a form whose submit button is OUTSIDE the form via `form="..."` attribute. | Out of scope; current selector chain finds `form > button[type=submit]` only. Document in spec; revisit if encountered in real projects. |
| 3 | Submit on a form whose submit button is disabled at the moment of click. | `btn.click()` is a no-op on disabled elements; `requestSubmit()` falls through to the next try (it doesn't, actually; `requestSubmit()` on a form with a disabled submitter just doesn't submit). The action completes; `MutationObserver` window is empty; `classifyMissingStateChange` likely fires. This is **correct** — the form genuinely didn't submit, which is a missing-state-change bug worth flagging. No special handling. |
| 4 | Submit script throws inside `scope.evaluate` (CSP blocks inline eval, etc.). | `scope.evaluate` rejects with `BrowserMcpError`. Caught by `executeUiTestInner`'s outer try/catch (lines 455–494); converted to infra failure. Existing path. |
| 5 | State-page test where `triggerHint` is `{}` (all-empty). | `clickByHint` returns `{clicked: false, reason: 'no_hint'}`. We emit `browser_element_not_found` infra failure. Should be impossible per crawler invariants; defensive handling. |
| 6 | State-page test where the navigate to `baseRoute` itself fails. | Existing `withTab` failure path catches it (lines 675–693 in `executeUiTest`). Emits generic infra failure. Unchanged. |
| 7 | Two state-pages with same baseRoute and same stateVar=stateValue but different triggerHint. | Crawler dedup key includes `baseRoute#state=stateVar=stateValue` (queueKey at crawler.ts:106), so this case shouldn't arise — the second is a duplicate. If it does (somehow), they generate distinct test cases (different testIds) but identical TestCase.stateContext; behaviour is identical. |
| 8 | State-page form with stateContext AND submit selector both set. | `executeUiTestInner` runs state re-establishment first (since it gates on `kind !== 'navigate'`, and submit ≠ navigate), then proceeds to the action switch which runs `runFormSubmit`. Both fixes compose; no ordering surprises. |
| 9 | `tc.action.input` is a non-Record (e.g. a string) on a `kind: 'submit'` test case. | Should not happen (formTestCases always emits a Record). `isStringKeyedRecord` returns false, fill loop is skipped (treats as empty Record), submit fires against an empty form. This is the existing bug-1 behaviour minus the missing-selector throw. Still better than today, and the planner-side invariant catches the rest. |
| 10 | Concurrency: two parallel UI tests both target the same form on the same state-page in different tabs. | Each runs in its own `withTab` scope. State-establishment is per-tab. No interference. |

---

## 7. Test plan

### 7.1 Unit tests (extend existing files)

**`packages/cli/src/mutation/apply.test.ts` — extend.**

Add cases for Bug 1:

- `formTestCases` emits `action.selector === form.formSelector` for every palette.
- `xssFormTestCases` emits `action.selector === form.formSelector` for every canary case.
- `formTestCases` carries `stateContext` through when passed (Bug 2).
- `xssFormTestCases` carries `stateContext` through.
- All four palettes emit `Record<string, unknown>` on `action.input` (regression — current behaviour).

**`packages/cli/src/phases/plan.test.ts` — extend (or create if missing).**

Add cases for Bug 2:

- A `DiscoveryOutput` with one `kind: 'state'` page produces TestCases with `stateContext` populated.
- A `DiscoveryOutput` with one `kind: 'url'` page produces TestCases with `stateContext` undefined.
- Render, navigate, click, and submit test cases all carry the same `stateContext` from a state page.
- API test cases never carry `stateContext`.

**`packages/cli/src/phases/execute.test.ts` (or new `execute-form-submit.test.ts`) — create.**

Add tests for Bug 1's `runFormSubmit` helper. Use a fake `TabScope` (vi.fn-mocked) that records type/click/evaluate calls.

- Two-field form: `runFormSubmit(scope, '#f', { username: 'u', password: 'p' })` → expects `scope.type('#f [name="username"]', 'u')` then `scope.type('#f [name="password"]', 'p')` then `scope.evaluate(<submit-script with #f>)`.
- Empty input: zero `scope.type` calls, one `scope.evaluate`.
- Field name with double-quote: `cssEscape('field"weird')` → `'field\\"weird'`; selector emitted is `[name="field\\"weird"]`.
- `scope.evaluate` returns `{ value: { ok: false, reason: 'form_not_found' } }` → `runFormSubmit` throws `Error('submit: form_not_found ...')`.
- `scope.evaluate` returns `{ value: { ok: true, via: 'requestSubmit' } }` → no throw.
- `tc.action.input === undefined` (defensive) → `isStringKeyedRecord` rejects, fill loop skipped, submit still runs.

**`packages/cli/src/phases/execute.test.ts` — extend for Bug 2.**

Test `executeUiTestInner`'s state-establishment branch with a fake `TabScope` and a TestCase carrying `stateContext`:

- Render action with stateContext: `clickByHint(triggerHint)` is called once; settle of 250ms; then snapshot and post-action work.
- Navigate action with stateContext: `clickByHint` is **not** called (skip semantics).
- Submit action with stateContext + form fields: `clickByHint` called, then fill loop, then submit script.
- `clickByHint` returns `{clicked: false, reason: 'not_found'}` → returns `TestResult` with `infrastructureFailure.kind === 'browser_element_not_found'`, detail starts with `state-nav: trigger_not_found`.

### 7.2 Smoke gate (manual; @qa)

Re-run the TraiderJo smoke after both fixes land:

```bash
bughunter run --project /tmp/TraiderJo --max-runtime 600000
```

Expected:

- **Total infra failures < 10** (from 34 today). Most of the form-submit and state-nav noise should be eliminated.
- `summary.json.byKind` should show `>= 8` clusters (no regression from current 8) and ideally surface new clusters from state-page-internal elements that previously failed silently.
- Log file should contain at least one structured `scope.click(...)` for `[name="..."]` selectors (Bug 1 trace).
- Log file should contain at least one **`state-nav: trigger_not_found`** infra failure on a misconfigured trigger AT MOST — and ideally zero on TraiderJo's known-good triggers.

### 7.3 Lint + typecheck + build gates

Before commit:

```bash
npm run lint:fast        # fast eslint pass during dev
npm run lint              # full eslint, zero warnings
npx tsc --noEmit          # strict typecheck
npx vitest run packages/cli/src/mutation/apply.test.ts \
                packages/cli/src/phases/plan.test.ts \
                packages/cli/src/phases/execute.test.ts \
                packages/cli/src/phases/execute-form-submit.test.ts
npm run build             # esbuild bundle
```

All must pass with zero warnings and zero errors.

---

## 8. Negative requirements (consolidated)

Across both bugs:

- **No new emoji.** Anywhere.
- **No `as any`.** Use `unknown` and narrow with `isStringKeyedRecord` or equivalent.
- **No new HTTP client.** Reuse existing `BrowserMcpAdapter` / `SurfaceMcpAdapter`.
- **No new schema files.** Extend `types.ts` only.
- **No new logger.** Use `packages/cli/src/log.ts`.
- **No `console.log`.**
- **No silent `catch (e) {}`.** Every catch logs at `debug` minimum.
- **No new dependencies.**
- **Functions max 40 lines.** `runFormSubmit` and `buildSubmitScript` are extracted helpers; do not inline. The `case 'submit':` body must stay under 10 lines after the rewrite.
- **Files max 300 lines.** `execute.ts` is already over budget (~750 lines). Do NOT decompose it in this PR — that is a refactor. The new helpers (`runFormSubmit`, `buildSubmitScript`, `isStringKeyedRecord`, `cssEscape`) live at the bottom of `execute.ts`. If `execute.ts` crosses 850 lines, extract the form-submit helpers into a new `phases/form-submit-runner.ts` (sibling to existing helpers); but only if necessary.
- **No `submit_native`-only path.** All three submit fallbacks (button.click, requestSubmit, submit_native) ship in a single PR; do not gate `submit_native` behind a flag.
- **No new ActionKind, no new InfrastructureFailure.kind, no new BugKind.**
- **No changes to the action-log schema other than adding the optional `stateContext` mirror.** Replay command does not need to change.

---

## 9. Task breakdown

Six tasks. All on a single branch `feat/v09-form-and-state-nav`, single PR. T1 and T2 can land in parallel within the branch (no shared edits); T3 depends on T1 + T2 schemas; T4 depends on T1; T5 depends on T2; T6 is final smoke verification.

### Task T1 — `formTestCases` emits selector + threading param

**Assignee:** `@coder` · **Depends on:** none

**Files to modify:** `packages/cli/src/mutation/apply.ts`, `packages/cli/src/mutation/apply.test.ts`

**Files to create:** none

**Test:** `npx vitest run packages/cli/src/mutation/apply.test.ts`

**Done when:**
- `formTestCases` sets `action.selector = form.formSelector` for every palette.
- `xssFormTestCases` / `mintCanaryFormCase` set `action.selector = form.formSelector` for every canary case.
- Both factories accept an optional `stateContext` param and thread it onto `TestCase.stateContext`.
- New unit tests pass per §7.1.
- Lint + typecheck clean.

**DO NOT:** change `formSignature`, `buildFormInput`, palette logic, or any API-side factory.

### Task T2 — `TestCase.stateContext` + plan thread-through

**Assignee:** `@coder` · **Depends on:** T1 (only for the type/factory signatures it adds)

**Files to modify:** `packages/cli/src/types.ts`, `packages/cli/src/phases/plan.ts`, `packages/cli/src/phases/plan.test.ts` (extend or create)

**Files to create:** `packages/cli/src/phases/plan.test.ts` if it does not exist; otherwise extend.

**Test:** `npx vitest run packages/cli/src/phases/plan.test.ts`

**Done when:**
- `TestCase.stateContext` exists as an optional field per §5.
- `runPlan` derives `pageStateCtx` per page and passes it into all four UI test-case factories (`renderTestCase`, `navigateTestCase`, `clickTestCase`, `formTestCases`, `xssFormTestCases`).
- API factories (`apiTestCases`, `xssApiTestCases`) DO NOT receive `stateContext`.
- New unit tests pass per §7.1.
- Lint + typecheck clean.

**DO NOT:** modify `crawler.ts`, `DiscoveredPage`, or the form-collapse signature logic.

### Task T3 — `runFormSubmit` helper + execute submit case

**Assignee:** `@coder` · **Depends on:** T1, T2

**Files to modify:** `packages/cli/src/phases/execute.ts`

**Files to create:** `packages/cli/src/phases/execute-form-submit.test.ts`

**Test:** `npx vitest run packages/cli/src/phases/execute-form-submit.test.ts packages/cli/src/phases/execute.test.ts`

**Done when:**
- `executeUiTestInner` `case 'submit':` body matches §3.5 (calls `runFormSubmit`).
- `runFormSubmit`, `buildSubmitScript`, `isStringKeyedRecord`, `cssEscape` exist as top-level helpers in `execute.ts` (or sibling file if line budget exceeded — see §8).
- All §7.1 unit tests for `runFormSubmit` pass.
- Lint + typecheck clean.

**DO NOT:** introduce a new InfrastructureFailure kind. Existing throw → outer catch → infra failure path already covers form-not-found.

### Task T4 — execute pre-action state re-establishment

**Assignee:** `@coder` · **Depends on:** T2

**Files to modify:** `packages/cli/src/phases/execute.ts`, `packages/cli/src/phases/execute.test.ts` (extend)

**Files to create:** none

**Test:** `npx vitest run packages/cli/src/phases/execute.test.ts`

**Done when:**
- `executeUiTest` derives `pageUrl` from `tc.stateContext?.baseRoute ?? tc.page` per §4.4 Change C.
- `executeUiTestInner` runs `clickByHint(triggerHint)` after `preSnapshot` and `onPageBaseline`, before MutationObserver start, when `tc.stateContext !== undefined && tc.action.kind !== 'navigate'`.
- Settle delay 250ms hard-coded.
- Failure to click trigger returns infra failure with kind `browser_element_not_found` and detail `state-nav: trigger_not_found ...`.
- New unit tests pass per §7.1.
- Lint + typecheck clean.

**DO NOT:** plumb `crawl.stateSettleMs` into execute; do not modify `clickByHint`.

### Task T5 — Action-log carries stateContext (replay parity)

**Assignee:** `@coder` · **Depends on:** T2

**Files to modify:** `packages/cli/src/repro/action-log.ts` (only if it has a typed schema for the log object) and `packages/cli/src/phases/execute.ts` (where `actionLog` is constructed at line 649).

**Files to create:** none

**Test:** `npx vitest run packages/cli/src/repro` (existing tests must still pass) plus a new test asserting the action log object contains `stateContext` when set.

**Done when:**
- Action-log object carries `stateContext` (optional) when the test case has one.
- `writeActionLog` does not break on absence (back-compat).
- Lint + typecheck clean.

**DO NOT:** change the action-log file format on disk for tests without state context (unchanged path).

### Task T6 — Smoke verification on TraiderJo

**Assignee:** `@qa` · **Depends on:** T1–T5

**Test:**
1. Pull/build branch `feat/v09-form-and-state-nav`.
2. Reset `/tmp/TraiderJo` to clean state.
3. `bughunter run --project /tmp/TraiderJo --max-runtime 600000`.
4. Inspect `summary.json` and `state.json`.

**Done when:**
- `summary.json` infra failure count `< 10` (was 34).
- Zero infra failures with detail `Browser action failed: Error: execute: submit action missing selector`.
- Zero infra failures with detail starting `state-nav: trigger_not_found` for known-good TraiderJo navbar triggers.
- Cluster count `>= 8` (no regression).
- Action logs for at least one state-page form submit show: navigate to baseRoute → clickByHint → multiple type calls → submit-evaluate.

---

## 10. Acceptance criteria

| # | Criterion | Verifier |
|---|---|---|
| A1 | Zero `submit action missing selector` infra failures on TraiderJo. | @qa greps log + summary. |
| A2 | Zero unintended `state-nav: trigger_not_found` infra failures on TraiderJo (i.e. no false positives — known-good triggers all click). | @qa greps log. |
| A3 | TraiderJo smoke total infra failures `< 10` (was 34). | @qa reads `summary.json`. |
| A4 | `state.json.testCases[i].stateContext` is populated for every test case derived from a `kind: 'state'` page. | @qa reads `state.json`. |
| A5 | Per-state-page form smoke: at least one form-submit test case successfully fills 14+ fields and clicks submit on `/?setTab=profile`. | @qa reads action log for a profile-form test case. |
| A6 | Existing TraiderJo cluster count does not regress. | @qa diffs `summary.json.byKind` vs. baseline run. |
| A7 | All unit tests in §7.1 pass. | CI. |
| A8 | `npm run lint` zero warnings. | CI. |
| A9 | `npx tsc --noEmit` zero errors. | CI. |
| A10 | `npm run build` succeeds. | CI. |

---

## 11. Killer-demo runbook

Re-run TraiderJo after the PR lands. Steps:

1. `cd /root/BugHunter && git checkout feat/v09-form-and-state-nav && npm run build`.
2. Ensure SurfaceMCP is running on port 3105 with `surface_list_navigations` populated for TraiderJo (depends on PR #18 already merged).
3. Ensure camofox is running (`pgrep -x camofox` non-empty; default port 3100).
4. `cd /tmp/TraiderJo && pnpm dev` (in a separate shell; serves on `http://127.0.0.1:8787`).
5. From `/root/BugHunter`: `bughunter run --project /tmp/TraiderJo --max-runtime 600000 2>&1 | tee /tmp/v09-smoke.log`.
6. After the run completes, inspect:
   - `cat /tmp/TraiderJo/.bughunter/runs/<runId>/summary.json | jq '{bugs_filed, byKind, infraFailureCount: .infraFailureCount}'`.
   - `cat /tmp/TraiderJo/.bughunter/runs/<runId>/state.json | jq '.testCases | map(select(.stateContext != null)) | length'` — should be `> 0`.
   - `grep -c "submit action missing selector" /tmp/v09-smoke.log` — should be `0`.
   - `grep -c "state-nav: trigger_not_found" /tmp/v09-smoke.log` — should be ≤ a small known-bad-trigger count (ideally 0 on TraiderJo).
7. Diff against the baseline `mxbzhc08wag7m3riowd7ddzs` summary. Expectation: clusters preserved or grew (state-page-internal elements newly testable); infra failures dropped from 34 to under 10.
8. PR description quotes:
   - The action-log JSON for one profile-form submit (showing fill+submit sequence).
   - The infra-failure delta line: "v0.9 smoke: 8 clusters / N infra failures (was 8 / 34)".

If A3 (infra `< 10`) is missed, the remaining infra failures are NOT this PR's regressions — they reflect either further consumer-side bugs or genuine product flakiness and are spec'd in a follow-up.

---

## 12. Open questions

None. Both bugs have a chosen design (Option 1 for each) with rationale and code surface. Ship.
