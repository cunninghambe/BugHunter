# SPEC — v0.41 "Mobile / responsive"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.17 multi-viewport (merged), `set_viewport` MCP tool (PR #45) · **Roadmap slot:** `SPEC_PATH_TO_EXHAUSTIVE.md` §3.6, Phase E.

This spec adds a `--mobile` mode that re-runs the existing test plan against camofox configured with mobile user-agent strings + iOS/Android viewport dimensions, and introduces six new mobile-specific BugKinds. It builds directly on v0.17's per-viewport screenshot loop (`screenshotPhase` in `phases/discover.ts`) and the `setViewport` adapter method — nothing here replaces existing infrastructure; it composes a mobile-flavoured suite alongside the desktop suite.

The motivating gap: vibe-coded apps almost universally ship with desktop-only assumptions. `100vh`, `:hover`, fixed-position headers, narrow-target tap regions, and uncoordinated soft-keyboard handling all degrade silently on phones. None of them surface in BugHunter today because every viewport BugHunter runs at is ≥ 375 px AND has a desktop UA AND has no virtual keyboard. v0.41 closes that.

---

## 1. Objective

Add a `--mobile` flag (and `mobile` config block) that:

1. Configures camofox with a mobile UA + mobile viewport for the duration of the run (or the duration of a `--mobile`-suffixed second pass).
2. Adds six new BugKinds with end-to-end detectors:
   - `touch_target_too_small` — axe `target-size` rule, scoped to mobile viewports.
   - `hover_only_affordance` — static CSS scan: `:hover`-bound interactive elements with no `:focus`/`:active`/touch-equivalent.
   - `viewport_100vh_break` — `100vh` (or `vh`-anchored fixed layout) breaks the iOS viewport.
   - `soft_keyboard_occlusion` — virtual-keyboard inset hides the input being typed.
   - `orientation_change_layout_break` — landscape↔portrait reflow loses layout integrity or component state.
   - `pull_to_refresh_conflict` — `touchstart`/`touchmove` listeners on scroll containers conflict with browser PTR gesture.
3. Wires the new BugKinds into the existing detection→cluster→summary pipeline. No bespoke runner; mobile mode IS the existing runner under a different camofox configuration.

**In scope:**
- New `mobile` config block in `BugHunterConfig` (Zod-validated) and matching `--mobile`/`--mobile-*` CLI flags.
- New `--mobile` execution mode that injects UA + viewport before any other phase begins.
- Six new BugKinds added to `BugKind` union, `bugIdentity` clustering, and `summary.json` rollups.
- Five new detectors (one per non-trivial BugKind; `touch_target_too_small` is just an additional axe rule with mobile-viewport scoping).
- Soft-keyboard simulation via CDP `Emulation.setDeviceMetricsOverride` + a synthesized inset.
- Hover-only-affordance static analysis as a new `static/tools/hover-only-affordance.ts`.

**Out of scope (deferred):**
- Real-device cloud testing (Sauce, BrowserStack). v0.41 stays in camofox.
- Native gesture replay (pinch-to-zoom, swipe-back). `pull_to_refresh_conflict` is detected statically (event-listener inspection); we do not synthesize a real downward swipe at the system layer in v0.41.
- Tablet-specific viewports (768–1023 logical pixels). v0.17's 768 px is sufficient for tablet portrait; tablet-flavoured UA + landscape goes to v0.42 if a target demands it.
- Mobile network throttling (3G/4G profiles). Lives in v0.6 perf if/when needed.
- Battery-saver / reduced-motion / data-saver modes. Lives in §3.1 browser-platform surface (separate V-spec).
- iOS Safari-specific quirks beyond viewport-height (sticky-position interaction with toolbars, momentum scrolling). Detected only insofar as they fall under the six BugKinds above.

