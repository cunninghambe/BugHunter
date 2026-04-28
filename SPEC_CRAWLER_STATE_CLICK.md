# SPEC: `clickByHint` adapter method for state-nav clicks via evaluate

Status: draft (not yet implemented)
Owner: @architect
Implementer: @coder
Branch: `spec/crawler-state-click` (this spec only); implementation lands on a separate branch.

---

## 1. Problem

After `SPEC_PAGE_KIND_FIX` and `SPEC_CRAWLER_STATE_FIX` landed, the crawler correctly receives `kind:'state'` navigations from SurfaceMCP and tries to click their triggers — but **every state-nav click fails** with
`BrowserMcpError('element_not_found'): No matching ref in snapshot or DOM`. This is the last blocker preventing the killer demo (vision baseline screenshots across more than the seed page).

### Live evidence (TraiderJo, SurfaceMCP @ `:3105`, run 2026-04-27)

`surface_list_navigations` returns `47` navigations with `32` of `kind:'state'`. Hint shape distribution from a live `tools/call`:

| Hint shape         | Count |
| ------------------ | :---: |
| `{ text }` only    |  30   |
| `{ ariaLabel }`    |   1   |
| `{}` (empty)       |   1   |

Sample (verbatim from server):

```json
{"hint": {"text": "Leaderboard"},      "target": "leaderboard", "stateVar": "activeTab"}
{"hint": {"text": "Community Insights"}, "target": "insights",   "stateVar": "activeTab"}
{"hint": {"text": "monthly"},          "target": "monthday",    "stateVar": "hmDim"}
{"hint": {"text": "hour"},             "target": "hour",        "stateVar": "hmDim"}
{"hint": {"text": "need an account? register"}, "target": "register", "stateVar": "mode"}
```

Crawler telemetry observed: 32 state-nav items enqueued, 32 `walk_failed: BrowserMcpError ... element_not_found` skips, 0 state pages produced, vision baseline runs on **1** unique page (the seed `/`).

### Root cause (file:line)

`packages/cli/src/discovery/trigger-resolve.ts:44–47` — for a text-only hint, `resolveTriggerSelector` returns `:has-text("…")` with **no leading tag**:

```ts
if (hint.text !== undefined && hint.text !== '') {
  return `:has-text("${escapeAttr(hint.text)}")`;
}
```

`packages/cli/src/adapters/browser-mcp-snapshot.ts:107–115` — `parsePlaywrightHasText` requires a tag prefix:

```ts
const dq = /^(\w+):has-text\("([^"]+)"\)$/.exec(selector);  // tag-prefixed only
```

So `:has-text("Leaderboard")` falls through the snapshot resolver and is passed to `CamofoxBrowserMcpAdapter.resolveViaEvaluate` (`packages/cli/src/adapters/browser-mcp.ts:190–219`), which runs:

```js
document.querySelector(':has-text("Leaderboard")')
```

That selector is **invalid CSS** in real browsers — `querySelector` throws `SyntaxError`. The adapter catches the throw and re-raises as `BrowserMcpError('element_not_found', 'No matching ref in snapshot or DOM', selector)`. Crawler logs `walk_failed: …` and continues. All 32 state-nav clicks fail this way.

This is the **same shape of bug** we fixed for `browser-login.ts` (see `SPEC_BROWSER_LOGIN_HAS_TEXT.md`): `:has-text(...)` is not understandable by the camofox adapter, so we routed login-modal clicks through a hand-written `browser.evaluate(...)` DOM walk that dispatches a synthetic `MouseEvent('click', { bubbles: true, … })`. The login flow got that escape hatch; the crawler's state-nav click path did not. That is the gap this spec closes.

---

## 2. Investigation findings (file:line citations)

### 2.1 Crawler state-nav click site

`packages/cli/src/discovery/crawler.ts:206–296` handles `kind:'state'` queue items. The relevant click block is **lines 270–290**:

```ts
} else {
  // State navigation: navigate to base if needed, then click the trigger
  const evalResult = await browser.evaluate('location.pathname');
  const currentPath = evalResult.value as string;
  if (currentPath !== item.baseRoute) {
    await browser.navigate(opts.baseUrl + item.baseRoute, opts.extraHeaders);
    currentPageUrl = opts.baseUrl + item.baseRoute;
  }

  const selector = await resolveTriggerSelector(browser, item.trigger);
  if (selector === null || selector === '') {
    skipped.push({ url: key, reason: 'trigger_not_found' });
    visited.delete(key);
    continue;
  }

  await browser.click(selector);              // ← FAILS for text-only hints
  await new Promise<void>(r => { setTimeout(r, opts.stateSettleMs ?? 250); });
  walkResult = await collectDomOnly(browser);
  stateKindVisited++;
}
```

`browser.click(selector)` is the failure point. `selector` is whatever string `resolveTriggerSelector` returned — for 30/32 live hints, that string is `:has-text("…")` with no tag prefix.

### 2.2 `trigger-resolve.ts` resolves to a string, does not click

`packages/cli/src/discovery/trigger-resolve.ts` exports `resolveTriggerSelector(browser, hint): Promise<string | null>`. It only **probes** with `document.querySelector(JSON.stringify(sel))` to verify presence; it never clicks. The output is consumed by the caller (here, `crawler.ts:286 browser.click(selector)`).

Priority chain (lines 30–50):
1. `[data-testid="…"]` — verified via `selectorExists`
2. `[aria-label="…"]` — verified via `selectorExists`
3. `:has-text("…")` — **returned without verification**, with no tag prefix

The `:has-text(…)` form is a Playwright-only extension; the camofox adapter's snapshot resolver only recognizes it **with a tag prefix** (`button:has-text(…)`, `a:has-text(…)`). The bare form fails everywhere downstream.

### 2.3 Adapter behaviour for unparseable selectors

`packages/cli/src/adapters/browser-mcp.ts:174–219` (`resolveRef` / `resolveViaEvaluate`):

1. `snapshot()` + `resolveSelectorInSnapshot(selector, nodes)` — returns `null` for bare `:has-text(…)`.
2. Falls through to `resolveViaEvaluate(tabId, selector, nodes)` which runs `document.querySelector('${safeSelector}')?.outerHTML…` against the live page.
3. `querySelector(':has-text("…")')` throws `DOMException: invalid selector` in real Chrome/Firefox; the camofox MCP daemon returns an evaluate error.
4. The adapter catches and re-throws `BrowserMcpError('element_not_found', 'No matching ref in snapshot or DOM', selector)`.

So the symptom matches the live log byte-for-byte.

### 2.4 The proven dispatch pattern (already in `browser-login.ts`)

`packages/cli/src/discovery/browser-login.ts:81–134` defines two helpers used by `loginViaModalEvaluate`:

- `tryClickByText(browser, tag, text)` (lines 81–111) — picks visible elements of `tag`, prefers exact-trim match, falls back to substring, dispatches `MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 })`. **Returns boolean**, never throws on miss.
- `tryClickByCssSelector(browser, cssSelector)` (lines 117–134) — `document.querySelector(...)` + same `MouseEvent` dispatch.

Both are **module-private**, declared `async function` (not exported). They are exactly the primitive the crawler needs but live in the wrong file. This spec extracts the pattern to the adapter so both call sites (login + crawler) can share it.

Why `MouseEvent` dispatch and not `el.click()`: React's synthetic-event system listens at the document root for native bubbling events; `el.click()` synthesizes a click that React **does** see, but `dispatchEvent(new MouseEvent('click', { bubbles: true }))` is the form already proven in production for TraiderJo's auth modal. We copy the exact pattern — no inventing.

### 2.5 Live data — what hints actually look like

(Same source as §1.) The shapes are dominated by `{ text }`-only — i.e. the exact case that `trigger-resolve.ts` currently handles by returning the bare `:has-text(...)` form that the adapter cannot consume. Fixing this case fixes the demo.

---

## 3. Design — Option B: `clickByHint` on the adapter

### 3.1 Rationale (Options considered)

**Option A (rejected).** Add `clickViaEvaluate(browser, hint)` to `trigger-resolve.ts`. Pros: contained to the discovery module. Cons: leaks adapter-shaped logic (DOM-walk dispatch JS) into a "resolution" module whose purpose is to **return a string**; couples crawler to evaluate-script authoring; can't be reused by the login flow.

