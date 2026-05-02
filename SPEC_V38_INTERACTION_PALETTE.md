# SPEC — v0.38 "Interaction-level palette: drag/paste/autofill/animation/print/reduced-motion/forced-colors/dark-mode/zoom"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.17 multi-viewport (singleton tab + setViewport), v0.6 a11y-strict (page-baseline hook), v0.15 vision-consistency (vision diff harness), v0.18 JWT login (unblocks per-role login on JWT SPAs). · **Sibling roadmap:** `SPEC_PATH_TO_EXHAUSTIVE.md` §3.3 Phase E.

V38 adds an **interaction palette** that runs alongside the existing input-mutation palette in `packages/cli/src/mutation/apply.ts`. Where the input palette varies the *value* an action carries (`null`/`happy`/`edge`/`out_of_bounds`/`xss_inject`), the interaction palette varies the *environment and event-shape* in which the action executes (paste-from-Word, drag-and-drop, browser-autofill, mid-transition click, `prefers-reduced-motion: reduce`, `forced-colors: active`, `prefers-color-scheme: dark`, `@media print`, 200% browser zoom).

The two palettes are orthogonal and multiply only on the `happy` input variant — a paste handler tested against a `null` input adds no signal beyond the linear input pass that already exercised `null`. Cost control (§9) keeps the test-matrix explosion bounded by happy-only multiplication, action-shape gating, and per-route once-only application of static media-query variants.

---

## 1. Objective

Spec nine new `BugKind`s and the planner/executor plumbing to detect interaction-level UI bugs the current input-mutation palette structurally cannot reach:

| BugKind | What it catches | Detection family |
|---|---|---|
| `drag_drop_failure` | Drop target rejects valid MIME types or accepts invalid ones; `dragover` listener missing `preventDefault`; drag-and-drop reorder corrupts list state | Synthetic event |
| `paste_handler_failure` | Pasting from Word/Excel/HTML source corrupts state, throws, double-renders, or leaks `<script>`/`<style>` into editable region | Synthetic event |
| `autofill_state_desync` | Browser autofill fires native `change` event but React's controlled `value` doesn't sync → form submits empty, validation flips wrong, password manager mismatch | Synthetic event |
| `animation_state_corruption` | Click/keyboard event arriving during `transitionrun`/`animationstart` produces double-render, focus loss into closed modal, stale-state submit, dismissed-mid-fade artifacts | Timing event |
| `print_stylesheet_broken` | `@media print` view shows unstyled content, breaks pagination, hides essential elements (data tables, totals), or reflows so badly that print preview is unusable | Media-query env |
| `reduced_motion_violation` | `prefers-reduced-motion: reduce` ignored — animations still play, parallax still scrolls, autoplaying carousels still rotate. WCAG 2.3.3 violation | Media-query env |
| `forced_colors_failure` | `forced-colors: active` (Windows high-contrast) breaks layout — background-image-as-icon disappears, custom-color-only text is unreadable, focus indicator vanishes | Media-query env |
| `dark_mode_layout_break` | `prefers-color-scheme: dark` breaks layout — light-mode hardcoded colors leak, contrast collapses, backgrounds clash, an SVG icon becomes invisible | Media-query env |
| `zoom_layout_break` | 200% browser zoom (WCAG 1.4.10) breaks layout — content clips, horizontal scroll appears, sticky header overlaps content, focusable elements move off-screen | Viewport env |

**In scope:**
- 9 new `BugKind`s in `packages/cli/src/types.ts`
- Interaction-palette schema (`InteractionPaletteVariant`, `InteractionPaletteCase`)
- New per-action planner step that mints interaction-palette test cases gated by action-shape compatibility
- Executor extension: `executeUiTest` accepts an `interactionPaletteVariant` and applies env or synthetic-event overrides before/around the action
- Detectors per family (synthetic-event, timing-event, media-query env, viewport env)
- CLI flag `--interaction-palette` with sub-list selection
- Cost-control (§9): happy-only multiplication, action-shape gating, per-route once-only env variants, vision-budget integration
- Cluster signatures + priority slot for the new kinds
- One acceptance smoke per family (Aspectv3 has print stylesheets and a dark-mode toggle)

**Out of scope (deferred):**
- File-System-Access drag-and-drop with real file drops — synthetic `DataTransfer` is sufficient for v0.38; native file drop requires camofox `set_files_via_drop` API which doesn't exist yet. Defer to v0.40.
- Pinch-zoom (multi-touch) — only desktop browser zoom in v0.38. Mobile gesture suite is v0.34.
- Soft-keyboard occlusion — Phase E §3.6 mobile, separate spec.
- Touch-only affordances — Phase E §3.6 mobile.
- WCAG 2.4.11 (focus appearance under forced-colors) finer-grained subrule — `forced_colors_failure` is the umbrella; finer subdivision is v0.39.
- Right-to-left direction palette (i18n `dir="rtl"`) — Phase E §3.2, separate spec.
- Locale-stress (long-string German, RTL Arabic) — Phase E §3.2, separate spec.
- High-DPI / print-specific page-break rules — covered by `print_stylesheet_broken` envelope; finer-grained subrules deferred.

