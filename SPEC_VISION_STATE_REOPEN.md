# SPEC: Extend `clickByHint` to vision-baseline state-page reopen

**Status:** ready for @coder
**Scope:** small fix, single file, ~10–20 LOC + test update
**Depends on:** PR #19 (`clickByHint` on `BrowserMcpAdapter`/`TabScope`) — already merged

---

## 1. Problem

The crawler now reaches `kind: 'state'` pages reliably via `clickByHint(hint)` (see `crawler.ts:278`). But the **vision-baseline phase** in `discover.ts` still uses the old `resolveTriggerSelector(scope, hint)` → `scope.click(selector)` flow when reopening state pages for screenshots. That flow is the same one that previously failed for the crawler before PR #19 — snapshot-ref selector resolution is unreliable on tab-state widgets, so most state pages cannot be reopened for the vision pass.

### Live evidence (TraiderJo run, 2026-04-28)

- Crawl phase: **15 pages discovered**, including **10 `kind: 'state'`** pages (the 6 main tabs + nested state).
- Vision baseline: ran on only **3 unique pages** (the URL-routed seed plus 2 it could redrive).
- Net effect: visual_anomaly cluster coverage is hidden behind ~80% of the app.

The fix is the same one that worked for the crawler: drop the snapshot-ref selector and call `scope.clickByHint(triggerHint)` directly.

---

## 2. Investigation findings (file:line)

### 2.1 Vision baseline — current (broken) state-reopen path

`packages/cli/src/phases/discover.ts:264–272`

```ts
if (page.kind === 'state' && page.stateContext !== undefined) {
  const ctx = page.stateContext;
  await browser.withTab(`${baseUrl}${ctx.baseRoute}`, undefined, async scope => {
    const sel = await resolveTriggerSelector(scope, ctx.triggerHint);
    if (sel === null || sel === '') throw new Error('trigger_not_found_in_vision');
    await scope.click(sel);
    await new Promise<void>(r => { setTimeout(r, VISION_BASELINE_SETTLE_MS); });
    await scope.screenshot(screenshotPath);
  });
} else {
  await browser.withTab(`${baseUrl}${page.route}`, undefined, async scope => {
    await new Promise<void>(r => { setTimeout(r, VISION_BASELINE_SETTLE_MS); });
    await scope.screenshot(screenshotPath);
  });
}
```

This is the **only** state-reopen path in the vision-baseline phase. `resolveTriggerSelector` + `scope.click(sel)` is what we are replacing.

### 2.2 Crawler — proven (working) state-click path

`packages/cli/src/discovery/crawler.ts:269–286` (excerpt)

```ts
// State navigation: navigate to base if needed, then click the trigger
const evalResult = await browser.evaluate('location.pathname');
const currentPath = evalResult.value as string;
if (currentPath !== item.baseRoute) {
  await browser.navigate(opts.baseUrl + item.baseRoute, opts.extraHeaders);
  currentPageUrl = opts.baseUrl + item.baseRoute;
}

const clickRes = await browser.clickByHint(item.trigger);
if (!clickRes.clicked) {
  skipped.push({ url: key, reason: 'trigger_not_found' });
  visited.delete(key);
  continue;
}
await new Promise<void>(r => { setTimeout(r, opts.stateSettleMs ?? 250); });
walkResult = await collectDomOnly(browser);
```

Note: the crawler uses the **default-tab** `browser.clickByHint`. The vision-baseline phase uses `withTab(...)` for tab isolation, so it must call `scope.clickByHint(hint)` (also exposed — `browser-mcp.ts:70` on the `TabScope` type, wired at `browser-mcp.ts:470`).

### 2.3 `DiscoveredPage.stateContext.triggerHint` — confirmed present

`packages/cli/src/types.ts:250–267`

```ts
export type DiscoveredPage = {
  route: string;
  ...
  kind?: 'url' | 'state';
  stateContext?: {
    baseRoute: string;
    stateVar: string;
    stateValue: string;
    triggerHint: TriggerSelectorHint;   // ← already on the type
  };
  navSource?: NavSource;
};
```

Built by the crawler at `crawler.ts:121–138` (`buildStatePage`). All state-kind pages produced by the crawler carry a populated `triggerHint`. No type changes needed.

### 2.4 `TabScope.clickByHint` — already exists

`packages/cli/src/adapters/browser-mcp.ts:70`

```ts
clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult>;
```

Wired to `clickByHintForTab(tabId, hint)` at `browser-mcp.ts:470`. Returns the same `ClickByHintResult` discriminated union as `BrowserMcpAdapter.clickByHint`. Identical semantics, just tab-scoped — exactly what the vision phase needs because it runs inside `withTab(...)`.

---

## 3. Fix design

