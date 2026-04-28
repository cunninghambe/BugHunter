# BugHunter v0.12 — Click via Single-Evaluate, with Synthetic Accessible-Name Detection

Branch: `spec/v12-click-accessible-name`
Worktree: `/tmp/bughunter-spec-v12`
Target repo: `/root/BugHunter` (consumer-side fix)
Coordinated repo: **none** — all changes land in `/root/BugHunter`. `/root/camofox-mcp` is **not** modified.

---

## §1. Objective + Boundaries

### 1.1 Objective

Eliminate the dominant remaining BugHunter infra-failure class on TraiderJo: **all 20 of 20** infra failures from smoke run `e8foz9xb1cyv399qk57oa17r` are camofox a11y-snapshot lookup failures on **`click` actions** (none on `submit`/`fill`/`navigate`). They split as:

- 14× `Element exists in DOM but has no accessible name in snapshot` (`browser-mcp.ts:235`)
- 6×  `No matching ref in snapshot or DOM` (`browser-mcp.ts:223`)

The fix has one part:

1. **Extend the v0.10 single-evaluate pattern to the click action path.** When `scope.click(selector)` is called with a string selector, perform the click via a single `scope.evaluate()` round-trip (`document.querySelector(...).dispatchEvent(new MouseEvent('click', ...))`), bypassing the snapshot→ref→camofox-click pipeline that requires an accessible name.

To avoid losing the implicit accessibility-name signal that the snapshot pipeline gave us "for free," the same evaluate-click round-trip emits a structured outcome that lets `executeUiTestInner` recover a **bug detection** (not an infra failure) of a new BugKind `interactive_element_missing_accessible_name` when the element clicked has no aria-label / textContent / title. This BugKind fires regardless of `--a11y` flags — coupling it to a flag would re-introduce the v0.4 axe-delta regression that the brief explicitly forbids.

### 1.2 In scope

- `packages/cli/src/adapters/browser-mcp.ts` — `CamofoxBrowserMcpAdapter.click()` and the `TabScope.click` factory in `makeTabScope`.
- `packages/cli/src/phases/click-runner.ts` — **new file** (mirrors `form-submit-runner.ts`). Holds `runEvaluateClick`, `buildClickScript`, the page-side IIFE, and the `EvaluateClickResult` type.
- `packages/cli/src/phases/click-runner.test.ts` — **new file**. Unit tests for the IIFE builder and the host-side reason→error mapping.
- `packages/cli/src/phases/execute.ts` — `case 'click':` branch must consume the new `EvaluateClickResult` and convert `accessibleNameAbsent: true` into a `BugDetection`.
- `packages/cli/src/types.ts` — extend `BugKind` union with `interactive_element_missing_accessible_name`. Extend `BugDetection.a11yContext` if needed (it already exists; just reuse).
- `packages/cli/src/cluster/signatures.ts` (or wherever `KIND_PRIORITY` / cluster signature registries live — confirm in Task 0) — add a cluster signature for the new BugKind so it deduplicates.
- `packages/cli/src/repro/replay.ts` — read-only check (replay must continue to work). The selector schema does not change.

### 1.3 Out of scope (explicit)

- **No** changes to `/root/camofox-mcp`. Camofox's a11y-tree-only click contract stays as-is — the fix is consumer-side. (Design C rejected; see §4.)
- **No** changes to `dom-walker.ts`. The `:nth-of-type(N)` / `tag[aria-label="..."]` selector emission is correct. We are not silently dropping unnamed buttons (Design D rejected).
- **No** changes to `browser-mcp-snapshot.ts`, `resolveStringSelector`, `resolveByHtml`, or any selector-resolution code path. The snapshot pipeline still services structured `{role, name, nth}` selectors for callers that pass those (forms, structured calls). Only the **string-selector click path** is rerouted.
- **No** changes to `scope.type` (handled by `runFormSubmit` in v0.10), `scope.scroll`, `scope.navigate`, or `scope.snapshot`.
- **No** new `--a11y` flag, `--strict-a11y` flag, or config-gated emission. The new BugKind fires unconditionally on every evaluate-click against an unnamed element.
- **No** retry of failed clicks beyond what already exists (the v0.5 single-retry on element_not_found stays — but it is now unreachable for string-selector clicks because the evaluate path replaces the resolveRef path entirely).
- **No** new `BrowserMcpError.kind`. The existing `element_not_found` continues to surface for the rare case where the page-side `document.querySelector` returns null after the evaluate runs.
- **No** changes to the `clickByHint` pathway — it already uses `scope.evaluate` and is unaffected.
- **No** SurfaceMCP changes.

---

## §2. Existing Code Map

### 2.1 Files you MUST read before writing any code (in order)

| Path | Why |
| --- | --- |
| `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` lines 195–304 | `resolveRef`, `resolveViaEvaluate`, `evaluateClickByCss`, `evaluateClickByText`, and `click()`. The whole path under attack. The new `click()` on string selectors must short-circuit `resolveRef`. |
| `/root/BugHunter/packages/cli/src/adapters/browser-mcp.ts` lines 419–471 | `withTab` + `makeTabScope`. The TabScope `click` arrow-fn is what `executeUiTestInner` calls per-test; both the adapter-level `click()` and the scope-level `click` need the same rerouting. |
| `/root/BugHunter/packages/cli/src/adapters/browser-mcp-snapshot.ts` lines 126–218 | `resolveStringSelector` returns null for `:nth-of-type` / `.class` / unknown shapes (line 128–129) → `resolveViaEvaluate` runs → `resolveByHtml` returns null when the snapshot has no accessible name node for the element. **This is the failure point.** Read only. Do not modify. |
| `/root/BugHunter/packages/cli/src/adapters/browser-mcp-error.ts` (whole file, 36 lines) | `BrowserMcpError`, kind union. The new code throws `BrowserMcpError('element_not_found', ...)` only for the genuinely-missing case. |
| `/root/BugHunter/packages/cli/src/phases/form-submit-runner.ts` (whole file, 212 lines) | **Pattern to mirror.** `runFormSubmit` + `buildFillSubmitScript` + `buildPolledScript` + `waitForFormPresent`. Match the export shape, the IIFE-as-template-string convention, the discriminated-union return shape, the `JSON.stringify` interpolation discipline, and the host-side reason→Error mapping. |
| `/root/BugHunter/packages/cli/src/phases/execute.ts` lines 485–516 | `case 'click':` branch. Today: `await scope.click(tc.action.selector)`. New: capture the `EvaluateClickResult`, push a `BugDetection` if `accessibleNameAbsent: true`. |
| `/root/BugHunter/packages/cli/src/phases/execute.ts` lines 517–557 | The catch block that converts `BrowserMcpError('element_not_found' \| 'transport' \| 'timeout')` into `InfrastructureFailure`. Behaviour preserved. The new path throws the same BrowserMcpError shapes; no catch-side change needed. |
| `/root/BugHunter/packages/cli/src/types.ts` lines 23–86 (`BugKind` union) and lines 559–607 (`BugDetection`, `a11yContext`) | Where the new BugKind slot lives, and the existing `a11yContext.observedFocusChain` / `triggeringSelector` shape. We will reuse `a11yContext.triggeringSelector` and add no new field to the context object. |
| `/root/BugHunter/packages/cli/src/cluster/` (whole dir; `find` it first — likely `cluster.ts` and a signature registry) | Where to register a cluster signature for the new BugKind so 14 separate occurrences fold into ≤2 clusters (one per page). |
| `/tmp/TraiderJo/.bughunter/runs/e8foz9xb1cyv399qk57oa17r/infrastructure.jsonl` | The 20 failure samples. Reference for tests and acceptance counting. |
| `/root/BugHunter/SPEC_V10_FORM_SELECTOR_RESOLUTION.md` | Style and decomposition template. The entire `runFormSubmit` design transposes 1:1 to `runEvaluateClick`. |