**Acceptance target on Aspectv3:**
With `--interaction-palette dark_mode,reduced_motion,zoom_200,print` enabled, the next smoke produces:
- ≥ 1 cluster of `dark_mode_layout_break` if Aspectv3 has any light-mode-only color, OR a `coverage.json` line confirming the variant ran
- ≥ 1 `print_stylesheet_broken` cluster on the `/dashboard` print preview (Aspectv3 has no print stylesheet — should fire under `printStylesheetRequired: true`)
- 0 `infrastructureFailure` entries attributed to the interaction palette (it must degrade gracefully when emulation isn't supported)
- Total run time within 1.4× the baseline run (cost-control gate)
- `summary.json.execute.interactionPaletteTelemetry` populated with per-variant `{ casesPlanned, casesRan, casesSkipped, skipReasons }`

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/mutation/apply.ts` | Current input palette (`formTestCases`, `apiTestCases`). V38 does NOT modify this file's API; it adds `interactionPaletteCases` as a sibling. |
| `packages/cli/src/mutation/palette.ts` | `generatePaletteCases` per InputType. Pattern reference; do not extend. Interaction palette has its own generator (`packages/cli/src/mutation/interaction-palette.ts`, new). |
| `packages/cli/src/types.ts` | `BugKind` union, `PaletteVariant`, `Action`, `TestCase`, `RunState`. Add 9 BugKinds; add `InteractionPaletteVariant` discriminated union; add optional `interactionPalette` field to `Action`. |
| `packages/cli/src/phases/plan.ts` | Per-test-case minting. Add a `mintInteractionPaletteCases()` step after the input-palette step. Gated by per-action shape rules (§4.2). |
| `packages/cli/src/phases/execute.ts` | `executeUiTest` (line 779+) and `executeUiTestInner` (line 443+). Add an `interactionPaletteVariant` parameter; per-variant apply env/event overrides before the action. |
| `packages/cli/src/adapters/browser-mcp.ts` | `TabScope` and `BrowserMcpAdapter`. Add new optional methods: `emulateMedia`, `setForcedColors`, `setZoom`, `dispatchSyntheticEvent`. All optional → unsupported variants degrade with `skipReason`. |
| `packages/cli/src/cluster/signature.ts` | Cluster signature switch. Add 9 new cases; one per new BugKind. |
| `packages/cli/src/classify/cluster-priority.ts` | `KIND_PRIORITY` ordering. Slot the 9 new kinds (§5). |
| `packages/cli/src/classify/vision.ts` | Vision-diff harness that V38 reuses for media-query variants. Read for the fingerprint+vision-call shape; do not modify. |
| `packages/cli/src/cli/run.ts` | `--a11y-strict` flag wiring. Mirror for `--interaction-palette`. |
| `packages/cli/src/cli/main.ts` | USAGE block. Add the new flag to the help text. |
| `packages/cli/src/types.ts` | `BugHunterConfig`. Add `interactionPalette?: InteractionPaletteConfig` block. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format reference. Mirror sections + tone. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §3.3, §9 Phase E | Source of truth for which BugKinds belong here. |

### 2.2 Patterns to follow

- **Discriminated unions for variants.** `InteractionPaletteVariant` is a discriminated union with `kind` literal and per-variant payload. NOT a string convention. (Per CLAUDE.md: discriminated unions over string conventions; ~100% vs 60% agent success.)
- **Optional adapter methods.** `setZoom`, `emulateMedia`, etc. are optional on `BrowserMcpAdapter` so older camofox builds without the capability degrade with a structured `skipReason`, not a crash.
- **Per-variant skipReason telemetry.** Every variant that doesn't run records why (`adapter_unsupported`, `action_shape_incompatible`, `route_already_baselined`, `vision_budget_exhausted`).
- **Vision-diff for env variants.** `dark_mode_layout_break`, `forced_colors_failure`, `reduced_motion_violation` (visual aspects), and `zoom_layout_break` reuse the V15 vision-diff harness (`classifyVisualAnomaliesConsistent`); the variant-rendered screenshot is compared against the baseline screenshot for that route. NEW BugKind, REUSED detection plumbing.
- **Synthetic-event variants are observation-and-assertion.** Drag/drop/paste/autofill fire synthetic events through `scope.evaluate`; the assertion is "did React state update" or "was a console error logged" or "was the form payload mutated as expected".
- **Action-shape gating.** Each variant declares which `ActionKind` it applies to. Variants don't run on incompatible actions (paste makes no sense for `navigate`).
- **Per-route once-only.** Static env variants (dark mode, print, forced colors, zoom) are characteristic of the *page render*, not the action. They run **once per route per role**, not once per action. Drag/paste/autofill are per-action.

### 2.3 DO NOT

- Do **not** extend `PaletteVariant` (the input-palette type). The interaction palette is a separate dimension; conflating the two breaks the action × value separation that bounds the matrix today.
- Do **not** add interaction variants to `apiTestCases`. API tests have no DOM, so paste/drag/autofill/zoom/etc. are inapplicable. Spec-level negative requirement.
- Do **not** mint interaction variants for `xss_inject` palette tests. XSS canary tests already have specific assertions about reflection; layering interaction variants creates ambiguous attribution. `xss_inject` × `interactionPaletteVariant` is forbidden.
- Do **not** mint interaction variants for `null` / `out_of_bounds` input palettes. They add no signal — a paste-handler test against a null input is just the existing null test. Only `happy` × interaction-variant produces independent signal.
- Do **not** add a `setForcedColors` adapter method that requires CDP — emulate via `emulateMedia({ forcedColors: 'active' })` only. Camofox v0.1 supports this through Playwright's emulateMedia; CDP-only paths are out-of-scope.
- Do **not** introduce a new top-level command. All wiring goes through `bughunter run --interaction-palette ...`.
- Do **not** retain full screenshots for env variants beyond cluster-evidence retention. Each variant produces 1 screenshot per route per variant; default retention applies (latest run + clusters with verdict ≠ resolved).
- Do **not** dispatch `MouseEvent('click')` while a CSS transition is in flight using `setTimeout` — race-flake-prone. Use `transitionrun` event listener + microtask queue (§7.4).

---

## 3. Architecture decisions

### 3.1 Two-axis palette model

The input palette varies the **value** the action carries:

```
input_palette : Action.input → { null, happy, edge, out_of_bounds, xss_inject }
```

V38 adds the **interaction palette** that varies the **environment + event-shape** the action runs under:

```
interaction_palette : (env, eventShape) → { drag, paste, autofill, animation_mid_transition,
                                            print, reduced_motion, forced_colors, dark_mode, zoom_200 }
```

Critically, these are orthogonal but multiply only on `palette === 'happy'` (§9.2). Total test cases per (page, action) are:

```
input_palette_count           // currently 4-5
+ Σ over interaction_variants: gate(action, variant) ? 1 : 0
                                                         // bounded ≤ 9 per UI action
+ per-route once-only env variants                       // bounded ≤ 5 per route per role
```

The matrix grows additively (not multiplicatively) because per-action variants are per-action and per-route variants are per-route.

### 3.2 Per-action vs per-route variants

| Family | Variants | Apply granularity | Repetition |
|---|---|---|---|
| Synthetic event | drag, paste, autofill, animation_mid_transition | Per UI action that matches the gate | Once per matching action per palette = 'happy' run |
| Media-query env | print, reduced_motion, forced_colors, dark_mode | Per page route + role | Once per route per role |
| Viewport env | zoom_200 | Per page route + role | Once per route per role |

Per-action variants ride on the already-planned `happy` form/input test case; the runner re-uses the action and its baseline observation pipeline. Per-route variants run as standalone re-render passes (no action) after the route's baseline action has completed at least once. They produce zero or one detection per (route, role, variant).

### 3.3 Detection families

Three orthogonal detection mechanisms:

1. **Synthetic-event family** — JS-evaluate a `DataTransfer`/`InputEvent`/`ClipboardEvent` on the target element; observe (a) whether the React state updated to match (b) whether a `dragover/drop/paste/input/change` handler responded (c) whether console errors fired. Detector signal: discrepancy between fired event and observed state mutation.
2. **Timing-event family** — Begin a CSS transition (apply a class change) and immediately dispatch the next user event before `transitionend`. Observe focus loss into a now-detached node, double-render console warning, modal-dismiss-during-fade leaving content stuck mid-state. Detector signal: console error during transition window OR focus on detached element OR DOM still has both pre- and post-state classes.
3. **Media-query env family + viewport family** — Emulate the media query (or set zoom) via the adapter, screenshot the route, vision-diff against baseline. Detector signal: vision-anomaly score above threshold + structural-DOM-clip detection (any element with `getBoundingClientRect()` extending past `window.innerWidth + tolerance`).

### 3.4 Reuse, not invent

V38 deliberately avoids inventing new detection plumbing:
- Synthetic-event variants reuse the existing console-error capture, network capture, MutationObserver window, and post-action snapshot.
- Timing-event variants reuse focus-tracker (`packages/cli/src/adapters/focus-tracker.ts` from V06 a11y-strict).
- Media-query/viewport variants reuse the V15 vision-diff harness (`classifyVisualAnomaliesConsistent`), parameterized by media-query baseline vs variant fingerprint.
- Per-route once-only enforcement reuses the existing `baselinedRoutes` `Set` pattern from `onPageBaseline` (execute.ts:121, 137).

The V38 surface area is mostly: 9 new BugKinds, one new mutation file (`interaction-palette.ts`), one extension to `executeUiTestInner`, six new cluster-signature cases, one new CLI flag, three optional adapter methods. ~600 lines of new code estimated.

---

## 4. Interaction palette schema

### 4.1 Discriminated-union variant type

```ts
// packages/cli/src/types.ts (additions)

export type InteractionPaletteVariant =
  // Synthetic-event family (per action)
  | { kind: 'drag_drop'; sourceMime: 'text/plain' | 'text/html' | 'application/json'; payload: string; targetSelector: string; }
  | { kind: 'paste'; source: 'word_html' | 'excel_html' | 'plain_text' | 'styled_html_with_script'; payload: string; }
  | { kind: 'autofill'; field: 'email' | 'password' | 'cc' | 'address'; value: string; }
  | { kind: 'animation_mid_transition'; transitionTriggerSelector: string; intercedingActionDelayMs: number; }
  // Media-query env family (per route)
  | { kind: 'print'; }
  | { kind: 'reduced_motion'; }
  | { kind: 'forced_colors'; }
  | { kind: 'dark_mode'; }
  // Viewport family (per route)
  | { kind: 'zoom_200'; zoomFactor: 2.0; };

export type InteractionPaletteVariantKind = InteractionPaletteVariant['kind'];

export const ALL_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  'drag_drop', 'paste', 'autofill', 'animation_mid_transition',
  'print', 'reduced_motion', 'forced_colors', 'dark_mode', 'zoom_200',
] as const;

