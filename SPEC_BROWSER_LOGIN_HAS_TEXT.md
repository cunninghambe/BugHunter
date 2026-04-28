# SPEC: Restore evaluate-only modal flow for `:has-text()` selectors in browser-login

Status: draft (not yet implemented)
Owner: @architect
Implementer: @coder
Branch: `spec/browser-login-has-text` (this spec only); implementation lands on a separate branch.

---

## 1. Problem

`/tmp/TraiderJo/surfacemcp.config.json` configures the auth modal trigger as a Playwright text-match selector:

```json
"uiTriggerSelector": "button:has-text(\"log in\")"
```

This is the supported Playwright extension syntax used by the SurfaceMCP authoring guide. BugHunter's selector resolver in `packages/cli/src/adapters/browser-mcp-snapshot.ts` does not recognize `:has-text(...)`. The current `resolveStringSelector` only handles:

- `eN` ref
- `#id`
- `tag[attr="value"]`
- plain `tag`
- `.class` / `:nth-of-type(...)` (signals evaluate fallback in adapter)

`button:has-text("log in")` falls through `resolveStringSelector` and returns `null`. The adapter's evaluate fallback then runs `document.querySelector('button:has-text("log in")')` — which is invalid CSS — and the call ultimately throws `BrowserMcpError('element_not_found')`. `browser-login.ts` swallows that into `tryClick` returning `false` and the function returns `trigger_not_found`.

**Live evidence** (TraiderJo run 2026-04-27):

```
browser_login: skipped (role=owner, reason=trigger_not_found): button:has-text("log in")
```

The crawl proceeds anonymously, vision detection only sees the four public marketing pages (`/`, `/features`, `/pricing`, `/changelog`), and the auth-walled surface where bugs actually live (dashboard, trades, settings) is never reached.

**Regression-confirmation grep**:

```bash
grep -n "ViaEvaluate\|loginViaModal\|has-text" \
  /root/BugHunter/packages/cli/src/discovery/browser-login.ts
# zero hits
```