### 2.2 Patterns to follow

- **Single-evaluate page interaction.** The v0.10 fix moved the form-fill+submit into one `scope.evaluate()` round-trip. Match that exactly: one `evaluate` call per click, no host-side polling, no host-side selector parsing. The page-side IIFE owns visibility / disabled checks / dispatch.
- **Discriminated-union return from page-side scripts.** Convention: `{ ok: true, ... }` or `{ ok: false, reason: '<slug>' }`. Reuse where possible. New return-shape additions (visibility metadata, accessible-name-absent flag) live as `Record<string, unknown>` properties on the success branch only.
- **Typed errors via reason strings, not subclasses.** Mirror `runFormSubmit` (`form-submit-runner.ts:50-58`) which throws `Error('submit: <reason> (formSelector=<sel>)')`. The click runner throws `Error('click: <reason> (selector=<sel>)')`.
- **`JSON.stringify` for every interpolated string into the page IIFE.** Existing pattern (`form-submit-runner.ts:82-83`, `browser-mcp.ts:249`). Never raw concatenation.
- **Native value setter for React-controlled input writes.** Not relevant to clicks (no value set), but the `MouseEvent` synthesis pattern is already established by `evaluateClickByCss` (`browser-mcp.ts:249`). Reuse the literal `MouseEvent('click', {bubbles:true,cancelable:true,view:window,button:0})` shape — TraiderJo's React handlers are tested against exactly this event shape in v0.6.
- **Cluster signature for the new BugKind.** Look at how `axe_color_contrast_strong`, `image_missing_alt`, `form_input_unlabeled` are registered (probably in `cluster.ts` under a `KIND_PRIORITY` map and a `clusterKey()` switch). The new BugKind clusters by `(pageRoute, selectorClass)` — same shape as `image_missing_alt`.

### 2.3 DO NOT

- **Do not** modify `/root/camofox-mcp`. (Design C rejected.)
- **Do not** modify `dom-walker.ts`, `discovery/crawler.ts`, `phases/plan.ts`, or any discovery-time code. (Design D rejected.)
- **Do not** modify `browser-mcp-snapshot.ts` — `resolveRef`, `resolveSelectorInSnapshot`, `resolveStringSelector`, `resolveByHtml` all stay as-is.
- **Do not** introduce a new `BrowserMcpAdapter` method. The change is a *behavioural* rerouting inside the existing `click()` impl.
- **Do not** route structured-selector clicks (`{role, name?, nth?}`) through the evaluate path. Those still go through `resolveRef` — they have unambiguous a11y-tree refs and the snapshot path is correct for them.
- **Do not** create new BugKinds beyond `interactive_element_missing_accessible_name`.
- **Do not** gate the new BugKind on `--a11y`, `enableA11y`, `a11yStrict`, or any config flag. The brief explicitly forbids it.
- **Do not** add per-occurrence retries on the evaluate-click path. One evaluate, one outcome.
- **Do not** mutate the page (e.g., adding `data-bughunter-clicked` attributes). Same rule as v0.10.
- **Do not** introduce a host-side `setTimeout` poll. If the element appears asynchronously and querySelector returns null at evaluate time, that's a real `element_not_found` — let the existing single-retry-on-element_not_found in `click()` handle the dynamic-DOM race (it already re-takes a snapshot — we will adapt this for the new path; see §4.4).
- **Do not** skip emission of the new BugKind on the second retry attempt (would silently lose data).
- **Do not** swallow page-eval errors. `runEvaluateClick` rethrows as `BrowserMcpError('evaluate_failed', ...)` matching the existing pattern.
- **Do not** broaden the click-runner's responsibilities. It does click, it returns a result. It does not snapshot, does not screenshot, does not classify other bugs. Bug emission lives in `execute.ts`.

---

## §3. Investigation Findings

### 3.1 Method

1. Read `packages/cli/src/adapters/browser-mcp.ts` (whole file, 542 lines) and `browser-mcp-snapshot.ts` (whole file, 226 lines).
2. Read `packages/cli/src/phases/execute.ts` (lines 1–700, focus on `case 'click':` and the catch block).
3. Loaded all 20 entries from `/tmp/TraiderJo/.bughunter/runs/e8foz9xb1cyv399qk57oa17r/infrastructure.jsonl`.
4. Verified camofox-side click contract by reading `/root/camofox-mcp/src/core/tools.ts` lines 58–73: the `click` tool requires `{tabId, ref}` — no CSS selector accepted.
5. Cross-referenced the v0.10 `runFormSubmit` design (already proven against this exact failure family for forms).
6. Manually traced the 14× `Element exists in DOM but has no accessible name in snapshot` path for the two `aria-label="Open navigation"` failures — confirming even an explicitly-aria-labeled element fails the round-trip when the parent role/role-tree mismatches.

### 3.2 Sampled failure entries (the brief asked for 3–5; all 20 are categorisable)

| # | Selector | Detail | Branch |
| --- | --- | --- | --- |
| 1 | `button[aria-label="Open navigation"]` | `Element exists in DOM but has no accessible name in snapshot` | `resolveByHtml` returned null after `resolveStringSelector → resolveAttrSelector` returned null at line 144 (no node with role `button` AND `name === "Open navigation"` in the snapshot — the hamburger button is rendered but the snapshot omits or differently-labels it). |
| 2 | `button:nth-of-type(3)` | `Element exists in DOM but has no accessible name in snapshot` | `resolveStringSelector` returns null (line 128: contains `:nth-of-type`) → `resolveViaEvaluate` runs `document.querySelector('button:nth-of-type(3)')`, gets HTML, `resolveByHtml` finds no candidate name in the truncated HTML (no aria-label, no placeholder, no title, no alt; textContent might be `""` or a single icon character). |
| 3 | `button:nth-of-type(14)` | `No matching ref in snapshot or DOM` | `resolveViaEvaluate` ran querySelector; the page didn't have a 14th button at evaluate time (state stale after a re-render). |
| 4 | `div:nth-of-type(1)` | `Element exists in DOM but has no accessible name in snapshot` | `resolveStringSelector` returns null → querySelector finds the div → `resolveByHtml` looks for a node with role matching `div` (`tag === 'div' || n.role === tag`) and a name substring-matching the textContent, but the div has no textContent (or only icon font). Cannot resolve. |
| 5 | `button[aria-label="Refresh AI usage history"]` (state page `/?setTab=settings`) | `Element exists in DOM but has no accessible name in snapshot` | Same as #1 — even with aria-label set, the snapshot at the moment of resolution doesn't expose this exact name+role pair. State-page race + snapshot incompleteness, **not** a missing aria-label in source. |