export const PER_ACTION_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  'drag_drop', 'paste', 'autofill', 'animation_mid_transition',
] as const;

export const PER_ROUTE_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  'print', 'reduced_motion', 'forced_colors', 'dark_mode', 'zoom_200',
] as const;
```

### 4.2 Per-variant table (action-shape gating + observation strategy)

| Variant | Family | Gate (compatible Action.kind) | Additional gate predicate | Observation | Cluster sig key |
|---|---|---|---|---|---|
| `drag_drop` | synthetic | `click` | Target element has `draggable` attr OR a sibling with `data-droppable` | `DataTransfer` round-trip + DOM order diff | `pageRoute + sourceSelector + targetSelector + sourceMime` |
| `paste` | synthetic | `fill`, `submit` | Target field matches `[contenteditable]` OR `<textarea>` OR rich-text | Compare React state pre/post + scan for `<script>`/`<style>` in DOM | `pageRoute + fieldSelector + source` |
| `autofill` | synthetic | `fill`, `submit` | At least one form field has `autocomplete=` matching variant.field | Native `change`+`input` events fired; React `value` matches DOM `value` | `pageRoute + formSelector + field` |
| `animation_mid_transition` | timing | `click`, `submit` | Target element has CSS `transition` OR `animation` declared (computed style) | Focus tracker + `transitionend` race; detect focus on detached node | `pageRoute + transitionTriggerSelector` |
| `print` | env (per-route) | n/a (post-baseline render-only) | Always | Vision diff + DOM-clip scan in `print` media | `pageRoute` |
| `reduced_motion` | env (per-route) | n/a | At least one CSS animation/transition or autoplay video on page | Detect any `getComputedStyle(el).animationPlayState === 'running'` after media-set; vision diff vs default | `pageRoute` |
| `forced_colors` | env (per-route) | n/a | Always | Vision diff + DOM-clip + focus-indicator-presence assertion | `pageRoute` |
| `dark_mode` | env (per-route) | n/a | Always | Vision diff + contrast-pair sampling vs WCAG AA threshold | `pageRoute` |
| `zoom_200` | viewport (per-route) | n/a | Always | Vision diff + horizontal-scrollbar detection + DOM-clip scan | `pageRoute` |

Gate predicates are *per-target* (drag/paste/autofill don't fire on routes that have no drop target / contenteditable / autocomplete-marked field). Gate-misses count toward `skipReasons` telemetry as `gate_predicate_false`.

### 4.3 Schema additions to `Action` and `TestCase`

```ts
export type Action = {
  // ... existing fields
  /** v0.38: when set, this action runs under the given interaction-palette variant.
   *  Mutually exclusive with `injectionNonce` (XSS canary tests don't get interaction-layered). */
  interactionPalette?: InteractionPaletteVariant;
};

export type TestCase = {
  // ... existing fields
  /** v0.38: shorthand for `action.interactionPalette?.kind`. Populated by the planner for cluster-sig and telemetry; derived field, do NOT set manually. */
  interactionPaletteKind?: InteractionPaletteVariantKind;
};

export type InteractionPaletteConfig = {
  /** Master switch. Default: false. Per CLAUDE.md: opt-in expensive features. */
  enabled?: boolean;
  /** Which variants to run. Default: all 9. CLI flag may narrow this. */
  variants?: ReadonlyArray<InteractionPaletteVariantKind>;
  /** Cap on total interaction-palette test cases. Default: 300. */
  maxTests?: number;
  /** Vision threshold for env-variant diffs. Default: 0.18 (looser than baseline 0.10). */
  envVisionThreshold?: number;
  /** When true, skip per-route variants if vision is unavailable. Default: false. Forced-colors and zoom still use DOM-clip even without vision. */
  requireVision?: boolean;
  /** When true, fire `print_stylesheet_broken` proof 'no_print_stylesheet_defined' even when no other proof triggers. Default: false (opt-in for sites that should ship a print view). */
  printStylesheetRequired?: boolean;
};
```

---

## 5. Bug classification additions

### 5.1 New `BugKind` union members

```ts
// Append to BugKind union in packages/cli/src/types.ts
| 'drag_drop_failure'
| 'paste_handler_failure'
| 'autofill_state_desync'
| 'animation_state_corruption'
| 'print_stylesheet_broken'
| 'reduced_motion_violation'
| 'forced_colors_failure'
| 'dark_mode_layout_break'
| 'zoom_layout_break';
```

### 5.2 Priority hierarchy slotting

The current `KIND_PRIORITY` orders: `unhandled_exception > xss_* > sql_injection > … > visual_anomaly > console_error`.

V38 slots the 9 kinds at the following tiers (cluster-collision resolution; same-occurrence rule):

| Tier | Kinds | Rationale |
|---|---|---|
| Major (just above `accessibility_critical`) | `paste_handler_failure`, `autofill_state_desync` | Data-corruption-risk: silent state desync produces wrong-data submissions. |
| Major | `drag_drop_failure`, `animation_state_corruption` | UX-breaking but observable to user — they'll re-try and notice. |
| Minor (just above `visual_anomaly`) | `print_stylesheet_broken` | Not on hot path for most users. |
| Minor | `reduced_motion_violation` | A11y compliance, not data-loss. |
| Minor | `forced_colors_failure` | A11y compliance + small user cohort. |
| Minor | `dark_mode_layout_break` | UX-breaking but no data-loss; 50% of users use dark mode. |
| Minor | `zoom_layout_break` | WCAG 1.4.10; common visual-impairment use case. |

When an interaction-palette test produces both an `unhandled_exception` AND e.g. `paste_handler_failure`, the exception wins by existing priority (it's a superset; paste_handler_failure becomes a `secondaryObservation` on the cluster).

### 5.3 Cluster signatures (`packages/cli/src/cluster/signature.ts`)

```ts
case 'drag_drop_failure':
  return `drag_drop_failure|${detection.pageRoute ?? ''}|${detection.interactionContext?.sourceSelector ?? ''}|${detection.interactionContext?.targetSelector ?? ''}|${detection.interactionContext?.sourceMime ?? ''}`;