Replace the 4-line `resolveTriggerSelector` + `scope.click(sel)` block with a single `scope.clickByHint(triggerHint)` call that mirrors the crawler. Treat `clicked: false` the same as a missing trigger today (throw to enter the existing `catch` so the page is logged + skipped, not silently screenshotted in the wrong state).

### 3.1 New code (target shape — `discover.ts:264–272`)

```ts
if (page.kind === 'state' && page.stateContext !== undefined) {
  const ctx = page.stateContext;
  await browser.withTab(`${baseUrl}${ctx.baseRoute}`, undefined, async scope => {
    const clickRes = await scope.clickByHint(ctx.triggerHint);
    if (!clickRes.clicked) {
      throw new Error(`trigger_not_clicked_in_vision: ${clickRes.reason ?? 'unknown'}`);
    }
    await new Promise<void>(r => { setTimeout(r, VISION_BASELINE_SETTLE_MS); });
    await scope.screenshot(screenshotPath);
  });
} else {
  await browser.withTab(`${baseUrl}${page.route}`, undefined, async scope => {
    await new Promise<void>(r => { setTimeout(r, VISION_BASELINE_SETTLE_MS); });
    await scope.screenshot(screenshotPath);
  });
}
```

### 3.2 Behavior parity with the crawler

| Step                 | Crawler                                          | Vision baseline (after fix)                     |
| -------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Navigate to base     | `browser.navigate(baseUrl + baseRoute)`          | `browser.withTab(`${baseUrl}${ctx.baseRoute}`)` |
| Click trigger        | `browser.clickByHint(item.trigger)`              | `scope.clickByHint(ctx.triggerHint)`            |
| Settle               | `setTimeout(stateSettleMs ?? 250)`               | `setTimeout(VISION_BASELINE_SETTLE_MS = 1500)`  |
| Failure handling     | push `trigger_not_found` to `skipped`            | throw → existing `catch` logs + `continue`s     |

The longer settle (1500ms vs 250ms) is intentional and unchanged from the current implementation — the vision pass needs the page visually quiescent before the screenshot, while the crawler only needs the DOM stable enough to walk.

### 3.3 Drop the now-unused import

`resolveTriggerSelector` is no longer referenced from `discover.ts`. Remove the import at `discover.ts:17`. **Do not delete `discovery/trigger-resolve.ts`** — grep first; it may still be used by other callers (replay, gen-fix). If `trigger-resolve.ts` has no other callers after this change, leave a note in the PR description but do not delete in this spec's scope.

### 3.4 Logging

When `clickByHint` returns `clicked: false`, the thrown error is caught at `discover.ts:279–282`:

```ts
log.warn(`vision baseline: failed to open/screenshot page ${page.route}`, { err: String(err) });
continue;
```

That existing log line is sufficient. The message `trigger_not_clicked_in_vision: <reason>` will surface the `ClickByHintResult.reason` (`no_hint_fields` | `no_match` | etc.) for diagnosis. **Do not add a separate log statement** — single source of truth, and we want the existing dedup path.

---

## 4. Test plan

### 4.1 Existing suite — sanity

Confirm no regression:

```bash
cd /root/BugHunter
npx vitest run packages/cli/src/phases       # if any phase tests exist
npx vitest run packages/cli/src/discovery/crawler.test.ts
npx vitest run packages/cli/tests/discovery/spa-deep-crawl.test.ts
```

### 4.2 New / updated test for vision-baseline state-reopen

Find or create the vision-baseline test. Grep result at spec-write time:

- `runVisualBaseline` is currently **not** covered by a dedicated test file (grep found only `discover.ts`, `cli/run.ts`, `types.ts`).
- Add a new test: `packages/cli/src/phases/discover-vision-baseline.test.ts`.

#### Test cases

For each case, build a minimal mock `BrowserMcpAdapter` whose `withTab(url, _, fn)` calls `fn(scope)` with a stub `scope` exposing `clickByHint`, `screenshot`, and `evaluate`. Build a minimal mock `VisionClientInterface` and `VisionBudget` (`tryConsume` → true, `tryConsumeHash` → true) and a `BugHunterConfig` with `vision.enabled: true`. Drive `runVisualBaseline` directly (export it, or test via `runDiscover` if export feels wrong — pick the lower-friction path; if export, mark `runVisualBaseline` as exported in `discover.ts`).

1. **`kind: 'state'` page → `scope.clickByHint` called with `triggerHint`**
   Given a `DiscoveredPage` with `kind: 'state'`, `stateContext.baseRoute = '/'`, `stateContext.triggerHint = { testId: 'tab-insights', text: 'Insights' }`, and `clickByHint` mock returning `{ clicked: true, matchedBy: 'testId' }`, when `runVisualBaseline` runs, then:
   - `withTab` was called with URL `${baseUrl}/`
   - `scope.clickByHint` was called once with `{ testId: 'tab-insights', text: 'Insights' }`
   - `scope.screenshot` was called once
   - `scope.click` was **not** called (assert `scope.click` mock not invoked)
   - One screenshot entry produced