**Critical observation from samples #1 and #5:** even when source code DOES set `aria-label`, the camofox snapshot can fail to reflect it (race / iframe / aria-hidden ancestor / etc.). This refutes Design A's "emit ARIA-friendly selectors" recovery from V10 — and it tells us we cannot trust the snapshot pipeline as a "did the user set aria-label?" oracle. The new BugKind therefore can only reliably fire when the page-side IIFE confirms **at the DOM level** that the element has no accessible name (`!ariaLabel && !ariaLabelledby && !innerText.trim() && !title`). This is a strictly stricter signal than the snapshot path can emit, which is the right thing.

### 3.3 Root-cause statement (one paragraph)

The string-selector `click` path goes through `CamofoxBrowserMcpAdapter.click → resolveRef → resolveSelectorInSnapshot → resolveViaEvaluate → resolveByHtml`. Every step except the final one succeeds: the element exists, querySelector finds it, and the page is responsive. The final step — round-tripping back to a camofox snapshot ref — requires the element to have an accessible name reflected in the snapshot's textual a11y tree. TraiderJo (and any non-trivial real app) has many interactive elements that either (a) genuinely lack an accessible name (icon buttons, decorative divs with `[onclick]`), or (b) have one in source but not in the snapshot at the moment of resolution. The current design conflates "I cannot resolve this back to a snapshot ref" with "I cannot click this," which is wrong: we **can** click it via raw DOM dispatch, and we **can** separately diagnose the missing accessible name as a real a11y bug. The fix is to do both.

### 3.4 Verdict on the brief's hypotheses

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| **A.** Extend v0.10 single-evaluate pattern to clicks. | **YES — chosen.** | All 20 failures are CSS-selector clicks against elements that exist in DOM (`querySelector` returns non-null in 14/20). The page-side IIFE pattern from `form-submit-runner.ts` transposes 1:1 to clicks. |
| **B.** Two-step (try snapshot, fall back to evaluate), emit synthetic detection on fallback. | **No — superseded by A+.** | B's synthetic emission is the right idea but its split code path is wrong. Design A becomes A+ by emitting the same synthetic BugKind unconditionally on the evaluate-click path when the page-side check confirms accessible-name absence — same outcome, no split path. |
| **C.** Camofox-side `click_dom(selector)` channel. | **No.** | Cross-repo. Camofox is intentionally a11y-tree-only; adding a bypass tool there is the wrong layer. (Out of scope.) |
| **D.** Filter unnamed elements out of `dom-walker.ts`. | **No, hard veto.** | Silent test loss. The whole point of testing is to exercise interactive elements; removing them because they have a11y problems is the inverse of the desired behaviour. |
| **E (verification only).** Camofox click endpoint rejects refs whose name is empty. | **Confirmed reading `/root/camofox-mcp/src/core/tools.ts:58-73`** — camofox accepts any ref string and routes it to its REST `/click`; the failure is purely client-side in `resolveByHtml`. |

---

## §4. Design Choice (architect picks ONE — rationale required)

### 4.1 Options considered

- **Option 1: Bump snapshot timeout / re-snapshot more aggressively before `resolveByHtml`.** Cheap. Doesn't fix the failure for elements with genuinely no accessible name (most of TraiderJo's hamburger / icon buttons). Wastes 200–500 ms per click.
- **Option 2 (Design B): Split path — try snapshot, fall back to evaluate, emit synthetic detection on fallback.** Adds a code path. Two sources of truth for "did the click happen." Increased complexity per the brief's own warning.
- **Option 3 (Design C): Modify camofox to accept CSS selectors directly.** Cross-repo. Defers stealth/a11y philosophy debate. Out of scope.
- **Option 4 (Design D): Filter unnamed elements at discovery.** Silent test loss; anti-pattern.
- **Option 5 (CHOSEN — Design A+): Single-evaluate click for all string selectors. Page-side IIFE returns `{ ok: true, accessibleNameAbsent: bool, ariaLabelSource: 'aria-label' | 'aria-labelledby' | 'text' | 'title' | null, ... }`. `executeUiTestInner` emits an `interactive_element_missing_accessible_name` BugDetection when `accessibleNameAbsent === true`.**

### 4.2 Chosen design (A+)

**Rerouting:** when `CamofoxBrowserMcpAdapter.click(selector)` is called with a `string` selector (NOT a `StructuredSelector`), perform the click via `runEvaluateClick(scope, selector)`, which calls `scope.evaluate(buildClickScript(selector))` exactly once. The IIFE:

1. Runs `document.querySelector(selector)`. If null → return `{ ok: false, reason: 'element_not_in_dom' }`.
2. Computes visibility: `el.offsetParent !== null || (rect.width > 0 && rect.height > 0)`. If not visible → return `{ ok: false, reason: 'element_not_visible' }`.
3. Computes accessible name in priority order:
   - `aria-labelledby` referenced text → if non-empty, `ariaLabelSource = 'aria-labelledby'`.
   - `aria-label` attribute → if non-empty, `ariaLabelSource = 'aria-label'`.
   - `title` attribute → if non-empty, `ariaLabelSource = 'title'`.
   - For `<input>`: associated `<label for="">`'s text → if non-empty, `ariaLabelSource = 'label-for'`.
   - `el.textContent.trim()` → if non-empty (and not just whitespace), `ariaLabelSource = 'text'`.
   - Else `ariaLabelSource = null`, `accessibleNameAbsent = true`.
4. Dispatch `new MouseEvent('click', {bubbles:true, cancelable:true, view:window, button:0})`.
5. Return `{ ok: true, accessibleNameAbsent, ariaLabelSource, tagName: el.tagName.toLowerCase(), role: el.getAttribute('role') || null }`.

**Bug emission:** in `execute.ts` `case 'click':`, after `runEvaluateClick` returns:

```ts
if (clickResult.ok && clickResult.accessibleNameAbsent === true) {
  bugs.push({
    kind: 'interactive_element_missing_accessible_name',
    rootCause: `Interactive element <${clickResult.tagName}${clickResult.role ? ` role="${clickResult.role}"` : ''}> has no accessible name (no aria-label, aria-labelledby, title, or text content).`,
    pageRoute: tc.page,
    selectorClass: tc.action.selector,
    a11yContext: {
      triggeringSelector: tc.action.selector,
      activeElementTag: clickResult.tagName,
    },
  });
}
```

**Structured selector path unchanged:** `if (typeof selector !== 'string') { /* existing snapshot path */ }`. Forms, structured calls, future role-based tests all continue to use the snapshot pipeline, which is correct for them.