case 'paste_handler_failure':
  return `paste_handler_failure|${detection.pageRoute ?? ''}|${detection.interactionContext?.fieldSelector ?? ''}|${detection.interactionContext?.pasteSource ?? ''}`;
case 'autofill_state_desync':
  return `autofill_state_desync|${detection.pageRoute ?? ''}|${detection.interactionContext?.formSelector ?? ''}|${detection.interactionContext?.autofillField ?? ''}`;
case 'animation_state_corruption':
  return `animation_state_corruption|${detection.pageRoute ?? ''}|${detection.interactionContext?.transitionTriggerSelector ?? ''}|${detection.interactionContext?.proof ?? ''}`;
case 'print_stylesheet_broken':
  return `print_stylesheet_broken|${detection.pageRoute ?? ''}|${detection.interactionContext?.proof ?? ''}`;
case 'reduced_motion_violation':
  return `reduced_motion_violation|${detection.pageRoute ?? ''}|${detection.interactionContext?.violatingSelector ?? ''}`;
case 'forced_colors_failure':
  return `forced_colors_failure|${detection.pageRoute ?? ''}|${detection.interactionContext?.proof ?? ''}`;
case 'dark_mode_layout_break':
  return `dark_mode_layout_break|${detection.pageRoute ?? ''}|${detection.interactionContext?.proof ?? ''}`;
case 'zoom_layout_break':
  return `zoom_layout_break|${detection.pageRoute ?? ''}|${detection.interactionContext?.proof ?? ''}`;
```

`interactionContext` is a new context shape on `BugDetection` — discriminated by `kind` so each variant carries only the fields relevant to it.

### 5.4 New `InteractionContext` discriminated context

```ts
// packages/cli/src/types.ts
export type InteractionContext =
  | { kind: 'drag_drop'; sourceSelector: string; targetSelector: string; sourceMime: string; proof: string; }
  | { kind: 'paste'; fieldSelector: string; pasteSource: 'word_html' | 'excel_html' | 'plain_text' | 'styled_html_with_script'; proof: string; }
  | { kind: 'autofill'; formSelector: string; autofillField: string; proof: string; }
  | { kind: 'animation'; transitionTriggerSelector: string; proof: string; }
  | { kind: 'env'; mediaQuery: string; violatingSelector?: string; proof: string; };

// On BugDetection: optional, populated only for V38 kinds.
export type BugDetection = {
  // ... existing fields
  interactionContext?: InteractionContext;
};
```

---

## 6. Per-BugKind subsection

### 6.1 `drag_drop_failure`

**Variant payload:** `{ kind: 'drag_drop'; sourceMime; payload; targetSelector }`
**Gate:** action.kind === 'click' AND target page has at least one `draggable` element OR `data-droppable` element. Resolved by post-snapshot DOM scan after baseline action.
**Observation strategy:**
1. Identify a draggable source: `[draggable=true]`, common patterns (`.kanban-card`, `[role=row]` in sortable tables, etc.).
2. Identify a drop target: `[data-droppable]`, `[ondrop]`, `[role=region][aria-dropeffect]`.
3. Synthetic event sequence: `dragstart` (with `dataTransfer.setData(sourceMime, payload)`), `dragenter`, `dragover` (must NOT preventDefault for failure case), `drop`.
4. Detection signals (any one):
   - `dragover` listener missing: `event.defaultPrevented === false` after dispatch → drop will silently fail. Emit `drag_drop_failure` with `proof: 'dragover_no_preventDefault'`.
   - Drop succeeds but DOM order didn't change AND no `console.error`/`console.warn` fired: emit with `proof: 'drop_silent_no_op'`.
   - Drop throws unhandled exception: emit `unhandled_exception` (priority wins) + secondary `drag_drop_failure`.
   - Drop succeeds but `application/json` source produced a string in DOM (no JSON parse): emit with `proof: 'mime_misinterpretation'`.

**Detector file:** `packages/cli/src/classify/drag-drop.ts` (new). ≤120 lines.
**Sample assertion:** `expect(detection.interactionContext.proof).toMatch(/^(dragover_no_preventDefault|drop_silent_no_op|mime_misinterpretation)$/);`

### 6.2 `paste_handler_failure`

**Variant payload:** `{ kind: 'paste'; source; payload }`
**Gate:** action.kind ∈ {'fill','submit'} AND target has `[contenteditable]` OR `<textarea>` OR `<input type=text>`.
**Sources (4 fixtures):**
- `plain_text`: `"hello world\n• bullet\n• another"`
- `word_html`: `"<!--StartFragment--><p class=MsoNormal>Word paste</p><!--EndFragment-->"` — Microsoft Office quirks
- `excel_html`: `"<table><tr><td>A1</td><td>B1</td></tr></table>"` — table paste
- `styled_html_with_script`: `'<p style="color:red">Pre</p><script>window.__pasteFired=true</script><p>Post</p>'` — XSS sanity check

**Synthetic event:** `dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))` where `dt` is a `DataTransfer` with both `text/plain` and `text/html` set.
**Detection signals:**
- React state divergence: `field.value !== expectedFrom(payload, source)`. Emit with `proof: 'state_value_mismatch'`.
- DOM contains executed-tag: `document.querySelector('[contenteditable] script, textarea + script')` non-null after paste, or `window.__pasteFired === true` (the XSS variant). Emit with `proof: 'script_executed_or_persisted'`.
- Console error fired during paste: emit with `proof: 'console_error_during_paste'`.
- `document.execCommand` deprecation warning: ignore (browser noise).

**Detector file:** `packages/cli/src/classify/paste-handler.ts` (new).

### 6.3 `autofill_state_desync`

**Variant payload:** `{ kind: 'autofill'; field; value }`
**Gate:** form has at least one input with `autocomplete=`-attribute matching variant.field (e.g., `autocomplete="email"`). Resolved by post-snapshot scan.
**Synthetic event:** A real browser autofill triggers a non-`InputEvent` `change` without firing `input` in the React-lifecycle order React expects. Simulate via `nativeInputValueSetter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))` — but **omit** the `input` event in the failure case to mimic stale autofill.
**Detection:**
- Submit the form after autofill. If form payload is empty OR validation marks field as empty when `el.value` shows the autofilled value, emit `autofill_state_desync` with `proof: 'controlled_value_not_synced'`.
- React hydration warning about controlled/uncontrolled in console after autofill: emit with `proof: 'controlled_uncontrolled_warning'`.

**Detector file:** `packages/cli/src/classify/autofill.ts` (new).

### 6.4 `animation_state_corruption`

**Variant payload:** `{ kind: 'animation_mid_transition'; transitionTriggerSelector; intercedingActionDelayMs }`
**Gate:** action targets element where `getComputedStyle(el).transitionDuration !== '0s'` OR `animationDuration !== '0s'`. The trigger is generally a modal-open, drawer, accordion, or dropdown.
**Sequence:**
1. Click `transitionTriggerSelector` → opens modal/drawer.
2. Wait `intercedingActionDelayMs` (default: half of measured transition duration; min 50ms; max 500ms).
3. Dispatch the action's normal event (e.g., another click, or Escape, or click-outside) DURING the transition.
4. Observe.

**Detection:**
- Focus on detached node: `document.activeElement.isConnected === false` after both events. Emit with `proof: 'focus_on_detached_node'`.
- Console warning about React unmounting during animation. Emit with `proof: 'unmount_during_animation_warning'`.
- DOM has both pre- and post-state classes: emit with `proof: 'transition_class_overlap'`.
- Modal still in DOM and tab-trapped after dismiss attempt: emit with `proof: 'modal_dismiss_mid_fade_stuck'`.

**Detector file:** `packages/cli/src/classify/animation-corruption.ts` (new). Reuses focus-tracker.

### 6.5 `print_stylesheet_broken`

**Variant payload:** `{ kind: 'print' }`
**Gate:** none (every route is candidate).
**Sequence:** After baseline render, emulate `print` media (`emulateMedia({ media: 'print' })`), screenshot, vision-diff vs baseline screenshot.
**Detection signals:**
- Vision-diff score > envVisionThreshold AND the diff zone covers > 30% of the page → emit with `proof: 'mass_layout_diff_in_print'`.
- DOM-clip scan: any element with `getBoundingClientRect()` extending past `window.innerWidth + 8px` in print media when it didn't in screen media → emit with `proof: 'print_horizontal_overflow'`.
- All visible text missing in print (e.g., `body { display: none } @media print` bug) → emit with `proof: 'print_content_hidden'`.
- No `@media print` rules in any stylesheet AND content is non-trivial (>500 chars on page) → emit with `proof: 'no_print_stylesheet_defined'`. **NOTE:** This proof is borderline-noisy; gate behind config flag `printStylesheetRequired: true` (default false; opt-in for sites that should have print views).

**Detector file:** `packages/cli/src/classify/print-stylesheet.ts` (new).

### 6.6 `reduced_motion_violation`

**Variant payload:** `{ kind: 'reduced_motion' }`
**Gate:** route has at least one CSS-animated element OR `<video autoplay>`. Detected via `document.querySelectorAll('video[autoplay], [class*=animate-], .carousel, .marquee')` non-empty OR computed-style scan finding non-zero animation-duration.
**Sequence:** `emulateMedia({ reducedMotion: 'reduce' })`, wait 1000ms, scan.
**Detection:**
- Any `getComputedStyle(el).animationPlayState === 'running'` AND `getComputedStyle(el).animationDuration !== '0s'` → emit with `proof: 'animation_still_running_under_reduced_motion'` and `violatingSelector` (CSS path of first violator).
- Any `<video autoplay>` still playing (`videoEl.paused === false`) → emit with `proof: 'autoplay_video_under_reduced_motion'`.

**Detector file:** `packages/cli/src/classify/reduced-motion.ts` (new).

### 6.7 `forced_colors_failure`

**Variant payload:** `{ kind: 'forced_colors' }`
**Gate:** none.
**Sequence:** `emulateMedia({ forcedColors: 'active' })`, screenshot, vision-diff + DOM-clip scan + focus-indicator presence check.
**Detection:**
- Vision-diff score > envVisionThreshold AND the diff covers focus indicators (post-tab focus is invisible) → emit with `proof: 'focus_indicator_invisible'`.
- Element with background-image-as-icon now has zero visual extent (`getBoundingClientRect().width === 0` OR element with `background-image: url(...)` and no contained text) → emit with `proof: 'background_image_icon_invisible'`.
- Custom-color-only text now reads `inherit`-defaulted: detected by sampling computed-styles before/after — if text-color went from `rgb(...)` to `CanvasText` AND background was previously a `linear-gradient(...)` that's now `Canvas` → that's working as designed. We do NOT flag this. We only flag layout breakage (clip / disappear).

**Detector file:** `packages/cli/src/classify/forced-colors.ts` (new).

### 6.8 `dark_mode_layout_break`

**Variant payload:** `{ kind: 'dark_mode' }`
**Gate:** none.
**Sequence:** `emulateMedia({ colorScheme: 'dark' })`, screenshot, vision-diff + contrast-pair sampling.
**Detection:**
- Vision-diff score > envVisionThreshold AND the diff zones include text regions → emit with `proof: 'mass_text_color_collision_under_dark'`.
- Contrast-pair sampling: for 20 random text nodes, sample foreground/background and compute WCAG contrast ratio. If > 5 nodes fall below 4.5:1 (AA normal) AND the same nodes passed in light mode → emit with `proof: 'contrast_collapsed_in_dark'`.
- An `<svg>` icon with `fill="currentColor"` but parent text-color hardcoded `#000` — light-mode-OK, dark-mode-invisible. Detected: any `<svg>` with `getBoundingClientRect()` non-zero but rendered-pixel-mean within 10/255 of its parent's background → emit with `proof: 'svg_icon_invisible_in_dark'`.