**Acceptance target on Aspectv3:**
With `bughunter run --mobile --a11y --a11y-strict` against Aspectv3, a representative vibe-coded SPA, the next smoke produces:
- ≥ 1 `touch_target_too_small` cluster on at least one mobile viewport.
- ≥ 1 `hover_only_affordance` cluster from static CSS scan (Aspectv3's button hover styles do not pair with `:focus` on every interactive).
- 0 `mobile_mode_setup_failed` skipped reasons in `summary.json.skippedReasons` (mode initialized cleanly).
- `summary.json.mobile.viewportMatrix` reports the three viewports actually exercised.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union (line 23), `VisionConfig.viewports` (line 415). Add to BOTH. Do NOT fork. |
| `packages/cli/src/config.ts` | `BugHunterConfigSchema`. Add the new `mobile` Zod object alongside `vision` (line 106) and `bundleProbe` (line 138). |
| `packages/cli/src/cli/run.ts` | Flag parsing + config-merge (line 130-162 area). Add `--mobile`, `--mobile-viewport`, `--mobile-ua` here. |
| `packages/cli/src/cli/main.ts` | USAGE string (line 18) — append a "Mobile / responsive" section. Flag parser (line 74) is permissive; no change there. |
| `packages/cli/src/adapters/browser-mcp.ts` | `setViewport` (line 481) is your foundation. Add a sibling `setUserAgent(ua)` and `setVirtualKeyboardInsets(bottomPx)` — both optional, both with `mcpCall` + fallback. |
| `packages/cli/src/adapters/cdp-session.ts` | Where the playwright-core CDP entry point lives. `Emulation.setDeviceMetricsOverride` is the soft-keyboard simulation hook; add a method `overrideViewportInsets(bottomPx)` here. |
| `packages/cli/src/phases/discover.ts` | `screenshotPhase` (line 320) iterates viewports with `setViewport`. Hook the mobile-mode UA injection BEFORE this loop, and reuse the same loop structure with mobile viewports. |
| `packages/cli/src/classify/accessibility.ts` | `AXE_RUN_SCRIPT` (line 14). Extend with `target-size` rule when in mobile mode. |
| `packages/cli/src/classify/a11y-baseline.ts` | `classifyA11yBaseline` (line 49). Add a branch for `target-size` violations → `touch_target_too_small`. |
| `packages/cli/src/static/runner.ts` | Static-tool runner orchestrator. Register the new `hover-only-affordance` tool here. |
| `packages/cli/src/static/tools/eslint-no-empty.ts` | Pattern for a single static tool: input = file paths, output = `BugDetection[]`. Mirror this shape for `hover-only-affordance.ts`. |
| `packages/cli/src/phases/discover.test.ts` (line 262 onward) | v0.17 multi-viewport test pattern. Mirror for v0.41 mobile-mode tests. |

### 2.2 Patterns to follow

- **`BugKind` union extension.** Add the six new kinds to the existing union; do not fork. Update `bugIdentity` (in `cluster.ts`) clustering keys if a new kind requires a new identity field — for v0.41, the `(kind, pageRoute, selectorClass)` triple suffices for all six.
- **Adapter optionality.** All new adapter methods (`setUserAgent`, `setVirtualKeyboardInsets`) follow the v0.17 `setViewport` pattern: declared optional on the interface, present on the concrete `CamofoxBrowserMcpAdapter`, and gated at call sites with `if (browser.foo !== undefined)`.
- **Discriminated unions on adapter results.** `{ ok: true } | { ok: false; reason: string }` — same as `setViewport`. Caller logs warn on `ok:false`, skips the affected phase, run continues.
- **Static-tool shape.** A static tool exports `runFooTool(opts): Promise<BugDetection[]>`. Wired in `static/runner.ts` behind a feature flag. CSS scanning uses Node-side parsing (no browser eval); reuse the `postcss` dep already present (verify in `package.json`; if absent, add as exact-pinned dep with bundle-size justification — postcss is ~70 KB gzipped).
- **Mobile-mode entry.** A single helper `applyMobileMode(browser, mobileConfig): Promise<{ ok: true } | { ok: false; reason: string }>` is invoked once after browser-login and before discovery. Its inverse `clearMobileMode(browser)` runs in the run-cleanup phase (use the existing cleanup hook in `phases/emit.ts`).
- **Telemetry rollup.** `summary.json.mobile = { enabled, ua, viewports, viewportsExercised, mobileBugCounts: {kind: count} }`. Mirrors the existing `vision` and `perf` rollups.

### 2.3 DO NOT

- Do **not** create a new `phases/mobile-runner.ts`. Mobile mode reuses the existing runner; only the camofox configuration changes.
- Do **not** make `--mobile` mutually exclusive with `--multi-viewport` (v0.17). They compose. If both are set, mobile viewports are appended to the v0.17 viewport list, NOT replaced. (See EC-12.)
- Do **not** add new `webkit`-specific code paths. camofox is Firefox-Camoufox; mobile UA is just a header. iOS-specific quirks are simulated via UA + viewport, not via a real Safari engine. Document this explicitly in the spec output.
- Do **not** parse JS event handlers inline-on-attributes (`<div onclick="...">`) for `hover_only_affordance`. v0.41 is CSS-pseudo-class-only. JS-side hover handlers (`element.addEventListener('mouseenter', ...)`) are deferred to v0.42.
- Do **not** decode the CSS @ each `:hover` rule with regex. Use `postcss` AST walk. Regex CSS parsing on real-world stylesheets is a guaranteed false-positive farm.
- Do **not** dispatch synthetic `touchstart`/`touchmove` events as the mechanism for `pull_to_refresh_conflict`. The detector is event-listener inventory + scroll-container heuristics, not gesture simulation. (See §4.6.)
- Do **not** change `setViewport`'s contract. Add new methods alongside.
- Do **not** add a new dependency for UA-string generation. UA strings are static constants in `packages/cli/src/static/mobile-ua.ts` (a new file).
- Do **not** treat `100vh` in JS computed-style as the detector for `viewport_100vh_break`. The detector is: at iOS viewport (390x844), capture page height; capture again with simulated bottom inset (Safari toolbar = 84px); diff. Scroll-jump or content-clip ⇒ break. (See §4.3.)

---

## 3. Schema additions

### 3.1 `BugKind` union (`packages/cli/src/types.ts`, line 23)

Append (in this order, after `seo_robots_blocking_crawl`):

```ts
  // v0.41 mobile / responsive kinds
  | 'touch_target_too_small'
  | 'hover_only_affordance'
  | 'viewport_100vh_break'
  | 'soft_keyboard_occlusion'
  | 'orientation_change_layout_break'
  | 'pull_to_refresh_conflict';
```

### 3.2 `MobileConfigSchema` (`packages/cli/src/config.ts`, alongside `vision` block)

```ts
const MobileViewportSchema = z.object({
  width: z.number().int().min(320).max(480),
  height: z.number().int().min(568).max(1024),
  /** Logical device label; appears in summary.json. */
  label: z.string().min(1),
  /** Either 'ios' or 'android'; selects matching default UA + simulated insets. */
  platform: z.enum(['ios', 'android']),
});

const MobileConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Override the default UA. If omitted, picked from platform of the first viewport. */
  userAgent: z.string().min(1).optional(),
  /** Defaults to all three: iPhone SE (375x667), iPhone 14 (390x844), Pixel 7 (412x915). */
  viewports: z.array(MobileViewportSchema).min(1).max(6).default([
    { width: 375, height: 667, label: 'iphone-se',  platform: 'ios' },
    { width: 390, height: 844, label: 'iphone-14',  platform: 'ios' },
    { width: 412, height: 915, label: 'pixel-7',    platform: 'android' },
  ]),
  /**
   * Soft-keyboard simulation strategy. 'cdp' uses Emulation.setDeviceMetricsOverride
   * with a `viewport.scale` adjustment + simulated bottom inset (visualViewport.height
   * narrowing). 'none' disables soft-keyboard occlusion detection but keeps the rest of
   * mobile mode running. Default: 'cdp' when CDP is reachable, 'none' otherwise.
   */
  softKeyboard: z.enum(['cdp', 'none']).default('cdp'),
  /** Pixel height of the simulated virtual keyboard. iOS = 271, Android = 312 (default). */
  keyboardHeightPx: z.number().int().min(180).max(400).default(271),
  /** Probe orientation change once per page (portrait → landscape → portrait). */
  orientationChange: z.boolean().default(true),
  /** Static analysis: scan CSS bundle for hover-only affordances. */
  hoverOnlyScan: z.boolean().default(true),
});
```

Wired into `BugHunterConfigSchema` immediately after `vision`:

```ts
  vision: z.object({ /* ... */ }).optional(),
  mobile: MobileConfigSchema.optional(),
  perf: z.object({ /* ... */ }).optional(),
```

### 3.3 CLI flags (`packages/cli/src/cli/run.ts` and `main.ts`)

| Flag | Purpose | Default |
|---|---|---|
| `--mobile` | Enable mobile mode (sets `mobile.enabled=true`) | false |
| `--mobile-viewport <label>` | Limit to one viewport by label (`iphone-se`, `iphone-14`, `pixel-7`) | all three |
| `--mobile-ua <string>` | Override UA string | platform default |
| `--mobile-no-soft-keyboard` | Disable soft-keyboard simulation | enabled |
| `--mobile-no-orientation` | Disable orientation-change probe | enabled |
| `--mobile-no-hover-scan` | Disable hover-only-affordance static scan | enabled |
| `--mobile-keyboard-height <px>` | Override simulated keyboard height | 271 |

USAGE block addition (`packages/cli/src/cli/main.ts`):

```
Mobile / responsive (v0.41):
  --mobile                       Enable mobile mode (mobile UA + viewport + a11y rules)
  --mobile-viewport <label>      Limit to single viewport (iphone-se|iphone-14|pixel-7)
  --mobile-ua <ua>               Override mobile user-agent string
  --mobile-no-soft-keyboard      Disable soft-keyboard occlusion detector
  --mobile-no-orientation        Disable orientation-change layout-break detector
  --mobile-no-hover-scan         Disable hover-only-affordance static scan
  --mobile-keyboard-height <px>  Simulated virtual keyboard height (default 271)
```

### 3.4 `summary.json` rollup

Add to the run summary (in `phases/emit.ts` summary-builder):

```ts
mobile?: {
  enabled: boolean;
  ua: string;                              // resolved UA actually used
  viewports: Array<{label: string; width: number; height: number; platform: string}>;
  viewportsExercised: string[];            // labels actually run (vs configured)
  mobileBugCounts: Record<MobileBugKind, number>;
  softKeyboardSupported: boolean;
  orientationProbed: number;               // count of pages probed
}
```

`MobileBugKind` is a type alias of the six v0.41 kinds.

---

## 4. Per-BugKind detector specs

Each BugKind gets one `## 4.N` subsection covering the signal, the detector location, the false-positive guard, and an explicit example.

### 4.1 `touch_target_too_small`

**Signal.** axe-core's `target-size` rule (WCAG 2.5.5 / 2.5.8) flags interactive elements (`button`, `a`, `input`, `[role=button]`, etc.) with a target dimension < 24 px (AA) or < 44 px (AAA). v0.41 uses 24 px.

**Detector.** Extend `AXE_RUN_SCRIPT` to include `target-size` in `runOnly.values`. Extend `classifyA11yBaseline` with a new branch:

```ts
} else if (violation.id === 'target-size') {
  for (const node of violation.nodes) {
    const sel = selectorFromNode(node);
    detections.push({
      kind: 'touch_target_too_small',
      rootCause: `Touch target below 24×24 px (WCAG 2.5.5 AA) at ${sel}`,
      pageRoute,
      selectorClass: sel,
      a11yContext: { axeRuleId: 'target-size' },
    });
  }
}
```

**Scoping.** Only fire when the active viewport is in the mobile set. At desktop viewports, target-size is informational — do not emit. Implementation: `classifyA11yBaseline` takes a `viewportContext: { width: number; isMobile: boolean }` parameter; the new branch checks `isMobile` before pushing.

**False-positive guards.**
- Skip elements with `aria-hidden="true"` or `tabindex="-1"`.
- Skip elements whose computed bounding rect is `display:none` (axe already excludes these; verify with a unit test).
- A target ≥ 24 px in EITHER axis with a click area extended via `::before`/`::after` pseudo (common pattern for icon buttons) is NOT detected by axe alone; we accept the under-detection rather than false-positive on `::before` extensions. Documented limitation.

**Example.** `<button class="icon-btn">` rendered at 16x16 px with no padding extension → fires.

### 4.2 `hover_only_affordance`

**Signal.** A CSS rule attaches an interactive-relevant property (`background-color`, `color`, `transform`, `display`, `visibility`, `opacity`) to a `:hover` selector for an interactive element (`button`, `a`, `[role=button]`, `[onclick]`, `input`, `select`), AND no rule with `:focus` or `:active` on the same selector base provides an equivalent affordance.

**Detector.** New file `packages/cli/src/static/tools/hover-only-affordance.ts`. Runs Node-side, no browser involvement. Inputs: list of CSS file paths discovered under `.next/static/css/`, `dist/assets/*.css`, `build/static/css/*.css`, plus `<style>` tags scraped from rendered HTML during discovery. Output: `BugDetection[]`.

Algorithm (postcss AST walk):
1. Parse each CSS file with `postcss`.
2. Walk every selector list. For each selector containing `:hover`:
   a. Compute `baseSelector` by stripping `:hover` (and any directly-adjacent state pseudos like `:hover:not(.disabled)`).
   b. Inspect the rule's declarations. If none of them are in the "interactive-relevant" property allowlist, skip.
   c. Look for a sibling rule (anywhere in the same stylesheet) whose selector list contains `baseSelector` + `:focus` OR `baseSelector` + `:active`, with overlapping properties.
   d. If `baseSelector` matches an "interactive selector heuristic" (regex: `\bbutton\b|\ba\b|\b\[role=["']?button["']?\]|\b\[onclick\]|\binput\b|\bselect\b|\.btn\b|\.button\b`) AND no `:focus`/`:active` sibling with matching properties exists, emit:

```ts
{
  kind: 'hover_only_affordance',
  rootCause: `:hover styles on interactive selector "${baseSelector}" with no :focus/:active equivalent (touch users see no feedback)`,
  pageRoute: '<static>',  // CSS scan is route-agnostic
  selectorClass: baseSelector.slice(0, 80),
  staticContext: { cssFile: relPath, lineNumber: rule.source?.start?.line },
}
```

**False-positive guards.**
- Reset/baseline rules (`* { ... }`, `body`, `html`, `:root`) are excluded.
- `:hover` rules whose ONLY property is `cursor: pointer` are excluded — visual-cursor-only is a no-op on touch.
- `:hover` rules inside `@media (hover: hover)` or `@media (pointer: fine)` are explicitly correct mobile usage; SKIP. Detect by walking parent at-rules.
- If the rule sits inside `@media (max-width: <X>)` where X < 768, it's a mobile-only rule that probably should not exist; we still emit, but tag with a `mediaQueryContext` field.

**Example.** Aspectv3 ships `apps/web/src/components/Button.css` with `.btn:hover { background: #2563eb; }` and no matching `:focus`. Detector fires once per matched base selector per CSS file. Cluster-key dedup folds duplicates from multiple stylesheets.

**Limitation.** v0.41 does not detect JS-side hover handlers. Documented in `--help` and roadmap.

### 4.3 `viewport_100vh_break`

**Signal.** On iOS Safari, `100vh` represents the viewport WITHOUT subtracting the dynamic toolbar (URL bar at top, action toolbar at bottom). When the toolbar appears (any scroll), elements sized to `100vh` extend beyond the visible area → critical content (CTA, sticky footer) gets clipped.

**Detector.** Two-shot capture during `screenshotPhase` when `mobile.enabled === true`:

1. **Shot A:** at mobile viewport (e.g. 390x844, iPhone-14). Capture page-height via `browser.evaluate('document.documentElement.scrollHeight')`.
2. **Shot B:** simulate the iOS toolbar reveal by calling `browser.setVirtualKeyboardInsets(0)` followed by `browser.setViewport(width, height - 84)` — 84 px is iOS Safari's combined top-toolbar + bottom-toolbar height. Re-capture page-height.
3. **Compare:**
   - If Shot B's `scrollHeight === Shot A's scrollHeight` AND any element with computed `height: 100vh` or `min-height: 100vh` is present, emit `viewport_100vh_break` because the page didn't reflow but a `100vh` element is now mis-sized.
   - If a `position: fixed; bottom: 0; height: 100vh;` (or similar) element OVERLAPS the simulated visible region (top of element < `height - 84`), emit.

The "any element with `100vh`" check is a single `evaluate`:

```ts
Array.from(document.querySelectorAll('*')).filter(el => {
  const cs = getComputedStyle(el);
  return cs.height.endsWith('vh') || cs.minHeight.endsWith('vh');
}).map(el => ({selector: cssPathOf(el), height: getComputedStyle(el).height}));
```

`cssPathOf` is a vendored 30-line helper (already present in `packages/cli/src/util/dom-path.ts` if v0.7 ships it; otherwise add it).

**False-positive guards.**
- `.modal`, `.dialog`, `[role=dialog]` on `100vh` is intentional (full-screen modal). Skip elements whose ARIA role indicates dialog.
- Viewport units inside `@media (min-width: 768px)` blocks don't apply at mobile sizes — use computed style at the active viewport, not source style.
- Skip elements with `height: 100vh` AND `position: relative` — they reflow correctly; the bug is `position: fixed` + `100vh`.

**Detector location.** `packages/cli/src/perf/viewport-100vh-detector.ts` (new file). Runs inside `screenshotPhase` only when in mobile mode; emits via `BugDetection[]` returned to the discovery aggregator.

### 4.4 `soft_keyboard_occlusion`

**Signal.** When a virtual keyboard appears on focus of a text input, the input being typed should remain visible (browser auto-scroll OR developer-implemented scroll-into-view). If the input is below `viewport.height - keyboardHeightPx`, the user can't see what they're typing.

**Detector.** New file `packages/cli/src/perf/soft-keyboard-detector.ts`. Runs once per discovered form, only when in mobile mode AND `mobile.softKeyboard === 'cdp'`.

Algorithm:
1. For each form on each mobile viewport:
   a. Navigate to the form's page.
   b. For each input in the form:
      - Capture input's `getBoundingClientRect().top + height` (= input bottom, in viewport coords).
      - Call `browser.setVirtualKeyboardInsets(keyboardHeightPx)` (CDP `Emulation.setDeviceMetricsOverride` with `mobile=true` + a synthesized `screenOrientation` + a deduction from viewport height).
      - Trigger focus on the input (`element.focus()`).
      - Wait for `settleMs` (default 200).
      - Capture input's `getBoundingClientRect().top + height` AGAIN.
   c. After focus, the input bottom MUST be within `(viewport.height - keyboardHeightPx)`.
   d. If not, emit `soft_keyboard_occlusion` with `selectorClass = inputSelector`.
   e. Always `setVirtualKeyboardInsets(0)` after the probe to restore.

**Implementation detail.** Camofox v0.1 does NOT have a virtual-keyboard MCP tool. `setVirtualKeyboardInsets` on the adapter:
- Tries `mcpCall('set_virtual_keyboard', { tabId, height })` (in case a future camofox build adds it).
- Falls back to direct CDP via `cdp-session.ts`'s `Emulation.setDeviceMetricsOverride` with `width`, `height = viewport.height - keyboardHeightPx`, `deviceScaleFactor = 2`, `mobile = true`. This is NOT a perfect simulation — it shrinks the viewport but doesn't fire a real `visualViewport.resize` event the way iOS does. We compensate by also calling `window.visualViewport.dispatchEvent(new Event('resize'))` via `evaluate` (some apps listen for this; many don't). Document the imperfection.
- If both fail, return `{ ok: false, reason: 'no_keyboard_simulation_available' }`. Caller skips the detector and adds `mobile_soft_keyboard_unavailable` to `summary.json.skippedReasons`.

**False-positive guards.**
- Skip inputs with `type="hidden"`.
- Skip inputs inside elements with `display: none`.
- Skip inputs that are programmatically scrolled into view by the app's own focus handler (post-focus, if input bottom moves up by ≥ 40 px, the app handled it). Detector uses the post-focus position, not the pre-focus position, for the comparison.
- Skip iframes and shadow DOM inputs (out of scope for v0.41; document).

### 4.5 `orientation_change_layout_break`

**Signal.** Rotating the device portrait→landscape (or vice versa) should reflow gracefully. Common bugs: state lost (selected items, modal open status, scroll position to a key element), elements clipped because of fixed-width breakpoint mistakes, `100vw` overflow horizontally.

**Detector.** Inside `screenshotPhase`, additional pass when `mobile.orientationChange === true`:

1. At a mobile viewport (start with iphone-14 portrait 390x844):
   a. Establish state markers: capture (i) full-page screenshot, (ii) all visible elements with `data-testid`, (iii) scroll position of each scroll container, (iv) URL.
   b. Rotate: `setViewport(844, 390)` — swap width/height.
   c. Wait 500 ms (orientation reflow window).
   d. Re-capture (i), (ii), (iii), (iv).
   e. Rotate back: `setViewport(390, 844)`.
   f. Re-capture once more.
2. Detection criteria (any one fires):
   - **Layout break:** any element's `getBoundingClientRect()` has `right > viewport.width` (horizontal overflow) post-rotation.
   - **State loss:** a `data-testid` present in step (a)'s capture is missing in step (e)'s capture without an explicit URL change between them.
   - **Scroll loss:** scroll position of a named scroll container differs by > 100 px between (a) and (e).
3. Emit one `orientation_change_layout_break` per condition, with `selectorClass` set to the offending testid OR scroll container OR `'horizontal-overflow'`.

**False-positive guards.**
- A `data-testid` on a route-conditional element (e.g. only-mobile-only-portrait nav drawer) is expected to disappear on rotation. Skip testids that match config `mobile.orientationStateExclusions` (default empty array).
- URL changes during the 500 ms window mean the user navigated; skip the comparison entirely.
- Modals: a modal that auto-dismisses on rotation is an app-design choice. Detect via `[role=dialog]` testid match — if a dialog testid disappears AND its host page didn't navigate, emit; user can suppress.

**Cost note.** Orientation probe doubles screenshot count. Default OFF for runs > 100 pages; gate via `mobile.orientationChangeMaxPages = 50`.

### 4.6 `pull_to_refresh_conflict`

**Signal.** A scrollable container at the top of the page that has a `touchstart`/`touchmove` listener with non-`passive: true` setting OR calls `preventDefault()` on touchmove → conflicts with the browser's native pull-to-refresh, often producing a janky no-op pull where the page neither refreshes nor scrolls.

**Detector.** STATIC + DOM-INVENTORY hybrid. Runs once per page in mobile mode.

1. **DOM inventory (mobile mode, in-browser eval):**
   ```ts
   // Walk all elements, find those with attached touchstart/touchmove listeners and check passive flag.
   // EventListener inspection is NOT possible from JS at runtime; instead, monkey-patch addEventListener
   // before page scripts execute, log all (element, type, options) tuples, and dump.
   ```
   This means the detector's instrumentation MUST be injected as `init_script` in camofox before navigation. Add a method `browser.addInitScript(scriptSource)` to the adapter (camofox supports this via the `add_init_script` MCP tool). Pre-injection script:
   ```js
   (function(){
     const orig = EventTarget.prototype.addEventListener;
     window.__bh_listeners__ = [];
     EventTarget.prototype.addEventListener = function(type, listener, options) {
       if (type === 'touchstart' || type === 'touchmove') {
         const passive = typeof options === 'object' && options !== null
           ? options.passive === true
           : false;
         window.__bh_listeners__.push({ type, passive, ts: Date.now(),
           selector: this.tagName ? `${this.tagName.toLowerCase()}${this.id ? '#'+this.id : ''}` : 'window' });
       }
       return orig.apply(this, arguments);
     };
   })();
   ```
2. After the page settles in mobile mode, `evaluate('window.__bh_listeners__')`. For each listener with `passive: false` AND attached to an element AT or NEAR the top of the page (`y < 100`), emit `pull_to_refresh_conflict`.

**False-positive guards.**
- Listeners on `body`, `html`, `document`, or `window` with `passive: true` are NOT a conflict; skip.
- Listeners installed by known libs (Hammer.js, ZingTouch, gesture libs) often handle `preventDefault` in a way that's intentional; v0.41 still emits; user can suppress per cluster.
- Listeners attached AFTER first user interaction: skip. Only initial-load listeners are flagged.

**Adapter method to add:**
```ts
addInitScript?(source: string): Promise<{ ok: true } | { ok: false; reason: string }>;
```

---

## 5. Mobile UA + viewport matrix

### 5.1 UA strings (`packages/cli/src/static/mobile-ua.ts`, NEW file)

```ts
// Static, hand-curated. Updated 2026-04 against latest Safari/Chrome real strings.
// Do NOT randomize. The same UA must reproduce the same run.

export const MOBILE_USER_AGENTS = {
  ios:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
} as const;

export type MobilePlatform = keyof typeof MOBILE_USER_AGENTS;

export function uaForViewport(label: string, platform: MobilePlatform, override?: string): string {
  return override ?? MOBILE_USER_AGENTS[platform];
}
```

### 5.2 Default viewport matrix

| Label | Width | Height | Platform | Rationale |
|---|---|---|---|---|
| `iphone-se` | 375 | 667 | ios | Smallest currently-shipping iPhone; tightest target-size constraint |
| `iphone-14` | 390 | 844 | ios | Modern iPhone baseline; 100vh detector targets this viewport specifically |
| `pixel-7` | 412 | 915 | android | Modern Android baseline; tests Chrome quirks |

These come from the v0.41 spec's mandate (375x667 / 390x844 / 412x915). They are NOT user-customizable in v0.41; users may add a fourth via config but cannot remove iphone-14 (it's the 100vh anchor). Enforced by a runtime validator after Zod parse: `if (viewports.find(v => v.label === 'iphone-14') === undefined) viewports.push(<default-iphone-14>)`.

### 5.3 Viewport application order

1. `applyMobileMode(browser, mobileConfig)` is called once after browser-login (the cookie jar is preserved across UA changes; verify with a unit test that mocks the adapter).
2. Inside `screenshotPhase`, the existing v0.17 viewport loop iterates the mobile viewports (in addition to or in place of the v0.17 desktop viewports — see EC-12). Order: smallest width first.
3. `setViewport(width, height)` is the SAME existing call. No new method needed for viewport mechanics.
4. After all mobile work in a phase, `clearMobileMode(browser)` resets to a "neutral" desktop UA + 1280-wide viewport (to avoid leaking mobile state into post-phase work).

### 5.4 Why these specific dimensions

- 375 wide: the WCAG Reflow success criterion (1.4.10) tests at 320 px; we go slightly higher to match real devices in 2026. Sub-375 is rare enough that v0.42 can add it via a `--mobile-tiny` flag if a target demands.
- 412/844/915 heights: dynamic viewport height (`100dvh`) and small viewport height (`100svh`) behaviour differs from `100vh`. The 100vh-break detector (§4.3) targets 844 specifically because the iOS toolbar inset is 84 px → simulated visible region is 760, which is still above the typical 720-px breakpoint where many SPAs degrade.

---

## 6. Soft-keyboard simulation

### 6.1 Approach

iOS Safari and Chrome Android both shrink the visual viewport (the area excluding the keyboard) when a virtual keyboard appears. The DOM viewport (`window.innerHeight`) often does NOT change; the visual viewport (`window.visualViewport.height`) does. Apps that read `window.innerHeight` for layout calculations get the wrong answer. Detection via:

1. **Primary path (CDP):** call `Emulation.setDeviceMetricsOverride` with reduced `height = viewportHeight - keyboardHeightPx`. This shrinks the layout viewport AND fires a real `resize` event. Most modern responsive layouts respond correctly to this.
2. **Augmentation:** also call `evaluate("window.visualViewport.dispatchEvent(new Event('resize'))")` to nudge libs that listen specifically for `visualViewport.resize`.
3. **Restoration:** `Emulation.clearDeviceMetricsOverride()` after the detector completes.

### 6.2 Why not real keyboard input

- Camofox uses Firefox under the hood; Firefox's CDP support is partial. `Input.dispatchKeyEvent` works, but Firefox does NOT show a virtual keyboard for synthesized key events even when `mobile=true`.
- Real virtual keyboards depend on platform IME (UIKit on iOS, Android IMEService); neither is reachable from CDP.
- Therefore the simulation is "viewport shrink" rather than "actual keyboard." This catches all `position: fixed; bottom: 0` regressions and most scroll-into-view-on-focus failures, but does NOT catch input-event-handling bugs unique to real IME (composition events, autocomplete suggestions, etc.). v0.41 documents the gap; v0.42 may revisit if a target needs IME-event detection (likely never inside camofox; would require WebDriver BiDi or real-device).

### 6.3 Failure modes

| Mode | Adapter return | Run-level effect |
|---|---|---|
| CDP unreachable | `{ ok: false, reason: 'cdp_unavailable' }` | Skip soft-keyboard detector; add `mobile_soft_keyboard_unavailable` to skippedReasons |
| `Emulation.setDeviceMetricsOverride` rejected by camofox | `{ ok: false, reason: 'emulation_unsupported' }` | Same as above |
| Override succeeds but `visualViewport` is `undefined` (very old browser) | `{ ok: true }` but detector logs `partial_simulation` | Detector still runs; results valid for layout-viewport-readers |
| Restore fails | log error; continue run; subsequent phases run with shrunk viewport (BAD) | Mitigation: wrap detector in `try/finally` that always calls `clearDeviceMetricsOverride`; if even that fails, abort run with `mobile_keyboard_restore_failed` infrastructureFailure |

---

## 7. Hover-only-affordance static analysis

### 7.1 Inputs

1. **Built CSS bundle paths:** glob `*.css` under (in priority order) `dist/`, `build/`, `.next/static/css/`, `out/static/css/`, `.svelte-kit/output/`. Project root from `opts.projectDir`.
2. **Inline `<style>` tags:** scraped during discovery via `browser.evaluate('Array.from(document.querySelectorAll("style")).map(s => s.textContent).join("\\n/*---*/\\n")')`. Optional; controlled by `mobile.hoverOnlyScan`.
3. **Source CSS files:** glob `**/*.css`, `**/*.scss`, `**/*.module.css` under `src/` IF available. Source-level scan provides line numbers; built-bundle scan covers framework-injected styles. Both run; results merge by selector identity.

### 7.2 Algorithm (postcss AST walk)

```ts
async function scanCss(cssText: string, source: string): Promise<BugDetection[]> {
  const root = postcss.parse(cssText);
  const interactiveRe = /\b(button|a|select|input|\.btn|\.button)\b|\[role=["']?button["']?\]|\[onclick\]/;
  const interactiveProps = new Set(['background-color', 'background', 'color', 'transform', 'opacity', 'visibility', 'display', 'border-color', 'box-shadow']);
  const hoverRules: Array<{ baseSelector: string; props: Set<string>; rule: postcss.Rule }> = [];
  const focusActiveRules: Array<{ baseSelector: string; props: Set<string> }> = [];

  root.walkRules(rule => {
    // Skip rules inside @media (hover: hover) or @media (pointer: fine)
    let parent = rule.parent;
    while (parent) {
      if (parent.type === 'atrule' && /^media$/i.test(parent.name)) {
        const params = parent.params.toLowerCase();
        if (params.includes('hover: hover') || params.includes('pointer: fine')) return;
      }
      parent = parent.parent;
    }

    for (const selector of rule.selectors) {
      const trimmed = selector.trim();
      if (trimmed.includes(':hover')) {
        const base = trimmed.replace(/:hover\b/g, '').replace(/:not\([^)]+\)/g, '').trim();
        if (!interactiveRe.test(base)) continue;
        const propNames = new Set<string>();
        rule.walkDecls(d => propNames.add(d.prop));
        const filtered = new Set([...propNames].filter(p => interactiveProps.has(p)));
        if (filtered.size === 0) continue;
        if (filtered.size === 1 && filtered.has('cursor')) continue;
        hoverRules.push({ baseSelector: base, props: filtered, rule });
      } else if (trimmed.includes(':focus') || trimmed.includes(':active')) {
        const base = trimmed.replace(/:focus\b|:active\b/g, '').replace(/:not\([^)]+\)/g, '').trim();
        const propNames = new Set<string>();
        rule.walkDecls(d => propNames.add(d.prop));
        focusActiveRules.push({ baseSelector: base, props: new Set([...propNames].filter(p => interactiveProps.has(p))) });
      }
    }
  });

  const detections: BugDetection[] = [];
  for (const h of hoverRules) {
    const matched = focusActiveRules.find(f => f.baseSelector === h.baseSelector
      && [...h.props].some(p => f.props.has(p)));
    if (matched !== undefined) continue;
    detections.push({
      kind: 'hover_only_affordance',
      rootCause: `:hover styles on "${h.baseSelector}" with no :focus/:active equivalent`,
      pageRoute: '<static>',
      selectorClass: h.baseSelector.slice(0, 80),
      staticContext: { tool: 'hover-only-affordance', file: source, line: h.rule.source?.start?.line ?? 0 },
    });
  }
  return detections;
}
```

### 7.3 Dependency

`postcss` ~70 KB gzipped, MIT, 30M weekly downloads. Pin exact version in `package.json` (`postcss: 8.4.41` or current). No additional plugins required for v0.41.

### 7.4 Cluster identity

`bugIdentity` uses `(kind, baseSelector)` for `hover_only_affordance` (page-route is always `<static>`). Add a single line to the cluster-key builder.

---

## 8. CLI surface

### 8.1 Command shapes

```bash
# Default: full test plan, mobile mode on, all mobile detectors enabled
bughunter run --mobile

# Single viewport
bughunter run --mobile --mobile-viewport iphone-se

# Compose with v0.17 multi-viewport: desktop + mobile in same run
bughunter run --vision --mobile

# Disable individual mobile detectors
bughunter run --mobile --mobile-no-soft-keyboard --mobile-no-orientation

# Override UA (e.g. test legacy-Safari behavior)
bughunter run --mobile --mobile-ua "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) ..."
```

### 8.2 Interaction with existing flags

- `--vision`: composes. Vision baseline screenshots are captured at every viewport (v0.17 + mobile = up to 6 viewports per page). Cost-aware: vision budget accounting unchanged.
- `--a11y` / `--a11y-strict`: REQUIRED for `touch_target_too_small` detection (axe must be injected). If `--mobile` is set without `--a11y`, log a warning but continue; mobile mode still detects 5 of 6 BugKinds.
- `--enable-perf`: composes. Perf phase runs at the active viewport (mobile if mobile mode is on).
- `--multi-context <N>`: NOT compatible with `--mobile` in v0.41. Multi-context with mobile is a v0.42+ extension. If both set, log error and exit 1.
- `--budget`: mobile mode roughly 2x existing run time (3 mobile viewports + soft-keyboard probe + orientation probe). Caller must adjust `--budget` accordingly. Document.

### 8.3 Default behaviour without `--mobile`

NO mobile-specific phase runs. UA stays at camofox default. The six new BugKinds are still in the union but never fire (no detector produces them). `summary.json.mobile = { enabled: false }`.

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All new types are valid (`BugKind` union, `MobileConfigSchema`, summary field) | `npx tsc --noEmit` clean in `/root/BugHunter` |
| All new unit tests pass | `npm test` in `/root/BugHunter` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Mobile UA strings file is exact-pinned, no randomization | grep for `Math.random`/`Date.now` in `mobile-ua.ts` returns 0 |
| Hover-only-affordance scanner runs in <2 s on a 1 MB CSS bundle | `npm test -- hover-only-affordance.test.ts --run` reports duration |
| Aspectv3 smoke with `--mobile --a11y --a11y-strict` produces ≥ 1 cluster of `touch_target_too_small` AND ≥ 1 cluster of `hover_only_affordance` | `jq '.clusters[] | select(.kind | test("touch_target|hover_only"))' summary.json` |
| `summary.json.mobile.viewportsExercised` lists all three default viewports | `jq '.mobile.viewportsExercised' summary.json` |
| Disabling each mobile sub-feature individually works | manual: `--mobile --mobile-no-soft-keyboard` → no `soft_keyboard_occlusion` detector runs |
| `setViewport` regression: existing v0.17 multi-viewport tests still pass | `npm test -- discover.test.ts --run` |
| `bughunter run` without `--mobile` produces no `mobile` key in summary OR produces `{ enabled: false }` | regression check |
| Run with `--mobile --multi-context 2` exits non-zero with clear error | manual exit code = 1 |

---

## 10. Files

### 10.1 Files to MODIFY

| Path | Change |
|---|---|
| `packages/cli/src/types.ts` | Add 6 BugKinds; add `MobileBugKind` alias; add `mobile` field to summary type; add `MobileConfig` type |
| `packages/cli/src/config.ts` | Add `MobileConfigSchema` + integrate into `BugHunterConfigSchema` |
| `packages/cli/src/cli/main.ts` | USAGE block addition (mobile section) |
| `packages/cli/src/cli/run.ts` | Parse `--mobile*` flags; resolve `mobile` config; invoke `applyMobileMode` |
| `packages/cli/src/adapters/browser-mcp.ts` | Add `setUserAgent`, `setVirtualKeyboardInsets`, `addInitScript` adapter methods (all optional on interface; concrete on Camofox impl) |
| `packages/cli/src/adapters/cdp-session.ts` | Add `overrideViewportInsets(bottomPx)` method (used as fallback for soft keyboard) |
| `packages/cli/src/phases/discover.ts` | Hook `applyMobileMode` BEFORE `screenshotPhase`; pass mobile viewport list into existing loop |
| `packages/cli/src/phases/emit.ts` | Add `mobile` summary rollup |
| `packages/cli/src/classify/accessibility.ts` | Add `target-size` to AXE_RUN_SCRIPT runOnly tag list (only when mobile mode active) |
| `packages/cli/src/classify/a11y-baseline.ts` | Add `target-size` violation branch → `touch_target_too_small`; accept `viewportContext` |
| `packages/cli/src/cluster.ts` | Add cluster-key cases for the 6 new BugKinds |
| `packages/cli/src/static/runner.ts` | Register `hover-only-affordance` static tool |

### 10.2 Files to CREATE

| Path | Why |
|---|---|
| `packages/cli/src/static/mobile-ua.ts` | UA constants; tested via type + value check |
| `packages/cli/src/static/tools/hover-only-affordance.ts` | postcss AST walker; emits `hover_only_affordance` |
| `packages/cli/src/static/tools/hover-only-affordance.test.ts` | Unit tests with hand-crafted CSS fixtures (positive + negative cases) |
| `packages/cli/src/perf/viewport-100vh-detector.ts` | Two-shot capture detector; emits `viewport_100vh_break` |
| `packages/cli/src/perf/viewport-100vh-detector.test.ts` | Mocked browser test |
| `packages/cli/src/perf/soft-keyboard-detector.ts` | Per-form virtual-keyboard occlusion detector; emits `soft_keyboard_occlusion` |
| `packages/cli/src/perf/soft-keyboard-detector.test.ts` | Mocked browser + CDP test |
| `packages/cli/src/perf/orientation-change-detector.ts` | Rotation-pair capture; emits `orientation_change_layout_break` |
| `packages/cli/src/perf/orientation-change-detector.test.ts` | Mocked browser test |
| `packages/cli/src/perf/pull-to-refresh-detector.ts` | Init-script + listener inventory; emits `pull_to_refresh_conflict` |
| `packages/cli/src/perf/pull-to-refresh-detector.test.ts` | Mocked init-script test |
| `packages/cli/src/phases/mobile-mode.ts` | `applyMobileMode`/`clearMobileMode` orchestrators |
| `packages/cli/src/phases/mobile-mode.test.ts` | Unit tests for setup/teardown |
| `fixtures/mobile-bad/index.html` + `style.css` | Self-contained fixture with one positive of each of the 6 BugKinds for integration smoke |
| `tests/integration/mobile-smoke.test.ts` | Loads the fixture, runs mobile mode, asserts ≥ 1 of each BugKind detected |

### 10.3 Files explicitly NOT created

- `packages/cli/src/phases/mobile-runner.ts` — DO NOT create. Mobile mode is a configuration of the existing runner, not a new runner.
- `packages/cli/src/adapters/mobile-cdp-shim.ts` — DO NOT create. CDP additions go into the existing `cdp-session.ts`.

---

## 11. Edge cases

### EC-1. Mobile UA shadows logged-in cookie state
Most apps treat UA as cosmetic; cookies persist across UA change. But some SPAs key session storage on UA fingerprint (anti-bot). Mitigation: `applyMobileMode` runs AFTER browser-login. If a target invalidates session on UA change, login fails the next phase → `auth_lost_mid_loop` already detects this; we surface the cause via `mobile_ua_session_invalidated` skipped reason.

### EC-2. `setViewport` succeeds, UA change fails
Mobile mode is partial. Decision: ABORT mobile mode, run desktop. Log `mobile_partial_setup_aborted`. Do NOT run mobile detectors against a desktop UA — false positives (target-size on desktop is meaningless).

### EC-3. CSS bundle includes `@supports` blocks
postcss handles `@supports` like any at-rule. The walker recurses; rules inside count. This is correct behavior — `@supports (transform: scale(1)) { .btn:hover { ... } }` still produces a hover-only affordance if no focus pair exists.

### EC-4. Inlined critical CSS in `<head>`
Scraped via `evaluate('document.querySelectorAll("style")...')` per page (§ 7.1). Each per-page scrape merges into the static dataset before `bugIdentity` clustering, so duplicates fold.

### EC-5. CSS-in-JS (styled-components, emotion)
Generated `<style>` tags carry hashed class names. The interactive-selector heuristic regex won't match `.sc-bdVaJa:hover`. v0.41 misses these; documented limitation. v0.42 may augment with a runtime DOM scan (computed styles + listener inventory).

### EC-6. `setVirtualKeyboardInsets` succeeds on browser-mcp but app uses `100vh` not `100dvh`
Soft-keyboard detector measures `getBoundingClientRect()`, which is layout-viewport-relative. Inputs sized to `100vh` will measure correctly; inputs nested inside `100vh` containers will too. But: if the app ALSO listens to `visualViewport.height` for layout, the synthesized `resize` event in §6.1 step 2 may not fire on every browser. Mitigation: detector measures BEFORE the resize event AND 200 ms AFTER focus, taking the worse of the two readings.

### EC-7. Orientation change navigates the SPA (route guard)
Some apps detect orientation and redirect (`/?orientation=landscape`). Detector compares URLs pre/post-rotation; if changed, comparison is suppressed and a separate `orientation_change_caused_navigation` signal is logged (informational, not a BugKind).

### EC-8. `pull_to_refresh` init-script blocked by CSP
`addInitScript` injects via camofox; CSP applies AFTER the init script runs (init scripts run in the world before page scripts). If CSP blocks `eval`, `Function` constructors, etc., the patch still runs (it's pure prototype mutation). If CSP somehow blocks prototype mutation (rare; would require a custom realm), the listener inventory is empty → detector returns no findings, NOT a false positive. Document.

### EC-9. `target-size` axe rule not in installed axe-core version
axe-core ≥ 4.6 ships `target-size`. BugHunter's vendored axe is at 4.10.x. Verify in `package.json`; if older, bump as part of v0.41.

### EC-10. Soft-keyboard detector fires on a hidden input becoming visible on focus
Some forms reveal a search input only when the parent button is clicked. Pre-focus rect is `0,0,0,0` (display:none); post-focus rect is real. Detector uses `display: none` filter (§4.4 false-positive guard 2) → input is skipped on the pre-focus pass; the post-focus pass runs once visible and emits correctly if occluded.

### EC-11. Pixel-7 viewport (412 wide) wraps differently than iPhone (390 wide)
Per-viewport detection runs once per viewport. A bug that only manifests at 412 produces a single cluster pinned to that viewport; clusters from 375 and 390 are independent. `bugIdentity` already includes route + selector; v0.41 adds `viewportLabel` to identity for mobile-specific bugs only.

### EC-12. Composing `--mobile` with `--vision` (existing v0.17 multi-viewport)
v0.17 default desktop viewports: `[375, 768, 1280]`. Mobile mode adds `[375, 390, 412]` with mobile UA. Resolution: under `--mobile --vision`, the screenshot phase runs SIX viewports per page. The 375-px duplicate is collapsed into ONE shot (UA matters less for visual baseline; we keep mobile UA for the 375 visit). Document the dedup rule.

### EC-13. The user runs `bughunter run --mobile` against a non-responsive desktop-only app
Most pages will produce `touch_target_too_small` clusters everywhere; cluster count explodes. Mitigation: cap mobile-baseline a11y violations at 50 per route via `mobile.touchTargetMaxPerRoute`. Beyond cap, log + continue.

### EC-14. Browser-MCP `add_init_script` tool unavailable
Older camofox builds don't expose it. Detector for `pull_to_refresh_conflict` skipped; `mobile_init_script_unavailable` added to `summary.json.skippedReasons`. Other 5 BugKinds unaffected.

### EC-15. Soft-keyboard simulation interferes with vision baseline
Vision baseline screenshots run AFTER soft-keyboard detector restoration. We MUST verify restoration via a `getViewportSize` round-trip after `clearDeviceMetricsOverride` and assert `height === expected`. If restore fails, abort run with `mobile_keyboard_restore_failed` infrastructureFailure (§6.3).

---

## 12. Negative requirements (forbidden)

- Do **not** treat the mobile suite as a separate phase in the run state machine. It IS the existing phases under different camofox config.
- Do **not** randomize UA strings between runs. Same UA every time, gated by config.
- Do **not** parse CSS with regex. postcss only.
- Do **not** emit `hover_only_affordance` for non-interactive selectors. The interactive-selector heuristic is conservative; false negatives preferred over false positives.
- Do **not** create a "mobile" SARIF severity level. The 6 new BugKinds slot into the existing severity scale (`touch_target_too_small` = `serious`, others = `moderate`).
- Do **not** log the resolved UA string at level `info` more than once per run. UA is part of the summary; spamming it in the run log is noise.
- Do **not** make `--mobile` change exit code on its own. Exit code is governed by `--max-bugs` and `--max-runtime` as before.
- Do **not** suppress mobile detectors at desktop viewports silently — log `mobile_detector_skipped_at_desktop_viewport` so users understand the scoping.

---

## 13. Task breakdown

| # | Task | Files | Owner | Deps |
|---|---|---|---|---|
| 1 | Extend `BugKind` union with 6 mobile kinds | `types.ts` | @coder | none |
| 2 | Add `MobileConfigSchema` to `config.ts` + summary type | `config.ts`, `types.ts`, `cluster.ts` | @coder | 1 |
| 3 | CLI flag plumbing (`--mobile*`) | `cli/run.ts`, `cli/main.ts` | @coder | 2 |
| 4 | Add `setUserAgent`, `setVirtualKeyboardInsets`, `addInitScript` to browser-mcp adapter | `adapters/browser-mcp.ts`, test | @coder | 1 |
| 5 | Add `overrideViewportInsets` to `cdp-session.ts` (fallback for §6.1) | `adapters/cdp-session.ts` | @coder | 4 |
| 6 | Create `phases/mobile-mode.ts` (apply/clear orchestrator) | new file + test | @coder | 4-5 |
| 7 | Wire `applyMobileMode` into `phases/discover.ts` | `phases/discover.ts` | @coder | 6 |
| 8 | Add `target-size` to AXE_RUN_SCRIPT + `target-size` branch in `classifyA11yBaseline` | `classify/accessibility.ts`, `classify/a11y-baseline.ts`, tests | @coder | 1 |
| 9 | Implement `hover-only-affordance.ts` static tool + register in static runner | `static/tools/hover-only-affordance.ts`, `static/runner.ts`, test | @coder | 1 |
| 10 | Implement `viewport-100vh-detector.ts` | `perf/viewport-100vh-detector.ts`, test | @coder | 6 |
| 11 | Implement `soft-keyboard-detector.ts` | `perf/soft-keyboard-detector.ts`, test | @coder | 4-5, 6 |
| 12 | Implement `orientation-change-detector.ts` | `perf/orientation-change-detector.ts`, test | @coder | 6 |
| 13 | Implement `pull-to-refresh-detector.ts` (init script) | `perf/pull-to-refresh-detector.ts`, test | @coder | 4 |
| 14 | Add `mobile` rollup to `summary.json` builder | `phases/emit.ts` | @coder | 1-13 |
| 15 | Build `fixtures/mobile-bad/` + integration smoke test | new fixture + test | @coder | 1-14 |
| 16 | Aspectv3 manual smoke + acceptance check | (manual) | @qa | 1-15 |

---

## 14. Risks + escape hatches

- **Risk: postcss adds 70 KB to the BugHunter bundle.** BugHunter is a CLI, not bundled to a single file; adding one direct dep is fine. Document size in spec output.
- **Risk: CDP `Emulation.setDeviceMetricsOverride` doesn't propagate to camofox's Firefox engine cleanly.** Already used in V19 race-condition timing; precedent exists. Verify on first integration; if broken, fall back to `mobile.softKeyboard = 'none'` automatically and log.
- **Risk: hover-only-affordance produces too many findings on real apps.** Cluster identity dedups across stylesheets. If one app produces > 100 clusters, that's a real signal — the app is desktop-only. Don't suppress; document.
- **Risk: `100vh` detector is heuristic and may false-positive on intentional overlay designs.** Mitigated by ARIA-role exclusions (§4.3 false-positive guards). False-positive rate target: < 10% on Aspectv3.
- **Escape hatch:** every mobile detector has an individual `--mobile-no-*` flag. Users can disable any subset without disabling the whole mode.
- **Escape hatch:** `mobile.enabled = false` (default) → entire feature is off; no v0.40 regression possible.

---

## 15. Killer-demo runbook (Aspectv3)

```bash
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --mobile --a11y --a11y-strict --max-bugs 200 --budget 3600000

RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.mobile, .clusters[] | select(.kind | test("touch_target|hover_only|viewport_100vh|soft_keyboard|orientation_change|pull_to_refresh"))' \
  /root/Aspectv3/.bughunter/runs/$RUN/summary.json
```

Expected: `mobile.enabled: true`, `viewportsExercised: [iphone-se, iphone-14, pixel-7]`, ≥ 1 `touch_target_too_small`, ≥ 1 `hover_only_affordance`, mobileBugCounts populated.

---

## 16. Open questions

1. **Should mobile mode default-disable when running against a target whose `<meta name="viewport">` is absent?** A site with no viewport meta is desktop-targeted by intent. Arguments for skipping: avoid noise. Arguments for running: still flag the bugs; the developer should add the meta. Default: RUN; document the behavior.

2. **Should `touch_target_too_small` use AA (24 px) or AAA (44 px) as default?** Spec says AA (24 px). Many design systems target 44 px (Material, Apple HIG). Add `mobile.touchTargetMinPx` config knob (default 24, recommended 44).

3. **Should `hover_only_affordance` require both `:focus` AND `:active` matches, or just one?** v0.41 says "either is enough" (`:focus` alone proves keyboard accessibility, which usually implies touch via tap-focus). Document; revisit if Aspectv3 produces false positives.

4. **Soft-keyboard simulation: should we also fire `keyboardgeometrychange` (Web API draft)?** It's a draft spec. Skip for v0.41; revisit if any real target listens for it.

5. **Should `viewport_100vh_break` migrate to a `100dvh` recommendation in the rootCause text?** Yes — `100dvh` (dynamic viewport height) is the modern fix; recommend it inline. Adds developer value to the finding.

6. **Should mobile mode be the default (no flag) for new BugHunter projects?** v0.41 says NO — backwards compatibility. v0.5 of BugHunter (post-comprehensive) may flip this. Track for v0.50.

7. **Should `--mobile-viewport` accept a CSV list (e.g. `--mobile-viewport iphone-se,iphone-14`)?** v0.41 says single value only. CSV adds parsing surface; if needed, supply via config. Decline for v0.41.

8. **Should `pull_to_refresh_conflict` detect `overscroll-behavior: contain` as a fix that suppresses the bug?** Yes. The static-CSS scan in §7 already catches CSS rules; extend the postcss walker to look for `overscroll-behavior` declarations on the same element selectors that have non-passive touch listeners. If found, the bug is mitigated → don't emit. Defer the implementation to follow-up if Aspectv3 doesn't surface it; flag in v0.41 spec output.