**Option B (chosen).** Add `clickByHint(hint: TriggerSelectorHint): Promise<ClickResult>` to `BrowserMcpAdapter` (interface + `CamofoxBrowserMcpAdapter` implementation). The adapter is the right home: it already owns all browser-side dispatch, all evaluate-script authoring, and all error mapping. The crawler becomes a thin caller; the login flow can collapse onto the same primitive in a future PR.

**Option C (rejected).** Tag the bare `:has-text(...)` with a default tag (e.g. `*:has-text(...)`). Pros: minimal patch. Cons: `*:has-text(...)` is still invalid CSS in browsers; the snapshot resolver still doesn't recognize multi-element `*` matching; doesn't generalise to `text` matching across `<button>`, `<a>`, `<[role=button]>`. We would re-invent a half-working subset of what `tryClickByText` already does.

### 3.2 Public interface (additive, backward-compatible)

Add to `packages/cli/src/adapters/browser-mcp.ts`:

```ts
export type ClickByHintResult =
  | { clicked: true; matchedBy: 'testId' | 'ariaLabel' | 'text' }
  | { clicked: false; reason: 'no_hint_fields' | 'not_found' };

export interface BrowserMcpAdapter {
  // ... existing members unchanged ...

  /**
   * Click an element identified by a TriggerSelectorHint via browser.evaluate.
   * Hint priority: testId → ariaLabel → text. For each populated field, walks
   * the live DOM and dispatches a synthetic MouseEvent('click', {bubbles:true,
   * cancelable:true, view:window, button:0}) on the first visible match.
   *
   * Returns `{clicked:true, matchedBy}` on success or `{clicked:false, reason}`
   * when no hint field is set or no element matched any populated field.
   * Never throws BrowserMcpError; transport errors propagate unchanged.
   *
   * Backward compat: this is additive. Existing callers of `click(selector)`
   * are unchanged. The snapshot/ref pipeline is NOT used.
   */
  clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult>;
}
```

`TriggerSelectorHint` is imported from `../types.js` (already declared at `packages/cli/src/types.ts:244–248`).

Also add to `TabScope` (`browser-mcp.ts:56–65`) so `withTab(...)`-scoped callers can use it. Same signature.

### 3.3 Implementation sketch (illustrative; @coder will write the final code)

```ts
async clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult> {
  const tabId = this.requireTab();

  if (hint.testId !== undefined && hint.testId !== '') {
    if (await this.evaluateClickByCss(tabId, `[data-testid="${escapeAttr(hint.testId)}"]`)) {
      return { clicked: true, matchedBy: 'testId' };
    }
  }
  if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') {
    if (await this.evaluateClickByCss(tabId, `[aria-label="${escapeAttr(hint.ariaLabel)}"]`)) {
      return { clicked: true, matchedBy: 'ariaLabel' };
    }
  }
  if (hint.text !== undefined && hint.text !== '') {
    if (await this.evaluateClickByText(tabId, hint.text)) {
      return { clicked: true, matchedBy: 'text' };
    }
  }

  const populated =
    (hint.testId !== undefined && hint.testId !== '') ||
    (hint.ariaLabel !== undefined && hint.ariaLabel !== '') ||
    (hint.text !== undefined && hint.text !== '');
  return { clicked: false, reason: populated ? 'not_found' : 'no_hint_fields' };
}
```

`evaluateClickByCss(tabId, css)` and `evaluateClickByText(tabId, text)` are private adapter methods that call `mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression })` with the dispatch scripts shown below. They each return `Promise<boolean>` (true = matched and dispatched; false = no match).

### 3.4 Evaluate scripts (copy semantics from `browser-login.ts`)

**By CSS** (testId / ariaLabel branch):

```js
(function () {
  var el = document.querySelector(<JSON.stringify(css)>);
  if (!el) return false;
  var r = el.getBoundingClientRect();
  if (el.offsetParent === null && (r.width === 0 || r.height === 0)) return false;
  el.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, view: window, button: 0,
  }));
  return true;
})()
```

**By text** — walk `<button>`, `<a>`, `<[role=button]>`, `<[role=tab]>`, `<[role=link]>`:

```js
(function () {
  var text = <JSON.stringify(text.toLowerCase())>;
  var sel = 'button, a, [role="button"], [role="tab"], [role="link"]';
  var els = Array.from(document.querySelectorAll(sel));
  function visible(el) {
    var r = el.getBoundingClientRect();
    return el.offsetParent !== null || (r.width > 0 && r.height > 0);
  }
  var candidates = els.filter(visible);
  // Prefer exact trim match, fall back to substring (case-insensitive)
  var target =
    candidates.find(function (el) {
      return (el.textContent || '').trim().toLowerCase() === text;
    }) ||
    candidates.find(function (el) {
      return (el.textContent || '').toLowerCase().includes(text);
    });
  if (!target) return false;
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, view: window, button: 0,
  }));
  return true;
})()
```

`escapeAttr` already exists in `trigger-resolve.ts:11–13` — extract it to a small shared helper file (`packages/cli/src/adapters/browser-mcp-evaluate-helpers.ts`) **only if** more than one adapter method needs it; otherwise inline a private `escapeAttr` in `browser-mcp.ts`. (Coder's call; either is fine — do not add a new file just for this.)

**Differences from `browser-login.ts:tryClickByText`:**
- The login version takes a single `tag` argument; here we widen the candidate set to `button, a, [role="button"], [role="tab"], [role="link"]` because state-nav triggers in the wild are routinely `<a>`, `<div role="button">`, or `<[role="tab"]>` (e.g. TraiderJo `Leaderboard` is rendered as a styled `<div>` with `role="tab"` per the SurfaceMCP docs). The widened set is a strict superset of what login needed; a future refactor can collapse the login helper onto this method.
- Visibility check is unchanged.
- MouseEvent payload is **identical** (verbatim): `{bubbles:true, cancelable:true, view:window, button:0}`.

### 3.5 Crawler integration

In `packages/cli/src/discovery/crawler.ts`, replace lines **279–286** (the `resolveTriggerSelector` + `browser.click` block):

```ts
// BEFORE
const selector = await resolveTriggerSelector(browser, item.trigger);
if (selector === null || selector === '') {
  skipped.push({ url: key, reason: 'trigger_not_found' });
  visited.delete(key);
  continue;
}
await browser.click(selector);
```

with:

```ts
// AFTER
const clickRes = await browser.clickByHint(item.trigger);
if (!clickRes.clicked) {
  skipped.push({ url: key, reason: 'trigger_not_found' });
  visited.delete(key);
  continue;
}
```

The `resolveTriggerSelector` import is no longer used in `crawler.ts` after this change. **Do not delete `trigger-resolve.ts`** — its `selectorExists`/`resolveTriggerSelector` may still be useful for non-click probes; leaving it intact also keeps the diff small and the existing unit tests passing. Mark it `@deprecated` in a JSDoc block at the top of the file, with a one-line note pointing to `BrowserMcpAdapter.clickByHint` for click flows. (Optional follow-up: a separate cleanup PR can remove the file.)

### 3.6 Out of scope

- `browser-login.ts` is **not** changed by this spec. It already works for its case via `loginViaModalEvaluate`. A follow-up may collapse `tryClickByText` onto `clickByHint`, but not here — keep the diff bounded.
- `browser.click(selector)` itself is **not** changed. Existing snapshot/ref-based callers (form submission, replay, execute phase) keep their current behaviour. The new method is purely additive.
- No new dependencies. Uses existing `browser.evaluate`.
- No changes to `surface_list_navigations`. Hint shape is treated as the stable input contract.

---

## 4. Reuse from `browser-login.ts`

The dispatch pattern is already proven in production via `loginViaModalEvaluate`. This spec **copies the semantics** of the JS payloads in `browser-login.ts:86–134` (`tryClickByText`, `tryClickByCssSelector`) with three deltas:

1. Widen the candidate tag set from `tag`-parameterised to a fixed `'button, a, [role="button"], [role="tab"], [role="link"]'` (state-nav triggers are heterogeneous in real apps).
2. Lift the helpers from a discovery-internal pair of `async function`s into a **public adapter method** so both call sites can share it.
3. Return a **discriminated-union** `ClickByHintResult` instead of `boolean` so the crawler can log a precise `matchedBy` and the future caller can distinguish "no hint" from "not found".

The MouseEvent payload (`{bubbles:true, cancelable:true, view:window, button:0}`), the visibility check, and the exact-match-then-substring preference are unchanged from `browser-login.ts`. Do not invent a different payload or order.

---

## 5. Test plan

### 5.1 Unit — `packages/cli/src/adapters/browser-mcp.test.ts` (new file or extend existing)

Mock the JSON-RPC transport (mock `mcpCall` via a private accessor or by mocking `fetch`). Cover the following cases. Each test asserts the **exact `expression`** sent to the `evaluate` tool when relevant.

| # | Scenario                                                          | Hint                              | Mock evaluate returns | Expected result                       |
|---|-------------------------------------------------------------------|-----------------------------------|-----------------------|---------------------------------------|
| 1 | testId hits                                                        | `{ testId: 'nav-x' }`             | `true` for testId script | `{clicked:true, matchedBy:'testId'}`  |
| 2 | ariaLabel hits when testId absent                                  | `{ ariaLabel: 'Go home' }`        | `true` for aria script   | `{clicked:true, matchedBy:'ariaLabel'}` |
| 3 | text hits when testId+aria absent                                  | `{ text: 'Leaderboard' }`         | `true` for text script   | `{clicked:true, matchedBy:'text'}`    |
| 4 | testId provided + DOM has no testid → falls through to ariaLabel   | `{ testId: 'x', ariaLabel: 'Y' }` | testId→`false`, aria→`true` | `{clicked:true, matchedBy:'ariaLabel'}` |
| 5 | testId+ariaLabel both miss → falls through to text                 | `{ testId: 'x', ariaLabel: 'Y', text: 'Z' }` | first two→`false`, text→`true` | `{clicked:true, matchedBy:'text'}` |
| 6 | All hint fields populated but DOM matches none                     | `{ testId: 'x', ariaLabel: 'Y', text: 'Z' }` | all→`false`              | `{clicked:false, reason:'not_found'}` |
| 7 | Empty hint                                                         | `{}`                              | (not called)             | `{clicked:false, reason:'no_hint_fields'}` |
| 8 | All hint fields are empty strings                                  | `{ testId:'', ariaLabel:'', text:'' }` | (not called)         | `{clicked:false, reason:'no_hint_fields'}` |
| 9 | Double-quote escaping in testId is preserved in the evaluate script | `{ testId: 'say-"hi"' }`         | matches escaped expr     | clicked, expression contains `\"hi\"` |
| 10 | Text is lowercased in script payload (case-insensitive walk)      | `{ text: 'HOUR' }`                | matches lowercased       | clicked; assert script contains `"hour"` |
| 11 | No active tab → throws `BrowserMcpError('no_tab')`                 | `{ text: 'X' }`                   | (not reached)            | `requireTab()` throws                  |

Coverage gates: 100% line coverage on `clickByHint` and the two private evaluate helpers.

### 5.2 Integration — `packages/cli/src/discovery/crawler.test.ts`

Modify `makeMockBrowser` and the existing C5–C9 / tab-state-only integration tests so the mock browser exposes `clickByHint`. The test mock should:

- Return `{clicked:true, matchedBy:'testId'}` when the testId is in a fake "DOM presence" map (analogous to `selectorPresent` in C5–C9).
- Return `{clicked:true, matchedBy:'text'}` when text is in a `textPresent` set.
- Return `{clicked:false, reason:'not_found'}` otherwise.

Cases to update / add:

- **C5 (testid-priority):** assert `clickByHint` was called with `{ testId: 'nav-x', text: 'X label' }`, exactly once, and that one state page is produced.
- **C6 (aria-label fallback):** assert `clickByHint` called with `{ ariaLabel: 'X label', text: 'X' }`; state page produced.
- **C7 (text-fallback):** assert `clickByHint` called with `{ text: 'X label' }`; state page produced. **Critically: assert `browser.click` was NOT called for this state nav** — this is the regression we're fixing.
- **C8 (none):** empty hint → `trigger_not_found` skip remains in `result.skipped`; no state page.
- **C9 (testId absent in DOM):** falls through to text — `clickByHint` returns `matchedBy:'text'`; state page produced.
- **New C9b — `not_found` after all priorities miss:** hint `{text:'Z'}`, mock returns `{clicked:false, reason:'not_found'}` → `trigger_not_found` skip, no state page.
- **Tab-state-only integration test (lines 855–909):** seed + 3 state navs `{text:'Dashboard'}, {text:'Trades'}, {testId:'nav-settings'}` → 4 DiscoveredPages, 3 state pages, `clickByHint` called 3 times. The current test calls `clickMock` 3 times via `browser.click`; rewrite to assert `clickByHint` 3 times and `click` 0 times.

### 5.3 Live target — TraiderJo smoke

Run a discover phase against TraiderJo (SurfaceMCP `:3105`, camofox `:3104`) with the `:has-text()` modal-login fix already applied. Assertions:

- Discover-phase log contains at least 6 lines of the form `crawl: visiting N/M depth=0 queue=… /#state=activeTab=leaderboard` (and similar for the other 5 main tabs: `insights`, `feeMode={fixed,manual,percent}`, `hmDim={hour,monthday}`).
- `result.pages.filter(p => p.kind === 'state').length >= 6`.
- Vision-baseline screenshot artefacts `*.png` count > 1 (i.e. more than just the seed).
- `result.skipped.filter(s => s.reason === 'trigger_not_found').length` is reduced from current 32 to a number < 5 (allowing for a small set of triggers genuinely hidden behind closed modals/menus — see §7).

---

## 6. Live target — TraiderJo smoke produces N+1 distinct screenshots

**Concrete acceptance:** The vision baseline run on TraiderJo produces **at least 7 distinct screenshot files** (1 seed + 6 main-tab state pages). Each filename embeds the synthetic state route (e.g. `_state_activeTab_leaderboard.png`). Before this fix: 1 file (seed only). After: ≥7.

The minimum 6 main-tab state pages used as the floor:
1. `activeTab=insights` (text: "Community Insights")
2. `activeTab=leaderboard` (text: "Leaderboard")
3. `feeMode=fixed` (text: "fixed")
4. `feeMode=manual` (text: "manual")
5. `feeMode=percent` (text: "percent")
6. `hmDim=hour` (text: "hour")

These are all `text`-only hints in the live response — i.e. the case the fix specifically addresses.

---

## 7. Risk

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **R1.** Some state-nav triggers are rendered only after another UI surface is opened (e.g. `feeMode=*` triggers may live inside a popover that requires a parent click first). `clickByHint` will return `not_found` for those — same outcome as today, but with cleaner telemetry. | Medium | Acceptable for v1. The 6-page floor in §6 is selected from triggers that are rendered eagerly. Triggers behind closed modals are out of scope for the demo; track in follow-up. |
| **R2.** Substring text-match collides with multiple visible elements (e.g. text `"add"` appears in many places). The walk picks the first visible match in document order, which may not be the intended trigger; could click a wrong button and corrupt page state. | Medium | Mitigation already in dispatch script: prefer **exact trim equality** before falling back to substring. Surfaces that ship ambiguous text-only hints should add `testId` or `ariaLabel`; this is an authoring problem on the surface side, not a crawler bug. Telemetry: log `matchedBy:'text'` so we can flag surfaces that rely on ambiguous text. |
| **R3.** A click on the wrong element navigates away from the SPA's base route, leaving subsequent state-nav clicks targeting an unrelated page. | Low–Medium | Crawler already navigates back to `item.baseRoute` at lines 272–277 if `location.pathname !== item.baseRoute`. This catches accidental URL navigations. SPA in-place state changes are by design and harmless. |
| **R4.** `MouseEvent` dispatch fires React handlers but does **not** trigger native browser side-effects (e.g. focus changes, form submit). | Low | `clickByHint` is only used for state-setter triggers (per crawler `kind:'state'` items). Form submission still uses the existing snapshot-ref `click(selector)` path, which goes through camofox's native click. |
| **R5.** The candidate selector list (`button, a, [role="button"], [role="tab"], [role="link"]`) misses an exotic trigger (e.g. `<li onclick>`). | Low | Discovered TraiderJo triggers are all in the candidate set. If a future surface needs broader selectors, widen this list — file:line is contained. |
| **R6.** Visibility check rejects a trigger that is technically rendered but off-screen (e.g. requires scrolling). | Low | `el.offsetParent !== null || (r.width>0 && r.height>0)` matches the proven login-flow check. Off-screen triggers are extremely rare for navigation surfaces. |

---

## 8. Acceptance criteria

All of the following must hold for the PR implementing this spec to be accepted:

1. `BrowserMcpAdapter.clickByHint(hint)` is added to the interface, `CamofoxBrowserMcpAdapter`, and `TabScope`. Signature matches §3.2.
2. `crawler.ts:279–286` is replaced per §3.5; `resolveTriggerSelector` import is removed from `crawler.ts`. `trigger-resolve.ts` itself is preserved (no file deletion in this PR).
3. All 11 unit tests in §5.1 pass.
4. All updated integration tests in §5.2 pass (every existing `crawler.test.ts` case continues to pass; the rewritten C5–C9, C9b, and tab-state-only cases assert `clickByHint` instead of `click`).
5. `npx tsc --noEmit` and `npx eslint . --max-warnings 0` pass with zero errors and zero warnings across `packages/cli/`.
6. **Live target (concrete, observable):** running discover against TraiderJo, `result.pages.filter(p => p.kind === 'state').length >= 6` and the vision-baseline output directory contains ≥ 7 PNG artefacts. The 32 → 0 jump in `walk_failed: ... element_not_found` for state items is the headline metric.
7. No new dependency added. No new file added (helper extraction optional and only if it serves more than one method). No `:has-text(...)` strings produced anywhere in the crawler path.
8. Backward compat: existing call sites (`browser-login.ts`, replay, execute, dom-walker form-fills) work unchanged. `browser.click(selector)` semantics are unchanged.

---

## 9. Files to touch

### Modify

- `packages/cli/src/adapters/browser-mcp.ts`
  - Add `ClickByHintResult` type export.
  - Add `clickByHint` to the `BrowserMcpAdapter` interface and to `TabScope`.
  - Implement `clickByHint`, `evaluateClickByCss`, `evaluateClickByText` (private helpers) on `CamofoxBrowserMcpAdapter`.
  - Wire `clickByHint` into `makeTabScope`.
  - Import `TriggerSelectorHint` from `../types.js`.

- `packages/cli/src/discovery/crawler.ts`
  - Remove `resolveTriggerSelector` import.
  - Replace lines 279–286 per §3.5.
  - No other behavioural change.

- `packages/cli/src/discovery/trigger-resolve.ts`
  - Add a top-of-file `@deprecated` JSDoc note pointing readers to `BrowserMcpAdapter.clickByHint`. **Do not delete the file.**

- `packages/cli/src/discovery/crawler.test.ts`
  - Update `makeMockBrowser` and trigger-resolution test mocks to expose `clickByHint`.
  - Rewrite C5–C9 and the tab-state-only integration test to assert `clickByHint` instead of `click`. Add C9b (`not_found` after all priorities miss).

### Add

- (Optional, only if extracted) `packages/cli/src/adapters/browser-mcp-evaluate-helpers.ts` containing `escapeAttr`. Skip if `escapeAttr` is inlined privately in `browser-mcp.ts`.
- New test cases listed in §5.1 — add to existing `packages/cli/src/adapters/browser-mcp.test.ts` if it exists; otherwise create that file.

### Do **NOT** touch

- `packages/cli/src/discovery/browser-login.ts` — out of scope; `loginViaModalEvaluate` keeps its private helpers for now.
- `packages/cli/src/adapters/browser-mcp-snapshot.ts` — `parsePlaywrightHasText` and the snapshot resolver remain unchanged.
- `packages/mcp/**` (SurfaceMCP) — hint shape contract is treated as stable input.

---

## 10. Open questions

1. Should `clickByHint` accept an optional `candidateSelectors` parameter to let callers widen/narrow the text-walk tag set per call? **Tentative answer: no for v1** — fixed list keeps the surface area small and matches the demo. Revisit if a future surface needs different selectors.

2. Should the result include the matched element's accessible name (for telemetry / debugging)? **Tentative answer: no for v1** — the round-trip cost of an extra evaluate call is non-trivial; logs at the crawler level (`matchedBy`) are enough. Revisit if debugging becomes painful.

3. Should `clickByHint` retry once on `not_found` after a short settle delay (similar to the snapshot-click retry at `browser-mcp.ts:248–256`)? **Tentative answer: no** — the crawler already navigates to base route + waits before clicking, and dynamic-render races for state triggers were not observed in the live data. Add only if R3 telemetry shows real misses on first try.