**Detector file:** `packages/cli/src/classify/dark-mode.ts` (new).

### 6.9 `zoom_layout_break`

**Variant payload:** `{ kind: 'zoom_200'; zoomFactor: 2.0 }`
**Gate:** none.
**Sequence:** `setZoom(2.0)` — implementation detail: emulate by setting `document.documentElement.style.zoom = '2'` AND `setViewport(width/2, height/2)` to provoke real reflow. (Browsers' `--device-scale-factor` flag is more accurate but camofox v0.1 doesn't expose it; the dual-path approximation is sufficient for layout-break detection.)
**Detection:**
- `document.documentElement.scrollWidth > window.innerWidth + 8` → emit with `proof: 'horizontal_scrollbar_at_zoom_200'`.
- DOM-clip scan: any focusable element (button/link/input) with `getBoundingClientRect().right > window.innerWidth` → emit with `proof: 'focusable_element_clipped_at_zoom_200'`.
- Sticky/fixed-positioned header overlapping main content (intersection of `[role=banner]` or first sticky/fixed and `<main>` after zoom) → emit with `proof: 'sticky_header_overlap_at_zoom_200'`.

**Detector file:** `packages/cli/src/classify/zoom-layout.ts` (new).

---

## 7. Executor extension (`packages/cli/src/phases/execute.ts`)

### 7.1 Signature change

`executeUiTest` and `executeUiTestInner` add an optional `interactionPaletteVariant` parameter, sourced from `tc.action.interactionPalette`:

```ts
async function executeUiTestInner(
  scope: TabScope,
  tc: TestCase,
  // ... existing params
  interactionVariant?: InteractionPaletteVariant,
): Promise<TestResult> {
  // ... existing pre-action setup

  // v0.38: apply interaction-palette environment BEFORE the action.
  // Per-variant teardown registered via try/finally.
  let teardown: (() => Promise<void>) | undefined;
  if (interactionVariant !== undefined) {
    const setup = await applyInteractionVariantEnv(scope, interactionVariant);
    if (!setup.ok) {
      return makeSkipResult(tc, setup.reason);
    }
    teardown = setup.teardown;
  }

  try {
    // existing action execution...

    // v0.38: synthetic-event variants run synthetic event INSTEAD OF or AFTER the action,
    // depending on family. See applyInteractionVariantAction below.
    if (interactionVariant !== undefined && isSyntheticVariant(interactionVariant)) {
      const evt = await applyInteractionVariantAction(scope, tc, interactionVariant);
      // detector dispatch on evt
    }
  } finally {
    if (teardown !== undefined) await teardown();
  }
}
```