**TabScope.click consistency:** the `makeTabScope` factory's `click` arrow-fn (line 441-443) is updated identically — `runEvaluateClick(scope-bound, selector)` for string selectors, snapshot path for structured.

### 4.3 Rationale (one paragraph)

Design A+ is the only candidate that (i) closes the entire failure class with a contained, single-file behavioural change plus one new helper file, (ii) re-uses an already-proven pattern from v0.10 with the same shape and the same testing surface, (iii) does NOT lose the accessibility-name signal — it actually *improves* it by computing accessible-name presence from the DOM directly (stricter than the snapshot path could ever be), (iv) requires zero changes to camofox, dom-walker, plan, replay, or any selector schema, (v) gates the new BugKind on a per-element page-side fact (not a flag), satisfying the brief's "must not require `--a11y` flag" constraint, and (vi) preserves the structured-selector snapshot path for callers that want it. Design B's split path is strictly inferior — its only added value (synthetic emission on fallback) becomes a no-op subset of A+, and we'd carry the snapshot-side complexity for no benefit because every TraiderJo failure shows the snapshot path is unreliable for unnamed elements regardless. Design C is the right long-term direction (camofox should eventually accept Locators) but it's a v1.x architectural shift and v0.12's job is to stop the bleed in /root/BugHunter.

### 4.4 Key signatures

```ts
// packages/cli/src/phases/click-runner.ts (NEW)

import type { EvaluateResult } from '../adapters/browser-mcp.js';

/** Minimal scope contract — same shape as form-submit-runner.ts:8-10. */
type ClickScope = {
  evaluate(script: string): Promise<EvaluateResult>;
};

export type EvaluateClickReason =
  | 'element_not_in_dom'
  | 'element_not_visible'
  | 'page_eval_threw'
  | 'no_result'
  | 'unknown';

export type AccessibleNameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'title'
  | 'label-for'
  | 'text';

export type EvaluateClickResult =
  | {
      ok: true;
      accessibleNameAbsent: boolean;
      ariaLabelSource: AccessibleNameSource | null;
      tagName: string;            // 'button', 'div', etc.
      role: string | null;        // role attribute, or null
    }
  | { ok: false; reason: EvaluateClickReason };

/**
 * Click an element via a single scope.evaluate round-trip — bypasses the
 * camofox a11y-snapshot lookup that fails for icon-only / unnamed elements.
 *
 * Returns the raw EvaluateClickResult so the caller can both:
 *   - distinguish actionable failures (element_not_in_dom, element_not_visible)
 *     from successful clicks against unnamed elements;
 *   - emit a BugDetection (interactive_element_missing_accessible_name) when
 *     ok && accessibleNameAbsent.
 *
 * Throws BrowserMcpError('element_not_found', ...) when reason is
 * 'element_not_in_dom' or 'element_not_visible' — matching the existing
 * shape of execute.ts's catch block.
 *
 * Throws BrowserMcpError('evaluate_failed', ...) on transport / page-eval errors.
 */
export async function runEvaluateClick(
  scope: ClickScope,
  selector: string,
): Promise<EvaluateClickResult & { ok: true }>;

/** Build the page-side IIFE. Exported solely for unit testing. */
export function buildClickScript(selector: string): string;
```

```ts
// packages/cli/src/adapters/browser-mcp.ts (MODIFIED)

// In CamofoxBrowserMcpAdapter.click():
async click(selector: string | StructuredSelector): Promise<ClickResult> {
  const tabId = this.requireTab();
  if (typeof selector === 'string') {
    // v0.12: route string selectors through the evaluate path.
    // Re-uses the existing tab; the click-runner's ClickScope is a thin shim.
    const evalScope = { evaluate: (script: string) =>
      this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: script })
        .then(r => ({ value: r.result ?? r.value })) };
    const result = await runEvaluateClick(evalScope, selector);
    // Adapter contract is { clicked: boolean }; the rich result is consumed
    // by the TabScope-level click factory below for execute.ts.
    return { clicked: true };
  }
  // Structured selector: existing snapshot path, unchanged.
  try {
    const ref = await this.resolveRef(tabId, selector);
    await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
    return { clicked: true };
  } catch (err) { /* existing single-retry, unchanged */ }
}

// In makeTabScope, the click arrow-fn becomes:
click: (selector) => {
  if (typeof selector === 'string') {
    const evalScope = { evaluate: (script: string) =>
      this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: script })
        .then(r => ({ value: r.result ?? r.value })) };
    return runEvaluateClick(evalScope, selector).then(() => ({ clicked: true }));
  }
  return this.resolveRef(tabId, selector).then(ref =>
    this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref }).then(() => ({ clicked: true }))
  );
},
```

```ts
// packages/cli/src/adapters/browser-mcp.ts — TabScope (NEW EXTRA SIGNATURE)
// To let executeUiTestInner observe accessibleNameAbsent without breaking the
// existing { clicked: boolean } shape used by other callers, add an
// orthogonal scope-level helper:

export type TabScope = {
  // ...existing fields
  /**
   * v0.12: click with rich evaluate-result. Used by execute.ts to emit the
   * interactive_element_missing_accessible_name BugDetection. For structured
   * selectors, returns { ok: true, accessibleNameAbsent: false, ariaLabelSource: null,
   * tagName: '<unknown>', role: null } — i.e., the rich shape is degraded but
   * present, so callers do not need to branch.
   */
  clickWithObservation(selector: string | StructuredSelector): Promise<EvaluateClickResult & { ok: true }>;
};
```

```ts
// packages/cli/src/types.ts (MODIFIED — one-line addition to BugKind)

export type BugKind =
  | 'console_error'
  // ... existing kinds ...
  | 'interactive_element_missing_accessible_name'  // v0.12
  // ... rest unchanged
```

```ts
// packages/cli/src/phases/execute.ts (MODIFIED — case 'click':)

case 'click':
  if (tc.action.selector === undefined) throw new Error('execute: click action missing selector');
  if (tc.action.selector === '') throw new Error('execute: click action has empty selector — planning bug?');
  {
    const obs = await scope.clickWithObservation(tc.action.selector);
    if (obs.accessibleNameAbsent === true) {
      bugs.push({
        kind: 'interactive_element_missing_accessible_name',
        rootCause: `Interactive <${obs.tagName}${obs.role !== null ? ` role="${obs.role}"` : ''}> has no accessible name on ${tc.page}`,
        pageRoute: tc.page,
        selectorClass: tc.action.selector,
        a11yContext: {
          triggeringSelector: tc.action.selector,
          activeElementTag: obs.tagName,
        },
      });
    }
  }
  break;
```

---

## §5. Edge Cases

Each must be enumerated in tests (§6).