A previous coder (per task-notification report dated 2026-04-27) implemented an evaluate-only modal flow with helpers `tryClickViaEvaluate` and `loginViaModalEvaluate` that bypassed snapshot resolution entirely. That code is not in `main`. It was likely lost during the action-log persistence rewrite of `phases/execute.ts` (PR #5) and subsequent file-overlapping PRs.

---

## 2. Root cause

Two cooperating defects:

1. **Resolver gap**. `resolveSelectorInSnapshot` does not parse `:has-text("...")` (or `:has-text('...')`).
2. **Snapshot-driven flow is incompatible with modal auth**. Even if the resolver were fixed, `browser.click` and `browser.type` internally call `snapshot()` to resolve the selector. Camofox's `snapshot` tool auto-dismisses overlay dialogs by clicking `button[aria-label="Close"]` — which closes the auth modal between trigger-click and form-fill. Any flow that takes a snapshot after the modal opens is structurally broken on this stack.

The fix must address both: parse `:has-text()` correctly **and** provide a fully evaluate-only path for modal-driven login that never re-snapshots once the modal is open.

---

## 3. Fix design (Option C — extend resolver + evaluate-only modal flow)

### 3.1 Extend the snapshot resolver

Add a parser and a resolver case in `packages/cli/src/adapters/browser-mcp-snapshot.ts`:

```ts
/**
 * Parse Playwright's `tag:has-text("text")` extension into {tag, text}.
 * Accepts double-quote and single-quote forms. Returns null if the input
 * does not match the expected shape.
 *
 * Pure function. No I/O.
 */
export function parsePlaywrightHasText(
  selector: string
): { tag: string; text: string } | null;
```

- Regex: `/^(\w+):has-text\((?:"([^"]+)"|'([^']+)')\)$/`
- Returns `{tag, text}` on match; `null` otherwise.
- Trims neither tag nor text; the input must already be tight.

In `resolveStringSelector`, before the "unknown format" return, add:

```ts
const hasText = parsePlaywrightHasText(selector);
if (hasText) {
  return resolveHasText(hasText.tag, hasText.text, nodes);
}
```

Where `resolveHasText` finds the first node where:
- `node.role === tag.toLowerCase()`, AND
- `(node.name ?? '').toLowerCase().includes(text.toLowerCase())`

Returns `node.ref` or `null` (signal evaluate fallback).

This means existing snapshot-only paths (e.g. dom-walker, replay) continue to work for `:has-text()` selectors when a snapshot is available and the modal-auto-dismiss problem does not apply.

### 3.2 Evaluate-only modal flow in `browser-login.ts`

When the configured `uiTriggerSelector` is a `:has-text()` form, switch the entire fill+submit sequence to evaluate-only operations that never call `browser.click`, `browser.type`, or `browser.snapshot`. This avoids camofox's auto-dismiss.

New private helpers, all in `browser-login.ts`:

```ts
async function tryClickByText(
  browser: BrowserMcpAdapter,
  tag: string,
  text: string
): Promise<boolean>;

async function tryTypeByCssSelector(
  browser: BrowserMcpAdapter,
  cssSelector: string,
  value: string
): Promise<boolean>;

async function tryClickFirstMatchingButton(
  browser: BrowserMcpAdapter,
  candidateTexts: string[]
): Promise<boolean>;
```

Behavior:

**`tryClickByText`** — runs a single `browser.evaluate(script)` call where `script` is built so the page-side function:

1. `const els = Array.from(document.querySelectorAll(tag))`
2. Find first element where `(el.textContent ?? '').toLowerCase().includes(text.toLowerCase())` AND the element is visible (offsetParent !== null OR has nonzero rect — guards against hidden duplicates).
3. If none, return `false`.
4. Otherwise dispatch a real `MouseEvent`:
   ```js
   target.dispatchEvent(new MouseEvent('click', {
     bubbles: true,
     cancelable: true,
     view: window,
     button: 0
   }));
   ```
5. Return `true`.

The function returns `true` if the evaluate result is `true`, `false` otherwise. Never throws (catches its own evaluate errors).

**`tryTypeByCssSelector`** — runs a single `browser.evaluate(script)` where the page-side function:

1. `const el = document.querySelector(cssSelector)` — if not present, return `false`.
2. Use the React-compatible native value setter:
   ```js
   const setter = Object.getOwnPropertyDescriptor(
     window.HTMLInputElement.prototype, 'value'
   ).set;
   setter.call(el, value);
   ```
   For `<textarea>` use `HTMLTextAreaElement.prototype`. The function inspects `el instanceof HTMLTextAreaElement` and picks the correct prototype.
3. Dispatch synthetic input + change events:
   ```js
   el.dispatchEvent(new Event('input', { bubbles: true }));
   el.dispatchEvent(new Event('change', { bubbles: true }));
   ```
4. Return `true`.

**`tryClickFirstMatchingButton`** — given an ordered list of candidate label texts (e.g. `SUBMIT_LABELS`), tries each via `tryClickByText('button', candidate)` and returns on first success. Used as the submit fallback when no `uiSubmitSelector` is configured.

### 3.3 Flow integration

Modify `loginInBrowser` so the post-navigation steps branch:

```
if isHasTextSelector(plan.uiTriggerSelector):
   evaluate-only modal flow
else:
   existing snapshot+adapter flow (unchanged)
```

A helper `isHasTextSelector(selector?: string): boolean` returns `true` iff `selector` is defined and `parsePlaywrightHasText(selector) !== null`.

**Evaluate-only modal flow** (new code path):

1. Click the trigger via `tryClickByText(browser, parsed.tag, parsed.text)`. On `false` return `{ ok: false, reason: 'trigger_not_found', detail: <selector> }`.
2. `await sleep(modalSettleMs)` — see [§7 constants](#7-constants).
3. For each `[credKey, domName]` entry in `plan.fields`:
   - Build the same `fieldCandidates(credKey, domName)` list (CSS selector strings).
   - Walk the list calling `tryTypeByCssSelector(browser, candidate, value)`.
   - First success short-circuits. If none succeeds, return `field_not_found`.
4. Submit button:
   - If `plan.uiSubmitSelector` is a `:has-text()` form, parse and `tryClickByText`.
   - Else if `plan.uiSubmitSelector` is any other CSS selector, attempt `tryClickByCssSelector` (a thin wrapper that calls evaluate with `document.querySelector(...)` then dispatches `MouseEvent`).
   - Else fall back to `tryClickFirstMatchingButton(browser, SUBMIT_LABELS)`.
   - On no match return `submit_not_found`.
5. `verifySuccess` — already evaluate-based via `getCurrentUrl` and the cookie helpers; no change needed. `getCookies` uses `browser.cookies(...)` which does NOT call snapshot, so it is safe to use.

**Existing flow** (unchanged): all other `uiTriggerSelector` shapes — `eN`, `[attr=...]`, `#id`, plain tag, structured `{role,name}`, or absent — continue to use `browser.click` and `browser.type`. The resolver extension from §3.1 means `:has-text()` still works there too if a downstream caller hands in such a selector outside the modal flow.

### 3.4 Why the branch, not always evaluate-only?

The existing snapshot+adapter path has retry-on-`element_not_found` behavior, structured-selector support, dynamic-DOM handling, and is exercised by ~20 tests across the codebase. Replacing it wholesale would expand the change surface and create regression risk in unrelated callers (dom-walker, replay, phases/execute). The branch is narrow: only when the configured selector is unambiguously `:has-text()` do we enter the evaluate-only mode. This limits blast radius and matches the previous coder's approach.

---

## 4. React event compatibility

Why `dispatchEvent(new MouseEvent('click', ...))` instead of `el.click()` or Playwright's `locator.click()`:

- React installs **delegated listeners** on the document/root. Synthetic events fire when the underlying real DOM event bubbles to React's listener.
- `el.click()` on `HTMLElement` does dispatch a click event in modern browsers and React **does** receive it in mainline Chromium. **However**, the previous coder reported (and observed in TraiderJo) that under camofox-mcp + Firefox/Camoufox, `Playwright locator.click()` does not always trigger React's onClick. The empirically reliable path is to construct an explicit `MouseEvent` with `bubbles: true, cancelable: true, view: window` and dispatch it. This guarantees the real DOM event traverses up to React's delegated listener regardless of any focus / pointer-event quirks Playwright applies.
- For inputs, React 16+ tracks the previous value on the DOM node and uses an `Object.defineProperty` shim around `value` to bypass writes that don't go through React. Setting `el.value = x` directly is a "silent" write — React's input tracking thinks the value did not change and ignores subsequent input events. The fix is to call the **prototype's** native value setter (which React's shim doesn't intercept), then dispatch synthetic `input` and `change` events. This is the canonical pattern for testing-library-style direct DOM manipulation against React.

These choices are load-bearing — do not "simplify" to `el.click()` or `el.value = x` during implementation.

---

## 5. Camofox snapshot auto-dismiss workaround

Camofox-mcp's `snapshot` tool implementation runs accessibility-tree extraction with a dialog auto-dismiss step that calls `page.locator('button[aria-label="Close"]').click()` on any visible overlay. This is intended to suppress consent banners and cookie modals so the snapshot is meaningful. It also indiscriminately closes our auth modal whenever it appears.

**Constraint**: between the trigger click and a successful submit-and-verify, the implementation MUST NOT call `browser.snapshot()`. By extension, it MUST NOT call `browser.click(selector)` or `browser.type(selector)` for any selector that is not already an `eN` ref, since those internally take a fresh snapshot. The only safe browser operations during the modal-open window are:

- `browser.evaluate(script)`
- `browser.cookies(urls)`
- `browser.navigate(url)` (would close modal but that's expected if needed)

The evaluate-only flow in §3.2 satisfies this constraint. Document this constraint as an inline comment in `loginInBrowser` near the branch entry so future maintainers do not re-introduce a snapshot call.

---

## 6. Files to touch

### Modify
- `packages/cli/src/adapters/browser-mcp-snapshot.ts`
  - Add exported `parsePlaywrightHasText`.
  - Extend `resolveStringSelector` to dispatch to a new internal `resolveHasText`.
  - No public-API removals.
- `packages/cli/src/discovery/browser-login.ts`
  - Add `tryClickByText`, `tryClickByCssSelector`, `tryTypeByCssSelector`, `tryClickFirstMatchingButton`, `isHasTextSelector` helpers.
  - Refactor `loginInBrowser` post-navigation steps to branch on `isHasTextSelector(plan.uiTriggerSelector)`.
  - Existing exported signature unchanged.

### Add (test files)
- `packages/cli/src/adapters/browser-mcp-snapshot.test.ts` — NEW. Currently no test file for this module. Cover both pre-existing functions and new ones (see §8.1).
- Extend `packages/cli/src/discovery/browser-login.test.ts` — add cases for the `:has-text()` branch (see §8.2).

### Do NOT
- Do NOT modify `packages/cli/src/adapters/browser-mcp.ts`. The `click`/`type`/`resolveRef` logic is correct for the non-`:has-text` path and is exercised by callers we are not touching.
- Do NOT add a new `:has-text()` adapter method. The branch lives in `browser-login.ts` because the constraint (no snapshot during modal-open) is specific to that flow.
- Do NOT change `phases/execute.ts`, `dom-walker.ts`, or `replay.ts`. Out of scope.
- Do NOT add new dependencies.
- Do NOT introduce `as any`. All new code under strict TS.
- Do NOT silently catch errors anywhere except the helper-returns-bool wrappers (which catch and return `false`, with a `log.warn` for the error message).

---

## 7. Constants

Add as `const` near the top of `browser-login.ts`:

```ts
const MODAL_SETTLE_MS = 250;        // existing post-trigger sleep, unchanged
const FIELD_SETTLE_MS = 50;         // pause between field-fills (allow React state)
const SUBMIT_SETTLE_MS = 50;        // pause after value-set, before submit click
```

`MODAL_SETTLE_MS` matches the existing `await sleep(250)` after trigger click. `FIELD_SETTLE_MS` and `SUBMIT_SETTLE_MS` are new but small. If empirical testing on TraiderJo shows the modal needs longer to mount, raise to 500 — flag it in the implementation PR description, do not change without measurement.

---

## 8. Test plan

### 8.1 Unit — `browser-mcp-snapshot.test.ts` (new file)

Cover the new parser and resolver case. Pure functions, no mocks needed.

```ts
describe('parsePlaywrightHasText', () => {
  it('parses double-quoted form');         // 'button:has-text("log in")' -> {tag:'button', text:'log in'}
  it('parses single-quoted form');         // "button:has-text('log in')"
  it('returns null for plain tag');         // 'button'
  it('returns null for #id selector');     // '#submit'
  it('returns null for tag[attr=val]');    // 'button[type="submit"]'
  it('returns null for malformed has-text'); // 'button:has-text(log in)' (no quotes)
  it('returns null for non-tag prefix');   // ':has-text("log in")' (missing tag)
  it('preserves text case');               // 'button:has-text("Log In")' -> text:'Log In'
});

describe('resolveSelectorInSnapshot — :has-text()', () => {
  // Shared snapshot fixture with three buttons: "Log In", "Sign Up", "Help"
  it('matches button by accessible name (case-insensitive substring)');
  it('returns null when no role match');
  it('returns null when role matches but name does not');
  it('does not affect existing eN/#id/tag-attr resolution');  // regression guard
});
```

Also include focused tests for the existing functions if missing — `parseSnapshot`, `resolveSelectorInSnapshot` for each existing branch, `resolveByHtml`. Keep unit-only; no live calls.

### 8.2 Unit — extend `browser-login.test.ts`

Add a new `describe` block:

```ts
describe('loginInBrowser — :has-text() modal flow', () => {
  it('clicks trigger via evaluate when uiTriggerSelector is :has-text()');
  it('types into fields via evaluate (CSS selector candidate match)');
  it('does NOT call browser.snapshot at any point');         // critical — auto-dismiss guard
  it('does NOT call browser.click for trigger or submit');   // it should be evaluate-only
  it('clicks submit via :has-text() submit selector when configured');
  it('clicks submit via SUBMIT_LABELS fallback when no uiSubmitSelector');
  it('returns trigger_not_found when evaluate reports no match');
  it('returns field_not_found when no field candidate matches in DOM');
  it('returns submit_not_found when no submit text matches');
  it('preserves cookie verification path (verifySuccess unchanged)');
});
```

Mock `browser.evaluate` to inspect the script body via regex assertions. Verify the script contains:
- `dispatchEvent(new MouseEvent('click'`
- `Object.getOwnPropertyDescriptor` ... `value` ... `set.call(`
- `dispatchEvent(new Event('input'`
- `dispatchEvent(new Event('change'`

Existing tests in `browser-login.test.ts` MUST still pass without modification. They use selectors like `'button[data-trigger]'` and `'#missing-trigger'` which are not `:has-text()` and route through the existing flow.

### 8.3 Integration — TraiderJo live target

After implementation, run the exact command from the user brief:

```bash
cd /tmp/TraiderJo
TRAIDERJO_OWNER_PASSWORD=WDxerx3WKj2wHEAXAa1! \
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /root/Aspectv3/apps/web/.env.local | cut -d= -f2) \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --max-bugs 10 --max-runtime 360000 --concurrency 2 --api-concurrency 4
```

Expected log lines (in order):

```
browser_login: success (role=owner, cookies=>=1, url=...)
crawler: discovered N pages (N >= 5; auth-walled routes appear)
vision: baseline captured for >= 5 pages
```

If `browser_login: success` appears but the crawler still only sees 4 pages, that is a separate crawler issue — flag it in the implementation report but do not fix in this spec.

---

## 9. Acceptance criteria

Concrete, observable. The implementation is complete when ALL of the following hold:

1. `grep -n "parsePlaywrightHasText\|tryClickByText\|tryTypeByCssSelector" packages/cli/src/` returns matches in both `browser-mcp-snapshot.ts` and `browser-login.ts`.
2. `npx tsc --noEmit` passes with zero errors.
3. `npx eslint . --max-warnings 0` passes.
4. `npx vitest run` passes — all existing tests plus new tests in §8.1 and §8.2.
5. The TraiderJo live run from §8.3 logs `browser_login: success (role=owner, cookies=N>=1, url=...)`.
6. The TraiderJo crawl visits at least one of `/dashboard`, `/trades`, or `/settings` (auth-walled routes), observable in run logs as page-discovery events.
7. Vision baseline runs on more than 4 pages on the TraiderJo target.
8. No call to `browser.snapshot` or `browser.click(stringSelector)` / `browser.type(...)` occurs in the `:has-text()` branch — verified by unit-test mocks asserting these methods are not invoked during that flow.
9. All existing browser-login tests pass without modification.

---

## 10. Risk

- **R1 — visibility heuristic false-negatives**. A button technically rendered but with `display:none` or `visibility:hidden` may still pass `offsetParent !== null` in some CSS-engine quirk modes. Mitigation: in the visibility check, combine `offsetParent !== null` with `getBoundingClientRect()` having nonzero width and height.
- **R2 — TextContent-includes false positives**. Two buttons containing the substring "log in" (e.g. "log in" and "log in with Google") could match the wrong one. Mitigation: prefer exact match (case-insensitive trim equality) on the first pass; fall back to substring on the second pass. Document the order.
- **R3 — React 18 strict mode double invocation**. The native value setter approach is React 16/17/18 compatible and unaffected by strict-mode double-render — strict mode affects React internals, not DOM event dispatch. No mitigation required.
- **R4 — Camofox snapshot auto-dismiss may change**. If the upstream camofox-mcp later removes the auto-dismiss behavior, the evaluate-only branch is still correct (just no longer strictly necessary). No code change required.
- **R5 — Other callers using `:has-text()`**. The resolver extension in §3.1 means dom-walker / replay / execute can now resolve `:has-text()` against snapshots. They will route through the existing snapshot path, which is correct as long as the modal-auto-dismiss issue is not relevant outside `loginInBrowser`. Check whether any other caller currently passes `:has-text()` selectors — `git grep "has-text"` across the repo. If yes, that caller needs to opt into the evaluate path. Currently no such callers exist (verified by grep).

---

## 11. Open questions

- **OQ1**. Should the `submit` button helper try the configured `uiSubmitSelector` literally (CSS) before parsing as `:has-text()`? Current spec says: parse first, fall back to literal CSS. This matches the trigger handling. Confirming this mirrors the previous coder's approach if their notes are recovered.
- **OQ2**. Should `tryClickByText` retry once after a 100ms delay if the first evaluate returns `false`, to handle late modal-mount? Current spec says no — the `MODAL_SETTLE_MS = 250` after trigger should suffice. Add a single retry only if TraiderJo live testing shows flakiness.

These are flagged for the implementer to surface during PR review, not blockers.

---

## 12. Implementation task breakdown

**Task 1 — Resolver extension** (single file, ~40 LOC, ~20 min)
- Files: `packages/cli/src/adapters/browser-mcp-snapshot.ts`
- Add `parsePlaywrightHasText` (export).
- Extend `resolveStringSelector` with the new branch.
- Done when: §8.1 unit tests pass.

**Task 2 — Snapshot resolver tests** (new file, ~80 LOC, ~20 min)
- Files: `packages/cli/src/adapters/browser-mcp-snapshot.test.ts` (new)
- Implement §8.1.
- Done when: `npx vitest run packages/cli/src/adapters/browser-mcp-snapshot.test.ts` passes.

**Task 3 — Evaluate-only helpers** (single file, ~120 LOC, ~30 min)
- Files: `packages/cli/src/discovery/browser-login.ts`
- Add `isHasTextSelector`, `tryClickByText`, `tryClickByCssSelector`, `tryTypeByCssSelector`, `tryClickFirstMatchingButton`.
- Add a `:has-text()` branch in `loginInBrowser`.
- Done when: TS compiles, helpers are exported only as needed (most should be private), branch routing works on a manual smoke.

**Task 4 — Browser-login tests for the new branch** (~80 LOC, ~25 min)
- Files: `packages/cli/src/discovery/browser-login.test.ts`
- Add the `describe` block from §8.2.
- Verify zero `browser.snapshot` / `browser.click` calls in the `:has-text()` flow.
- Done when: `npx vitest run packages/cli/src/discovery/browser-login.test.ts` passes including the new block.

**Task 5 — Live verification on TraiderJo** (~15 min)
- Run the command in §8.3.
- Capture log evidence of `browser_login: success`.
- Capture page-discovery log lines showing auth-walled pages reached.
- Done when: §9 acceptance criteria 5–7 satisfied.

Tasks 1–4 are independently testable and committable. Each task gets its own commit. Task 5 is verification only — no code changes.

---

## 13. Summary

The `browser-login.ts` regression is two failures stacking: a missing `:has-text()` parser and a snapshot-driven flow that fights camofox's auto-dismiss. Fix both: extend the snapshot resolver for the general case, and add a narrow evaluate-only branch in `loginInBrowser` for `:has-text()` triggers. The evaluate path uses real `MouseEvent` dispatch (not `el.click()`) and the React-prototype-setter pattern (not direct `el.value =`) to remain compatible with React's synthetic event system. No new dependencies, no public API changes, no schema impact.