### 7.2 Adapter additions

```ts
// packages/cli/src/adapters/browser-mcp.ts
export type EmulateMediaOptions = {
  media?: 'screen' | 'print';
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  forcedColors?: 'active' | 'none';
};

export type TabScope = {
  // ... existing methods
  /** v0.38: emulate CSS media features. Optional for backward compat. */
  emulateMedia?(options: EmulateMediaOptions): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** v0.38: set browser zoom factor. Optional. */
  setZoom?(factor: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** v0.38: dispatch a synthetic DOM event with a custom DataTransfer. Optional. */
  dispatchSyntheticEvent?(args: SyntheticEventArgs): Promise<{ ok: true; observed: SyntheticEventObservation } | { ok: false; reason: string }>;
};

export type SyntheticEventArgs = {
  selector: string;
  type: 'dragstart' | 'dragover' | 'drop' | 'paste' | 'input' | 'change' | 'click';
  dataTransferEntries?: Array<{ mime: string; data: string }>;
  clipboardData?: { plain?: string; html?: string };
  /** When true, also trigger preventDefault-detection for compound events (drag-and-drop). */
  observePreventDefault?: boolean;
};

export type SyntheticEventObservation = {
  defaultPrevented: boolean;
  consoleErrorCountDelta: number;
  domStateChange: boolean;
  reactStateValueAfter?: string;
};
```

### 7.3 Telemetry

Append to `summary.json.execute`:

```ts
interactionPaletteTelemetry: {
  enabled: boolean;
  variantsRequested: ReadonlyArray<InteractionPaletteVariantKind>;
  perVariant: {
    [K in InteractionPaletteVariantKind]?: {
      casesPlanned: number;
      casesRan: number;
      casesSkipped: number;
      skipReasons: Record<string, number>; // 'gate_predicate_false' | 'adapter_unsupported' | 'route_already_baselined' | 'vision_budget_exhausted' | 'action_shape_incompatible'
      detectionsEmitted: number;
    };
  };
}
```

### 7.4 Animation timing — non-flake design

The `animation_mid_transition` variant is the most flake-prone. Defensive design:

1. **Measure first.** Before the test, read `getComputedStyle(target).transitionDuration` and `animationDuration`; pick the larger; halve it. That's `intercedingActionDelayMs`.
2. **Listen, don't sleep.** Attach a `transitionrun` listener on the target. The intervening event fires from inside the listener via microtask queue (`Promise.resolve().then(...)`), guaranteeing the transition has actually started.
3. **Three-of-three consensus.** Like V19's `interleaved_mutations`, the `animation_mid_transition` variant runs three times; finding stands only if 2-of-3 agree. Reuses the same `consensusRuns` plumbing.
4. **Bounded timeout.** If the transition never starts within 500ms, skip with `reason: 'transition_did_not_start'`.

---

## 8. CLI flag (`--interaction-palette`)

### 8.1 Help-text additions

```
Interaction palette (v0.38):
  --interaction-palette                 Enable all 9 variants
  --interaction-palette <list>          Enable comma-separated subset:
                                          drag_drop, paste, autofill, animation_mid_transition,
                                          print, reduced_motion, forced_colors, dark_mode, zoom_200
  --no-interaction-palette              Disable even if config has it on
  --interaction-palette-max <n>         Cap total interaction tests (default 300)
  --interaction-vision-threshold <f>    Env-variant vision threshold (default 0.18)
```

### 8.2 Resolution rules

- CLI flag overrides config.
- `--interaction-palette` (no value) = enable all variants.
- `--interaction-palette dark_mode,zoom_200` = enable only those two.
- `--no-interaction-palette` always wins.
- A variant requested but unsupported by the adapter (no `emulateMedia`) → variant is recorded as `skipReason: adapter_unsupported` per case, run continues.

### 8.3 No new top-level command

All wiring is part of `bughunter run`. No `bughunter interaction-palette` namespace; the CLI surface stays bounded.

---

## 9. Cost control — the action × palette × role explosion

Without controls, the matrix is: `routes (R) × roles (Q) × actions per route (A) × interaction_variants (V) = R·Q·A·V`. Aspectv3 has roughly `R=12, Q=2, A=15, V=9`, which is 3,240 new tests on top of the existing baseline. That's 6× the run length. Unacceptable.

### 9.1 Principle: additive, not multiplicative

The interaction palette is designed to be **additive** to the existing test count, not multiplicative:

```
baseline_tests           = R·Q·A·input_palette_count   (≈ existing total)
interaction_extra_tests  = (Σ per-action V_compatible) + (R·Q·V_per_route)
                           [bounded ≤ R·Q·A·1 per per-action variant + R·Q·1 per per-route variant]
```

Where `V_compatible ≤ 4` (only synthetic-event variants run per action) and `V_per_route ≤ 5` (only env variants run per route).

### 9.2 Mechanism: happy-only multiplication

Per-action variants attach **only** to `palette === 'happy'` test cases. Cuts the per-action multiplier from 5 (full palette) to 1.

### 9.3 Mechanism: action-shape gating

Each variant declares a gate predicate (§4.2). Variants that don't apply skip with `gate_predicate_false`. Empirically: `paste` applies to ~10% of actions, `drag_drop` ~5%, `autofill` ~15%, `animation_mid_transition` ~25%. Aggregate per-action overhead: ~55% of `A·1`.

### 9.4 Mechanism: per-route once-only env variants

Env variants (`print`, `dark_mode`, `forced_colors`, `reduced_motion`, `zoom_200`) run **once per (route, role)**, not once per action. Baselined-routes set:

```ts
const interactionVariantBaselined: Set<string> = new Set();
// key: `${pageRoute}|${role}|${variant.kind}`
```

After the route's first action completes successfully, the executor schedules the env-variant pass as a sibling (no action; just emulate + screenshot + detector). This adds `R·Q·5` test cases, regardless of `A`.

### 9.5 Mechanism: vision-budget integration

Env variants that require vision (`dark_mode`, `print`, `forced_colors`) consume from the existing `VisionBudget`. When budget is exhausted, variants degrade:
- `dark_mode`: skip vision, fall back to contrast-pair sampling only. Still emits findings on contrast collapse.
- `print`: skip vision; still detects DOM-clip + content-hidden via DOM scan.
- `forced_colors`: skip vision; falls back to focus-indicator presence + DOM-clip.

`reduced_motion` and `zoom_200` don't require vision.

### 9.6 Mechanism: `--interaction-palette-max` hard cap

Default cap: 300 test cases across all variants. Planner sorts variants by expected-yield (env > synthetic > timing) and trims excess from the lowest-yield bucket.

### 9.7 Empirical projection (Aspectv3, R=12, Q=2, A=15)

| Variant | Cases minted | Cases run (after gating + caps) |
|---|---|---|
| drag_drop | 360 (R·Q·A) | ~18 (5% gate) |
| paste | 360 | ~36 (10% gate) |
| autofill | 360 | ~54 (15% gate) |
| animation_mid_transition | 360 | ~90 (25% gate) |
| print | 24 (R·Q) | 24 |
| reduced_motion | 24 | 24 |
| forced_colors | 24 | 24 |
| dark_mode | 24 | 24 |
| zoom_200 | 24 | 24 |
| **Total** | **1,560 minted** | **~318 ran (after gating)** |