| # | Case | Behaviour |
| --- | --- | --- |
| 1 | Selector matches no element in DOM | Page-side returns `{ ok: false, reason: 'element_not_in_dom' }`. Host throws `BrowserMcpError('element_not_found', 'click: element_not_in_dom (selector=<sel>)')`. `execute.ts` catch branch converts to `InfrastructureFailure(kind: browser_element_not_found)`. |
| 2 | Selector matches but element has `display: none` / `visibility: hidden` / zero rect | `element_not_visible`. Same conversion as #1. (Today the snapshot path also fails on hidden elements; behaviour preserved.) |
| 3 | Selector matches a visible button with `aria-label="Open navigation"` (DOM-truth, not snapshot-truth) | `ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-label'`. No BugDetection emitted. Click dispatched. |
| 4 | Selector matches an icon button (`<button><svg/></button>`) with no aria-label, no text, no title | `ok: true, accessibleNameAbsent: true, ariaLabelSource: null`. **BugDetection emitted.** Click dispatched (so the test still observes downstream effects: console errors, navigation, etc.). |
| 5 | Selector matches a `<div role="button" tabindex="0">` with text content "Save" | `ok: true, accessibleNameAbsent: false, ariaLabelSource: 'text'`. No BugDetection. Click dispatched. |
| 6 | Selector matches a `<div role="button">` with no text and an `aria-labelledby="lbl1"` pointing to a `<span id="lbl1">Submit</span>` | `ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-labelledby'`. No BugDetection. (The IIFE resolves `aria-labelledby` to the referenced node's textContent.) |
| 7 | Selector matches an `<input>` whose label is `<label for="x">Email</label>` with the input having `id="x"` | `ariaLabelSource: 'label-for'`, `accessibleNameAbsent: false`. No BugDetection. |
| 8 | Selector matches multiple elements — `document.querySelector` returns the first | First-in-document-order wins (matches today's snapshot path tie-breaker). The IIFE clicks exactly one element. |
| 9 | `:nth-of-type(N)` selector (the dominant TraiderJo failure mode) | Native CSS pseudo-class; `document.querySelector` resolves it. IIFE handles uniformly. |
| 10 | Selector contains a quote / backslash | `JSON.stringify(selector)` interpolation handles all escaping. The IIFE reads the literal selector string verbatim. |
| 11 | Selector targets an element inside an iframe | Out of scope; matches today's behaviour (querySelector does not pierce iframes). The element is reported `element_not_in_dom`. |
| 12 | The element is detached from the DOM between querySelector and dispatchEvent | The dispatchEvent succeeds against the detached node (no observable click on the page, but the event fires on the node). Result: `ok: true, accessibleNameAbsent: ?` based on the detached node's attributes. Race-acceptable: matches `evaluateClickByCss` behaviour today. |
| 13 | Element is `disabled` (`<button disabled>`) | The IIFE dispatches the click anyway (matches today's behaviour for the snapshot path — camofox does not pre-check disabled). The browser will still fire the event but the default action may no-op. Acceptable. |
| 14 | `pointer-events: none` on the element | Same as #13 — the IIFE dispatches; whether the page handles it is the page's call. |
| 15 | Page navigates (or replaces document) during the evaluate | The evaluate completes against the new document or throws `page_eval_threw`. Host throws `BrowserMcpError('evaluate_failed', ...)` → `execute.ts` catch branch converts to `InfrastructureFailure`. |
| 16 | Element has `aria-label=""` (empty string) | Treated as absent. Falls through to title → label-for → text. If all empty → `accessibleNameAbsent: true`. |
| 17 | Element has `aria-label="   "` (whitespace) | Treated as absent (we `.trim()`). |
| 18 | Element has `aria-labelledby="missing-id"` (broken ref) | Falls through to next priority. |
| 19 | Element textContent contains only emoji or single icon-font character | textContent.trim() is non-empty; `ariaLabelSource: 'text'`, `accessibleNameAbsent: false`. **Known false negative** — the brief accepts this; the new BugKind is conservative. (Future v0.13 spec can add icon-font detection.) |
| 20 | Selector is a `StructuredSelector` (`{role:'button',name:'Save'}`) | Snapshot path used; `clickWithObservation` returns the degraded shape `{ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'unknown', role: null }`. No BugDetection emitted (we don't have the DOM-side facts). This is acceptable: structured-selector callers are by definition specifying a name, so the absent-name case doesn't apply. |
| 21 | Multiple click tests against the same unnamed button on the same page | One BugDetection per occurrence; cluster signature folds them into one cluster keyed by `(pageRoute, selectorClass)`. Final cluster count contributions are bounded. |
| 22 | The same unnamed element appears under different selectors (`button:nth-of-type(3)` vs `button[onclick]`) | Two clusters (different `selectorClass`). Acceptable — they are separately fixable. |
| 23 | Element has `aria-hidden="true"` ancestor | Element is a11y-hidden but DOM-clickable. IIFE clicks it; `accessibleNameAbsent` is computed from element's own attrs (not ancestor a11y). Acceptable; same as today. |

---

## §6. Test Plan

### 6.1 Unit tests — `packages/cli/src/phases/click-runner.test.ts` (NEW)

```
runEvaluateClick (host-side reason→error mapping, scope.evaluate stubbed)
  - returns ok:true success result when evaluate returns { ok:true, accessibleNameAbsent:false, ariaLabelSource:'aria-label', tagName:'button', role:null }
  - returns ok:true with accessibleNameAbsent:true when evaluate returns the absent case
  - throws BrowserMcpError('element_not_found') with selector populated when evaluate returns { ok:false, reason:'element_not_in_dom' }
  - throws BrowserMcpError('element_not_found') with selector populated when evaluate returns { ok:false, reason:'element_not_visible' }
  - throws BrowserMcpError('evaluate_failed') when scope.evaluate rejects
  - throws BrowserMcpError('evaluate_failed') with reason:'no_result' when evaluate returns { value: undefined }
  - throws BrowserMcpError('evaluate_failed') with reason:'page_eval_threw' when evaluate returns { ok:false, reason:'page_eval_threw' }
  - selector with embedded quotes and backslashes is preserved verbatim through the script (read-side via the script string contents)

buildClickScript (the page-side IIFE generator)
  - JSON-stringifies the selector exactly once
  - output is a single self-invoking IIFE expression (parentheses-wrapped, ends with `()`)
  - output references each of: document.querySelector(<selector>), aria-labelledby resolution (getElementById on space-separated ids), aria-label, title, <label for=...>, textContent, MouseEvent('click', {...})
  - selector containing double-quote ('button[data-id="x"]') → contains JSON-encoded "button[data-id=\"x\"]"
  - selector containing backslash → preserved
  - selector containing single quote → preserved
  - output length is bounded to <4 KiB (sanity guard)
```

### 6.2 Adapter tests — extend `packages/cli/src/adapters/browser-mcp.test.ts` (or create if absent — confirm in Task 0)

```
CamofoxBrowserMcpAdapter.click (string selector path)
  - calls scope.evaluate exactly once with a buildClickScript output
  - does NOT call snapshot or the camofox 'click' tool when selector is a string
  - does NOT call resolveRef when selector is a string
  - structured selector { role: 'button', name: 'Save' } still calls snapshot + camofox click
  - returns { clicked: true } on success (preserves existing API)

makeTabScope.click
  - string selector takes the evaluate path
  - structured selector takes the snapshot path

clickWithObservation (new TabScope method)
  - returns full EvaluateClickResult from the evaluate path for string selectors
  - returns the degraded shape for structured selectors
```

### 6.3 Execute-phase tests — extend `packages/cli/src/phases/execute-form-submit.test.ts` (or new sibling `execute-click.test.ts` — matches the v0.10 split; pick whichever the build currently has)

```
case 'click' bug emission
  - when clickWithObservation returns accessibleNameAbsent:true → bugs array contains exactly one BugDetection of kind 'interactive_element_missing_accessible_name'
  - emitted BugDetection has pageRoute=tc.page, selectorClass=tc.action.selector, a11yContext.triggeringSelector=tc.action.selector
  - when accessibleNameAbsent:false → no BugDetection of that kind is emitted
  - when clickWithObservation throws BrowserMcpError('element_not_found') → InfrastructureFailure(kind:'browser_element_not_found') is emitted (existing path; unchanged)
  - emission fires without --a11y / enableA11y / a11yStrict flags (assert by passing { enableA11y: false, a11yStrict: false } in the executeUiTest options)
```

### 6.4 Cluster signature test — extend `packages/cli/src/phases/cluster.test.ts`

```
- 5 occurrences of interactive_element_missing_accessible_name on /?setTab=settings with selectorClass='button[aria-label="Refresh AI usage history"]' fold into 1 cluster
- 3 occurrences across different pages produce 3 clusters (signature includes pageRoute)
- 2 occurrences with different selectorClass on same page produce 2 clusters
```

### 6.5 Smoke acceptance (TraiderJo)

Run `bughunter run --project /tmp/TraiderJo --runId v12-smoke-001` after all tasks complete.

| Metric | v0.11 baseline (run `e8foz9xb1cyv399qk57oa17r`) | v12 target | Rationale |
| --- | --- | --- | --- |
| Total infrastructure failures | 20 | **< 5** | Hard acceptance — see §9. |
| Of which `Element exists in DOM but has no accessible name in snapshot` | 14 | **0** | This entire branch is gone. |
| Of which `No matching ref in snapshot or DOM` (click) | 6 | **≤ 2** | Genuinely-detached elements between probe and click can still race; 2 is the budget. |
| `interactive_element_missing_accessible_name` bug clusters | 0 (kind didn't exist) | **5–15** | One per (pageRoute, selectorClass) for unnamed elements. TraiderJo has at least 14 unnamed buttons across `/` and `/?setTab=settings` per the failure samples; bounded by cluster signature. |
| `interactive_element_missing_accessible_name` total occurrences | n/a | ≥ 14 | At minimum, the same elements that produced infra failures now produce bug detections. |
| Total tests run | 74 | ≥ 74 | We don't lose tests — they all execute now. |
| Other infra-failure classes | 0 | 0 | No regression. |
| `focus_lost_after_action`, `axe_color_contrast_strong`, etc. | (per v0.11 baseline) | ± 2 | Unrelated clusters stable. |

### 6.6 Verification gate
```bash
cd /root/BugHunter
pnpm -C packages/cli typecheck
pnpm -C packages/cli lint --max-warnings 0
pnpm -C packages/cli test
pnpm -C packages/cli build
```
All four must pass with zero warnings before merge.

---

## §7. Negative Requirements

- **No** `as any`, `// @ts-expect-error`, `// eslint-disable-next-line` other than at the existing `eslint-disable` justifications.
- **No** new files outside this list:
  - `packages/cli/src/phases/click-runner.ts`
  - `packages/cli/src/phases/click-runner.test.ts`
  - **At most one of** `packages/cli/src/phases/execute-click.test.ts` (if the existing test split convention favours it) **or** an extension of `execute-form-submit.test.ts` (if that file is the ad-hoc execute test bucket). The Task 0 assignee picks one.
- **No** changes to `dom-walker.ts`, `crawler.ts`, `discover.ts`, `plan.ts`, `replay.ts`, `mutation/apply.ts`, `surface-mcp.ts`, or any classifier other than the cluster signature additions for the new BugKind.
- **No** changes to `BrowserMcpAdapter` interface beyond adding `clickWithObservation` to `TabScope` and re-implementing the existing `click` to take the new path for string selectors.
- **No** changes to SurfaceMCP, camofox-mcp, or any external service.
- **No** new BugKind beyond `interactive_element_missing_accessible_name`.
- **No** new InfrastructureFailure kind.
- **No** parallel page-side scripts. One evaluate per click.
- **No** retry on the evaluate path. (Existing single-retry on `element_not_found` for structured selectors stays — but only for that path.)
- **No** writing to `state.json` outside the existing `runState` flow.
- **No** function over 40 lines. **No** file over 300 lines (`click-runner.ts` target: ≤180 lines, including the IIFE template literal which counts as one expression).
- **No** mutation of the page under test (no `data-bughunter-clicked`, no `setAttribute`, no MutationObserver injection beyond what the existing v0.6 path already does).
- **No** booting a real browser in unit tests. All tests stub `scope.evaluate` and assert on the script string and on the dispatched-result handling.
- **No** emoji in code, comments, or commit messages.
- **No** widening `--a11y` / `enableA11y` / `a11yStrict` semantics. The new BugKind fires unconditionally on the evaluate-click path.

---

## §8. Task Breakdown (≤6 tasks)

### Task 0 — Confirmation pre-flight (10 min, @coder)
**Assignee:** @coder
**Depends on:** none
**Files to read (no modify):**
- `packages/cli/src/cluster/` directory listing (`ls`).
- The cluster-signature registry file (likely `packages/cli/src/cluster.ts` or `packages/cli/src/phases/cluster.ts`).
- `packages/cli/src/adapters/browser-mcp.test.ts` (does it exist? if yes, where is it? if no, the adapter test extension lives inside the existing pattern).
- `packages/cli/src/phases/execute-form-submit.test.ts` (the v0.10 test split convention).
**Deliverable:** a 5-line note in the PR description confirming:
1. Where the cluster-signature registry is (file + function name).
2. Whether to extend `execute-form-submit.test.ts` or add `execute-click.test.ts` (pick one and stick with it; mirror the v0.10 convention).
3. Whether `browser-mcp.test.ts` exists; if not, the adapter tests fold into `click-runner.test.ts`.
**Test:** N/A — read-only.
**Done when:** the note is in the PR draft.
**DO NOT:** make code changes in this task.

### Task 1 — `click-runner.ts` and unit tests (30 min, @coder)
**Assignee:** @coder
**Depends on:** Task 0
**Files to modify:** none.
**Files to create:**
- `packages/cli/src/phases/click-runner.ts` (~150 lines: `EvaluateClickResult`, `EvaluateClickReason`, `AccessibleNameSource`, `runEvaluateClick`, `buildClickScript`).
- `packages/cli/src/phases/click-runner.test.ts` (~120 lines: §6.1).
**Test:** `pnpm -C packages/cli test click-runner`
**Done when:**
- `runEvaluateClick(scope, selector)` is exported with the §4.4 signature.
- `buildClickScript(selector)` is exported (test-only) and returns a single IIFE.
- All §6.1 tests land green.
- File is ≤200 lines; `runEvaluateClick` is ≤40 lines; `buildClickScript` is ≤40 lines (the IIFE counts as one template literal expression).
**DO NOT:** import or modify `browser-mcp.ts` from this task. The runner is layer-pure: takes a `ClickScope`, returns a result. Wiring lives in Task 2.

### Task 2 — Wire `runEvaluateClick` into `CamofoxBrowserMcpAdapter` (40 min, @coder)
**Assignee:** @coder
**Depends on:** Task 1
**Files to modify:**
- `packages/cli/src/adapters/browser-mcp.ts` — `click()` method, `makeTabScope.click`, add new `TabScope.clickWithObservation`.
- `packages/cli/src/adapters/browser-mcp.test.ts` (or `click-runner.test.ts` if browser-mcp.test.ts doesn't exist per Task 0) — adapter tests.
**Files to create:** none.
**Test:** `pnpm -C packages/cli test browser-mcp` (or the chosen test bucket).
**Done when:**
- `CamofoxBrowserMcpAdapter.click(selector)` routes string selectors through `runEvaluateClick`; structured selectors continue through `resolveRef`.
- `makeTabScope.click` mirrors the same routing.
- New `TabScope.clickWithObservation(selector)` returns the rich `EvaluateClickResult & { ok: true }` (or rethrows on failure).
- For structured selectors, `clickWithObservation` returns the degraded shape (`accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'unknown', role: null`) — no BugDetection from the structured path.
- §6.2 tests pass.
**DO NOT:** alter `resolveRef`, `resolveSelectorInSnapshot`, `resolveStringSelector`, `resolveByHtml`. The structured-selector path stays byte-identical.

### Task 3 — `interactive_element_missing_accessible_name` BugKind + cluster signature (20 min, @coder)
**Assignee:** @coder
**Depends on:** Task 0 (for cluster registry location), can run in parallel with Task 2.
**Files to modify:**
- `packages/cli/src/types.ts` — add `'interactive_element_missing_accessible_name'` to the `BugKind` union (single-line addition; alphabetise within the v0.6 a11y group or append at end with a `// v0.12` comment).
- `packages/cli/src/cluster/<registry>.ts` (file confirmed in Task 0) — add a cluster signature for the new kind: `(pageRoute, selectorClass) => "${kind}::${pageRoute}::${selectorClass}"`. Mirror `image_missing_alt` (which clusters by `(pageRoute, selectorClass)`).
- `packages/cli/src/phases/cluster.test.ts` — §6.4 tests.
**Files to create:** none.
**Test:** `pnpm -C packages/cli test cluster`
**Done when:**
- The new BugKind is part of the union.
- Cluster signature folds repeated occurrences correctly per §6.4.
- Existing cluster tests still pass.
**DO NOT:** add the new kind to `KIND_PRIORITY` if there isn't one (check Task 0); if there is, slot it next to other a11y kinds.

### Task 4 — Wire BugDetection emission in `execute.ts` `case 'click':` (20 min, @coder)
**Assignee:** @coder
**Depends on:** Task 2, Task 3
**Files to modify:**
- `packages/cli/src/phases/execute.ts` — replace `await scope.click(tc.action.selector)` in `case 'click':` with the `clickWithObservation` call + conditional bug push (§4.4 snippet).
- `packages/cli/src/phases/execute-form-submit.test.ts` (or `execute-click.test.ts` per Task 0) — §6.3 tests.
**Files to create:** none (or the optional `execute-click.test.ts` per Task 0).
**Test:** `pnpm -C packages/cli test execute`
**Done when:**
- `case 'click':` emits the new BugDetection when `accessibleNameAbsent === true`.
- The catch block conversion of `BrowserMcpError('element_not_found')` to `InfrastructureFailure` is unchanged and still works.
- §6.3 tests pass.
- The existing `case 'submit':`, `case 'fill':`, `case 'navigate':`, `case 'render':` branches are byte-identical (no diff outside the click case).
**DO NOT:** change the `state-page re-establishment` block (`tc.stateContext` handling) — that's v0.11's job and is correct.

### Task 5 — TraiderJo smoke verification (30 min, @qa)
**Assignee:** @qa (with @coder support if needed)
**Depends on:** Tasks 1–4 + clean typecheck/lint/test/build.
**Files to modify:** none (smoke is observational).
**Files to create:** none.
**Test:** Run `bughunter run --project /tmp/TraiderJo --runId v12-smoke-001 --budget-ms 1200000` and verify §6.5 metrics.
**Done when:**
- Total infra failures `< 5` (down from 20).
- `Element exists in DOM but has no accessible name in snapshot` count = 0.
- `interactive_element_missing_accessible_name` cluster count is 5–15 (i.e., the signal is recovered as a real bug bucket).
- All 74 tests run (no skip-due-to-infra-cap).
- No regression in unrelated clusters.
**DO NOT:** Tune the IIFE's accessible-name detection logic to mask false positives. If a smoke run produces > 30 occurrences of the new BugKind, that's signal — escalate to @architect for v0.13 (not a v0.12 patch).

---

## §9. Acceptance

The TraiderJo smoke run after Task 5 produces:

- **< 5** total infrastructure failures (down from 20). Specifically:
  - 0 occurrences of `Element exists in DOM but has no accessible name in snapshot`.
  - ≤ 2 occurrences of `No matching ref in snapshot or DOM` (the budget for genuinely-detached elements between query and click — these now mean `element_not_in_dom` from the IIFE, surfaced through the same `BrowserMcpError('element_not_found')` channel).
  - ≤ 2 occurrences of any other infra kind (e.g., `browser_crash` from a flaky CI run).
- **5–15** clusters of the new `interactive_element_missing_accessible_name` BugKind.
- **≥ 14** total occurrences of the new BugKind (matching the 14 originally-infra failures that were the "Element has no accessible name" branch).
- **74/74** tests run (no infra cap kicked in).
- **All four verification gates green** (typecheck, lint, test, build).
- **No regression** in v0.4–v0.11 cluster counts (focus_lost_after_action, missing_state_change, axe_color_contrast_strong, form-submit clusters all stable ±2).

If `< 5` is not met, the PR is blocked pending a follow-up architect investigation. The likely culprit will be a non-click code path also leaning on `resolveRef` (e.g., a `scope.type` call against an unnamed input that v0.10 missed) — that becomes a v0.13 spec.

### 9.1 Failures expected to remain (allowed budget of ≤ 2)

| Cause | Why it can still fail |
| --- | --- |
| Element detaches between page-load and the IIFE's `querySelector` | The page can re-render and remove an element. The IIFE returns `element_not_in_dom`. `BrowserMcpError('element_not_found')` → InfrastructureFailure. This is correct behaviour. |
| Element matches but is `display: none` due to a media query / collapsed state we navigated into | Returns `element_not_visible`. Correct behaviour: we should not click an invisible element. |
| Page navigates / replaces document during the evaluate | Returns `evaluate_failed`. Rare; CI flakiness. |

Each of these is **not** an "Element has no accessible name" failure — they are real DOM-state issues that the new path correctly distinguishes.

---

## §10. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Synthetic-event clicks miss handlers attached only via Playwright's bubble-from-trusted-event path | Low | We've used this exact `MouseEvent('click', {bubbles:true,cancelable:true,view:window,button:0})` shape in v0.6 (`evaluateClickByCss`, `evaluateClickByText`) for ~6 months without React-handler regressions. v0.10 uses the same dispatch for submit-button clicks and is in production. |
| `accessibleNameAbsent` produces a flood of detections (one per click test against the same icon button) | Medium | Cluster signature in Task 3 folds by `(pageRoute, selectorClass)`. Worst case: TraiderJo's 14 unnamed elements × ~2 roles = 28 occurrences across ~14 clusters. That's the *intended* signal, not noise. |
| The new BugKind triggers on benign cases (single-icon-emoji buttons, decorative SVGs we shouldn't be clicking) | Medium | Edge case 19 is acknowledged. Conservative: if textContent.trim() is non-empty (including emoji), we treat it as named. Future v0.13 can add icon-font / SVG-only detection. |
| Removing the `resolveRef` round-trip loses some implicit "element is a11y-visible" signal | Low | Was always misattributed: the snapshot path conflated "no name in snapshot" with "cannot click." We replace it with a *strictly stricter* DOM-truth check. The new BugKind is a strictly better signal. |
| `clickWithObservation`'s degraded shape for structured selectors hides accessible-name bugs there | Low | Structured selectors are by definition specifying a name (`{role:'button',name:'Save'}`); the absent-name case doesn't apply. Future spec can add observation to the structured path if the planner ever emits unnamed structured selectors. |
| Cluster-signature drift if a new path emits the kind without `selectorClass` set | Low | Task 3 unit tests assert the signature shape. Lint guard via existing `BugDetection` typing. |
| Replay.ts re-runs against the evaluate path and a new failure surfaces | Low | Replay calls `runFormSubmit` for submit (unchanged) and the adapter's `click()` for click — which now takes the evaluate path identically. Replay correctness is preserved by virtue of using the same execute primitives. |
| The evaluate-click path masks a *real* user-visible "click did nothing" bug because the dispatchEvent always returns "fired" even when the page handler errored | Medium | The existing `console_error` / `react_error` / `unhandled_exception` BugKinds capture that. The state-change classifier (`classifyMissingStateChange`) compares pre/post DOM and emits `missing_state_change` when nothing happened. So a click that fires but no-ops still produces a bug. |
| New BugKind is missing from emit / summary writers | Low | Task 3 covers cluster registry. Task 5 (smoke) verifies the kind appears in `summary.json`. If a writer also needs an explicit case statement, Task 0 finds it. |
| `clickWithObservation` API name collides with future `Page.click` semantics | Low | Naming is internal; if it changes, only TabScope consumers (execute.ts) need updating. Single call site. |

---

## §11. Killer-Demo Runbook

After all tasks complete:

```bash
# 1. Land the spec branch + tasks 1-5
cd /tmp/bughunter-spec-v12
git log --oneline spec/v12-click-accessible-name

# 2. Build the CLI
cd /root/BugHunter
pnpm -C packages/cli build

# 3. Smoke run on TraiderJo
cd /tmp/TraiderJo
bughunter run --project . --runId v12-smoke-001 --budget-ms 1200000

# 4. Verify acceptance metrics
RUN_DIR=/tmp/TraiderJo/.bughunter/runs/v12-smoke-001
python3 - <<'PY'
import json
import os
RUN_DIR = os.environ.get('RUN_DIR') or '/tmp/TraiderJo/.bughunter/runs/v12-smoke-001'

inf = [json.loads(l) for l in open(f'{RUN_DIR}/infrastructure.jsonl')]
absent = [f for f in inf if 'no accessible name in snapshot' in f.get('detail','')]
no_match = [f for f in inf if 'No matching ref in snapshot or DOM' in f.get('detail','')]
print(f'Total infra failures: {len(inf)} (target < 5)')
print(f'  ...accessible-name-absent: {len(absent)} (target == 0)')
print(f'  ...no-matching-ref:        {len(no_match)} (target <= 2)')

bugs = [json.loads(l) for l in open(f'{RUN_DIR}/bugs.jsonl')]
new_kind = [b for b in bugs if b.get('kind') == 'interactive_element_missing_accessible_name']
print(f'\\ninteractive_element_missing_accessible_name occurrences: {len(new_kind)} (target >= 14)')

state = json.load(open(f'{RUN_DIR}/state.json'))
clusters = state.get('clusters', [])
new_clusters = [c for c in clusters if c.get('kind') == 'interactive_element_missing_accessible_name']
print(f'interactive_element_missing_accessible_name clusters: {len(new_clusters)} (target 5-15)')

results = state.get('testResults', [])
print(f'\\nTests run: {len(results)} (target == 74)')
PY

# 5. If all green: open PR from spec/v12-click-accessible-name → main
gh pr create --title "v12: single-evaluate click + interactive_element_missing_accessible_name BugKind" \
  --body "$(cat /root/BugHunter/SPEC_V12_CLICK_ACCESSIBLE_NAME.md | head -80)"
```

Demo narrative for the screen-share:

1. **Before:** show `infrastructure.jsonl` from `e8foz9xb1cyv399qk57oa17r` — 20 infra failures, every single one a `click` action with `Element exists in DOM but has no accessible name in snapshot` or `No matching ref in snapshot or DOM`. None of them are real "this app is broken" failures — they are all "BugHunter cannot test this element."
2. **The smoking gun:** read `browser-mcp-snapshot.ts:209-215` (`resolveByHtml`) and explain that the `for` loop over candidate names exits with `null` when the icon-only button has no aria-label, no placeholder, no title, no alt, no textContent. The snapshot pipeline gave up; BugHunter reported "we can't click."
3. **The fix:** show `click-runner.ts` — 150 lines, mirrors `form-submit-runner.ts`. One `scope.evaluate` round-trip. The IIFE does its own visibility check, dispatches the click, and reports back the accessible-name truth from the DOM (not from the snapshot).
4. **The bonus:** show `bugs.jsonl` from the v12 smoke — the same 14 elements that previously caused infra failures are now `interactive_element_missing_accessible_name` BugDetections. The signal is **recovered as a real bug**, not lost.
5. **The math:** 20 → < 5 infra failures. 0 → 5-15 clusters of a meaningful new BugKind. 74 tests run; 0 lost. Coverage went UP, not down.
6. **The takeaway:** *we stopped pretending unnamed buttons couldn't be tested, and started reporting them as the a11y bugs they are.* Two failure modes (infra noise + missing a11y signal) collapsed into one feature.

---

End of spec.