2. **`kind: 'state'` page → `clickByHint` returns `clicked: false` → page skipped**
   Same shape, but `clickByHint` mock returns `{ clicked: false, reason: 'no_match' }`. Assert:
   - `scope.screenshot` was **not** called
   - `log.warn` was invoked (or check the page is not in the returned entries)
   - `runVisualBaseline` does not throw — error is swallowed by the existing `catch`

3. **`kind: 'url'` page → existing path unchanged**
   Given a `DiscoveredPage` with `kind: 'url'`, `route = '/dashboard'`, assert:
   - `withTab` called with `${baseUrl}/dashboard`
   - `scope.clickByHint` was **not** called
   - `scope.screenshot` was called once

4. **Mixed batch — one `state`, one `url`, one `state` with failing trigger**
   Three pages in, two screenshot entries out (the failing one is dropped). Verifies the loop continues across failures.

### 4.3 Live-target validation (manual, after implementation)

```bash
cd /root/BugHunter
# rebuild + run BugHunter against TraiderJo per the BugHunter stack memory
# inspect run output for: "vision baseline: found N anomaly/anomalies across M page(s)"
# expect M ≥ 7 (was 3)
```

---

## 5. Acceptance criteria

1. `discover.ts:runVisualBaseline` calls `scope.clickByHint(stateContext.triggerHint)` for `kind: 'state'` pages — no `resolveTriggerSelector` and no `scope.click(...)` in that branch.
2. `kind: 'url'` page handling is byte-for-byte unchanged.
3. New test file `packages/cli/src/phases/discover-vision-baseline.test.ts` exists and covers the four cases in §4.2. All four pass under `vitest run`.
4. Existing `crawler.test.ts` + `spa-deep-crawl.test.ts` still pass.
5. `npx tsc --noEmit` clean.
6. `npx eslint . --max-warnings 0` clean.
7. Live target — TraiderJo run after fix logs `vision baseline: found N anomaly/anomalies across M page(s)` with **M ≥ 7**. (Was 3 before fix; expect at minimum the 6 main state tabs plus the seed.)
8. No new dependencies in `package.json`.

---

## 6. Files to touch

### Modify (in scope)

- `/root/BugHunter/packages/cli/src/phases/discover.ts`
  - Replace the `resolveTriggerSelector` + `scope.click(sel)` block at lines 264–272 with the `scope.clickByHint(...)` block in §3.1.
  - Remove the `resolveTriggerSelector` import at line 17.
  - If `runVisualBaseline` needs to be exported for the new test, export it and update `cli/run.ts` if it imports the function (it currently imports `runDiscover` — verify before changing export shape).

### Create (in scope)

- `/root/BugHunter/packages/cli/src/phases/discover-vision-baseline.test.ts` — four test cases per §4.2.

### Do **not** modify

- `packages/cli/src/discovery/crawler.ts` — already correct.
- `packages/cli/src/discovery/trigger-resolve.ts` — leave as-is; may have other callers.
- `packages/cli/src/adapters/browser-mcp.ts` — `clickByHint` already shipped.
- `packages/cli/src/types.ts` — `DiscoveredPage.stateContext.triggerHint` already present.

---

## 7. Risk

### Low

- **Behavioral change is local** to one branch of one function. URL-kind path untouched.
- **Same primitive** that the crawler already proved works in production (TraiderJo crawled 10 state pages successfully via this exact API call).
- **Failure mode improved** — the old code threw `'trigger_not_found_in_vision'` from `resolveTriggerSelector` returning `null`; the new code throws a similar string from a `clicked: false` result. The outer `catch` at line 279 handles both identically.

### Watch-outs (call out, don't block)

- **Settle timing** — vision uses 1500ms vs crawler 250ms. The longer wait is preserved unchanged. If `clickByHint` is async-resolved before the click event actually fires (it shouldn't be — it dispatches synchronously inside an `evaluate`), 1500ms is more than enough headroom.
- **Tab isolation** — `withTab` opens a fresh tab per page, so there is no cross-page state bleed even if a click handler navigates. This is unchanged.
- **`clickByHint` priority order** — testId → ariaLabel → text. Confirmed in `browser-mcp.ts:474–477+`. The crawler relies on this order; the vision phase will too.

### Negative requirements (don't do this)

- Do **not** introduce a new helper that wraps `clickByHint` for vision use only — single API, single call site.
- Do **not** touch `resolveTriggerSelector` or its other callers — out of scope.
- Do **not** widen `runVisualBaseline`'s parameter list — read everything from `DiscoveredPage`.
- Do **not** add retry logic on `clickByHint` failure — the vision pass treats a failed click as page-skipped, same as today.
- No `as any`. No silent `catch`. Functions stay under 40 lines.