Hard cap of 300 trims to 300; baseline run was ~600 tests, so V38 adds ~50% to runtime — under the 1.4× target by trimming aggressively. Telemetry surfaces what got trimmed.

### 9.8 Skip-reason taxonomy

| Skip reason | Meaning |
|---|---|
| `gate_predicate_false` | Variant's compatibility predicate evaluated false (no contenteditable, no autocomplete attr, etc.) |
| `adapter_unsupported` | Camofox build doesn't support `emulateMedia` / `setZoom` / `dispatchSyntheticEvent` |
| `route_already_baselined` | Per-route variant already ran for this (route, role) |
| `vision_budget_exhausted` | Vision quota consumed; env variants degraded |
| `action_shape_incompatible` | Variant's `applies_to` ActionKind list doesn't include this action |
| `interaction_palette_cap` | `--interaction-palette-max` hit, this variant trimmed |
| `transition_did_not_start` | Animation variant: target had no measured transition within 500ms |

All skip reasons surface in `summary.json.execute.interactionPaletteTelemetry.perVariant.<kind>.skipReasons`.

---

## 10. Acceptance

| Criterion | Verifier |
|---|---|
| All new TS types compile | `npx tsc --noEmit` |
| All new BugKinds appear in `KIND_PRIORITY` | `bughunter detectors --kind <new-kind>` returns wired (after V38 lands) |
| All new cluster-signature cases reachable | unit test in `packages/cli/src/cluster/signature.test.ts` |
| `--interaction-palette` flag parses and is honored | `bughunter run --interaction-palette dark_mode,print` → telemetry shows only those two |
| Aspectv3 smoke run produces ≥1 cluster from V38 family | `jq '.clusters[] \| select(.kind \| test("dark_mode\|reduced_motion\|zoom\|print\|paste\|autofill\|drag\|animation_state\|forced_colors"))' summary.json` non-empty |
| Aspectv3 smoke run-time ≤ 1.4× baseline | wall-clock timing |
| Unit tests for each detector | `npx vitest run packages/cli/src/classify/{drag-drop,paste-handler,autofill,animation-corruption,print-stylesheet,reduced-motion,forced-colors,dark-mode,zoom-layout}.test.ts` |
| Telemetry shape passes Zod (if Zod schema added) | `npx vitest run summary.test.ts` |
| Skip-reasons telemetry sums to (planned − ran) per variant | unit test |
| `npx eslint . --max-warnings 0` clean | eslint |
| Vision-budget exhaustion gracefully degrades env variants | unit test simulating budget=0 |

### 10.1 Self-test fixture

Add `fixtures/interaction-palette-deliberate-bugs/` (one app, multiple kinds):
- A `<div draggable=true>` next to a `<div data-droppable>` with `dragover` listener missing `preventDefault` → triggers `drag_drop_failure`.
- A `<textarea>` whose paste handler ignores `<script>` sanitization → triggers `paste_handler_failure`.
- A `<form>` with `<input autocomplete=email>` that uses `<input value={x} onChange={...}>` (controlled) but ignores autofill → triggers `autofill_state_desync`.
- A modal with 2s open transition that doesn't trap focus during fade → triggers `animation_state_corruption`.
- No `@media print` rules + content-heavy page → triggers `print_stylesheet_broken` (with config flag).
- A CSS `animation: spin 2s infinite` that ignores `@media (prefers-reduced-motion: reduce)` → triggers `reduced_motion_violation`.
- A button with `outline: none` and no fallback focus indicator under forced-colors → triggers `forced_colors_failure`.
- A page with `color: #111; background: white` hardcoded with no `@media (prefers-color-scheme: dark)` override → triggers `dark_mode_layout_break`.
- A `width: 1024px` fixed-width container → triggers `zoom_layout_break` at 200% on a 1280px viewport.

Self-test acceptance: `bughunter self-test --interaction-palette` produces ≥1 cluster per declared bug; 0 false positives outside the deliberate set.

---

## 11. Files

### 11.1 Files to create

| Path | Purpose | LoC est. |
|---|---|---|
| `packages/cli/src/mutation/interaction-palette.ts` | `mintInteractionPaletteCases()` — the planner step | ~180 |
| `packages/cli/src/classify/drag-drop.ts` | Detector | ~120 |
| `packages/cli/src/classify/paste-handler.ts` | Detector | ~120 |
| `packages/cli/src/classify/autofill.ts` | Detector | ~100 |
| `packages/cli/src/classify/animation-corruption.ts` | Detector | ~140 |
| `packages/cli/src/classify/print-stylesheet.ts` | Detector | ~130 |
| `packages/cli/src/classify/reduced-motion.ts` | Detector | ~100 |
| `packages/cli/src/classify/forced-colors.ts` | Detector | ~120 |
| `packages/cli/src/classify/dark-mode.ts` | Detector | ~140 |
| `packages/cli/src/classify/zoom-layout.ts` | Detector | ~120 |
| `packages/cli/src/classify/{each}.test.ts` | Unit tests | ~80×9 = 720 |
| `fixtures/interaction-palette-deliberate-bugs/` | Self-test fixture app | ~400 |

### 11.2 Files to modify

| Path | Change | LoC est. |
|---|---|---|
| `packages/cli/src/types.ts` | + 9 BugKinds, `InteractionPaletteVariant`, `InteractionContext`, `InteractionPaletteConfig`, optional `Action.interactionPalette`, `BugDetection.interactionContext` | ~80 |
| `packages/cli/src/phases/plan.ts` | Call `mintInteractionPaletteCases` after input-palette step | ~40 |
| `packages/cli/src/phases/execute.ts` | Add `interactionVariant` param to `executeUiTest`/`executeUiTestInner`; apply env/event setup; teardown in finally | ~120 |
| `packages/cli/src/adapters/browser-mcp.ts` | + `emulateMedia`, `setZoom`, `dispatchSyntheticEvent` (optional) on TabScope | ~80 |
| `packages/cli/src/adapters/browser-mcp.ts` (camofox impl) | Implement the three optional methods via Playwright/CDP | ~100 |
| `packages/cli/src/cluster/signature.ts` | + 9 cluster-sig cases | ~30 |
| `packages/cli/src/classify/cluster-priority.ts` | Slot 9 kinds in priority tiers | ~15 |
| `packages/cli/src/cli/run.ts` | Resolve `--interaction-palette*` flags into config | ~40 |
| `packages/cli/src/cli/main.ts` | USAGE help text | ~10 |
| `packages/cli/src/types.ts` | `BugHunterConfig` += `interactionPalette` | ~5 |

### 11.3 DO NOT touch

- `packages/cli/src/mutation/apply.ts` — interaction palette lives next to it, not inside it.
- `packages/cli/src/security/injection-palette.ts` — XSS canary system unrelated.
- Existing detectors (vision, a11y baseline, etc.) — only extend via new detectors that consume their existing outputs.

---

## 12. Definition of Done

1. All 9 BugKinds appear in `BugKind` union and `KIND_PRIORITY`.
2. All 9 detectors have unit tests with at least one passing positive case and one negative case (no-bug).
3. `--interaction-palette` flag parses, resolves, and the run honors it.
4. Aspectv3 smoke run with `--interaction-palette dark_mode,print,zoom_200,reduced_motion` produces:
   - At least one cluster from a V38 BugKind
   - Telemetry block populated for all 4 requested variants
   - 0 infrastructureFailure entries attributed to interaction palette
   - Total runtime ≤ 1.4× baseline
5. Self-test fixture exists and `bughunter self-test --interaction-palette` produces 1 cluster per deliberate bug.
6. `npx tsc --noEmit` clean.
7. `npx eslint . --max-warnings 0` clean.
8. `npx vitest run` clean.
9. Build clean: `npm run build`.
10. Coverage report (per V38 acceptance §10) lists all 9 BugKinds with `wired` status and last-fired timestamp.
11. SPEC_PATH_TO_EXHAUSTIVE.md §3.3 cross-references this V-spec for the kinds it lists.
12. No `as any`, no implicit returns on exported functions, no functions > 40 lines.

---

## 13. Risks + escape hatches

- **Risk: Camofox doesn't support `emulateMedia` for forced-colors.** Playwright supports `forcedColors` since 1.27 (2022). Camofox v0.1 wraps Playwright, so the capability exists if the MCP method is wired. If not wired, V38 work for that variant gracefully skips. **Escape:** add capability detection in `bughunter doctor`.
- **Risk: synthetic `DataTransfer` events behave differently from real ones in Chromium.** True for native file drops; not for text/html drops, which is what V38 covers. We do NOT promise file-drop coverage. Documented in §1 out-of-scope.
- **Risk: `animation_state_corruption` is flake-prone.** Mitigation: 3-of-3 consensus, transition-listener-driven timing (§7.4), bounded skip on `transition_did_not_start`. Like V19's `interleaved_mutations`, accept some flake but cap with consensus.
- **Risk: env-variant vision-diff false-positives because every dark-mode page differs from baseline.** Mitigation: looser threshold (`envVisionThreshold: 0.18` vs baseline `0.10`), and the diff is supplemented with structural-DOM signals (clip, contrast-pair, focus-indicator presence) so we're not relying on vision alone.
- **Risk: `print_stylesheet_broken` floods every site that doesn't ship a print stylesheet.** Mitigation: the `no_print_stylesheet_defined` proof variant is gated behind `printStylesheetRequired: true` config (default false). Other proofs (mass-layout-diff, content-hidden, horizontal-overflow) are non-noisy.
- **Escape hatch: `--no-interaction-palette` always wins.** Users who hit pathological cases can disable cleanly.

---

## 14. Killer-demo runbook (Aspectv3)

```bash
# 1. Confirm V18 prereq landed (JWT login works on Aspectv3)
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.discovery.visionBaselineTelemetry.authLostMidLoop' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Expected: false

# 2. Confirm camofox build supports emulateMedia + setZoom
curl -sS http://127.0.0.1:9377/health | jq '.capabilities.emulateMedia'
# Expected: true (if false, V38 env variants skip with adapter_unsupported)

# 3. Run with V38 enabled
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --max-bugs 200 --budget 3600000 \
    --a11y --a11y-strict --seo \
    --interaction-palette dark_mode,reduced_motion,zoom_200,print

# 4. Verify
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.execute.interactionPaletteTelemetry' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Expected: 4 variants reported, casesRan > 0 for each, detectionsEmitted > 0 for at least one

jq '.clusters[] | select(.kind | test("dark_mode|reduced_motion|zoom|print"))' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Expected: at least 1 cluster

# 5. Compare runtime vs baseline
jq '.run.durationMs' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
# Compare to a recent baseline run (without --interaction-palette); should be ≤ 1.4× baseline
```

---

## 15. Open questions

1. **Should `print_stylesheet_broken` default to flagging "no @media print rules at all"?** Currently spec says no — `printStylesheetRequired: true` config flag opt-in. Most vibe-coded SPAs don't have print views. Flagging by default would generate ~1 cluster per site. Lean opt-in. **Decision needed before coder starts.**

2. **Should `dark_mode_layout_break` also fire on light-mode-default sites that have NO `prefers-color-scheme: dark` rule?** Same shape as Q1. Lean opt-in: a site that intentionally opts out of dark-mode is not buggy. Only flag explicit breakage. **Decision needed before coder starts.**

3. **Should `zoom_layout_break` test multiple zoom levels (125%, 150%, 200%, 400%)?** WCAG 1.4.10 specifies 400% as the strict criterion; 200% is what most users actually use. Spec says one level (200%) for v0.38. Adding levels = N× the env variant cost. Defer multi-level zoom to v0.39 if 200% is too lenient.

4. **Should `forced_colors_failure` distinguish between "expected color override" (working as designed) and "layout breakage" (bug)?** Spec says yes — only flag layout breakage (clip/disappear/invisible focus), not color shifts. But the line is fuzzy; some apps style focus indicators with custom colors that vanish under forced-colors. Vision-diff threshold tuning will surface this in practice.

5. **Should `animation_state_corruption` also test on `<dialog>` elements specifically?** Modal dialogs are the highest-yield target (focus trap + transition + close-mid-fade is a common bug). Current spec gates by computed-style having a transition; should we add a dedicated `<dialog>` selector boost? Lean: yes, but as an internal-priority hint inside the gate, not a config flag.

6. **`paste_handler_failure` with `styled_html_with_script` — is this stepping on V07 XSS territory?** XSS palette already injects via form fill. Paste is a different attack surface (clipboard → contenteditable → potentially executed). Decision: V38 detects paste-handler bugs (does the handler sanitize?), V07 detects reflection-based XSS (does the server reflect?). Different. Document the boundary in V07 cross-reference.

7. **Should the per-route variants run in their own tabs (parallel) or in the singleton tab (serial)?** Cost-control says serial in singleton tab (saves auth, saves discovery). Risk: env emulation leaks across tests if teardown fails. Mitigation: explicit `emulateMedia({})` reset in finally; integration test verifies no leak.

8. **Is `setZoom` via `document.documentElement.style.zoom = '2'` a faithful approximation?** No — real browser zoom changes media-query evaluation, layout viewport, and font scaling. The CSS `zoom` property only scales rendered output. For layout-break detection (the V38 goal), the approximation is sufficient because real layout breakage is provoked by viewport mismatch (which we ALSO emulate via `setViewport`). For pixel-perfect `zoom_layout_break` reproduction, defer to a v0.39 CDP-based path.

9. **Should `interactionPaletteKind` on TestCase be redundant with `action.interactionPalette?.kind`?** Yes — it's denormalized for cluster-signature speed and telemetry indexing. The planner sets it; the executor never writes to it. Redundancy documented.

---

## 16. Cross-references

- `SPEC_PATH_TO_EXHAUSTIVE.md` §3.3 (table of form/input edge cases this spec implements)
- `SPEC_PATH_TO_EXHAUSTIVE.md` §9 Phase E (V38 is the form-input-edge-cases sub-phase)
- `SPEC_V15_VISION_CONSISTENCY.md` (vision-diff harness reused here)
- `SPEC_V17_*` (multi-viewport — `setViewport` plumbing reused for `zoom_200`)
- `SPEC_V18_JWT_LOGIN_VERIFY.md` (V-spec format mirror)
- `SPEC_V19_RACE_CONDITIONS.md` (consensus-runs pattern reused for `animation_mid_transition`; sibling spec for timing-sensitive detection)
- `SPEC_V06_A11Y_SEO.md` (focus-tracker reused for animation/forced-colors)
