# SPEC — v0.6 "Accessibility & SEO baseline"

**Status:** Draft 1 — ready for `@coder` assignment after v0.6 perf merges · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Sibling spec:** `SPEC_V06_PERFORMANCE.md` · **Predecessor:** v0.4 vision (`accessibility_critical` delta-mode shipped) · **Successor:** v0.7 static-analysis & code-hygiene.

This spec is the **implementation contract** for the a11y/SEO half of v0.6. The perf half is a separate spec because the two clusters share zero infrastructure — perf needs HAR + CDP, a11y/SEO needs DOM probing of static page state. Both ship under the v0.6 banner.

---

## 0. Reading guide

| Section | Audience | When to read |
|---|---|---|
| §1 Objective + boundaries | everyone | first |
| §2 Existing code map | `@coder` | before keyboard touch |
| §3 New modules | `@coder` per module | before that module's tasks |
| §4 BugKind specs | `@coder` per kind | before that kind's tasks |
| §5 Config / CLI surface | `@coder` | before CLI work |
| §6 Negative requirements | everyone | before commit |
| §7 Task breakdown + ownership | `@architect` (assigning) + assignee | per task |
| §8 Acceptance + done-when matrix | `@qa` + `@architect` | end of phase |
| §9 Killer-demo runbook (TraiderJo) | `@architect` closing | end-of-phase verification |
| §10 Risk + escape hatches | everyone | before commit |

---

## 1. Objective

Ship **11 new `BugKind`s** in two clusters (a11y baseline + SEO hygiene) plus **two new modules** (`classify/a11y-baseline.ts`, `classify/seo.ts`) plus **one runtime probe** (`adapters/keyboard-trap-probe.ts`) layered on the existing browser MCP session. No new external runtime dependency: axe-core is already loaded by v0.4 a11y delta. `cheerio` is already a dev-dep of `@anthropic-ai/sdk` via the bundle path; if needed for SEO HTML scraping, vendor a 60-line minimal HTML title/meta extractor instead.

Eleven kinds:

**A11y baseline cluster (5 kinds):**
1. `axe_color_contrast_strong` — WCAG AA (4.5:1 normal text, 3:1 large text) failures from `axe-core` baseline scan. Promoted from delta.
2. `keyboard_trap` — Tab-key focus cannot escape a focusable element after N presses (default 20).
3. `focus_lost_after_action` — Element handling a triggered action loses or misroutes focus (focus lands on `<body>` or `null`).
4. `image_missing_alt` — `<img>` element without `alt` attribute (axe rule `image-alt`, baseline).
5. `form_input_unlabeled` — `<input>`/`<select>`/`<textarea>` without associated label (axe rule `label`, baseline).

**SEO hygiene cluster (6 kinds):**
6. `seo_title_missing` — Page lacks `<title>` or has empty title.
7. `seo_title_duplicate_across_routes` — Same `<title>` on >1 distinct crawled route.
8. `seo_meta_description_missing` — Page lacks `<meta name="description">` or content is empty.
9. `seo_canonical_missing` — Page lacks `<link rel="canonical">` (only flagged when at least one peer page has one — heuristic against single-page apps where the rule is N/A).
10. `seo_h1_missing_or_multiple` — Page has 0 or >1 `<h1>` elements.
11. `seo_robots_blocking_crawl` — `robots.txt` blocks `/` from `Allow: *` *or* page has `<meta name="robots" content="noindex">` *and* the page is reachable via crawl (i.e., the site disagrees with itself).

**Out of scope** for this spec (do not implement, even partially):

- `keyboard_navigation_full_audit` (running every action with keyboard-only) — v0.7. Today we ship the trap detector only.
- `focus_visible_missing` — requires CSS analysis. Deferred until v0.7's static analyzer covers CSS.
- ARIA-tree consistency / role conflicts — deferred to v0.7. The axe rules `aria-*` we already have running in delta mode cover the common cases.
- Lighthouse SEO / Lighthouse a11y wrap — same rationale as v0.6 perf. Lighthouse adds ~30MB and runs its own Chrome. Native checks here are sufficient for the catalog.
- Multi-language / i18n SEO checks (`<html lang>`, `<meta charset>`, hreflang, etc.) — v0.8.
- Sitemap.xml validation — v0.8.
- Open Graph / Twitter card meta — v0.8.
- Structured-data (JSON-LD) validation — v0.8.
- Heading-hierarchy skipping (h1→h3) — heuristic with too many false positives on real component-driven SPAs. Reconsider in v0.8.

The shape of the a11y/SEO half: **two new classifier modules** (`a11y-baseline.ts`, `seo.ts`) reading from the same browser session that v0.5 already opens for vision, **one runtime probe** (`keyboard-trap-probe.ts`) called once per page, and eleven detectors layered on top. Per-page, not per-action — the v0.5 existing `accessibility_critical` delta detector remains the per-action a11y signal.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union + `BugDetection`. New kinds slot into the union next to `accessibility_critical` (line 32). New `seoContext` and `a11yContext` fields go on `BugDetection` (see §3.4). |
| `packages/cli/src/classify/accessibility.ts` | Existing `AXE_RUN_SCRIPT` + `classifyA11yDelta`. **Reuse** `AXE_RUN_SCRIPT`; **do not duplicate** the axe injection. Add a baseline path that mines the same `violations[]` for non-delta kinds. |
| `packages/cli/src/cluster/signature.ts` | New cases per BugKind. Pattern from existing `accessibility_critical` case (line 33). |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. New a11y kinds slot **at the same position as** `accessibility_critical`; SEO kinds slot **above** `visual_anomaly` and **below** all security kinds. |
| `packages/cli/src/phases/execute.ts` | The phase pipeline. Today calls `classifyA11yDelta` per action when `--a11y` is set. v0.6 a11y/SEO adds a **per-page hook** that runs once per unique `pageRoute` (after first visit, before any action) and emits baseline detections. |
| `packages/cli/src/discovery/pages.ts` | Page enumeration. SEO duplicate-title check needs the full list of page routes resolved before classification — fits naturally as a post-discovery, pre-execute pass. |
| `packages/cli/src/adapters/browser-mcp.ts` | Browser MCP adapter. The keyboard-trap probe runs against this — it issues a sequence of keyboard `Tab` events through the existing adapter; **do not** add a new browser session. |
| `packages/cli/src/cli/main.ts` | The `--a11y` flag exists at line 46; v0.6 adds `--seo` (independent), and `--a11y-strict` (extends `--a11y` to enable baseline + keyboard-trap + focus-lost). |
| `packages/cli/src/config.ts` | Config shape. New keys: `a11yStrict`, `seoEnabled`, `keyboardTrapMaxPresses` (default 20). |
| `packages/cli/src/repro/action-log.ts` | Action-log writer. Per-page baseline detections still go through `writeActionLog` — they're just at action-index 0. |

### 2.2 Patterns to follow

- **Per-page hook.** New baseline detections fire **once per unique `pageRoute`**, not per-action. Implementation: maintain a `Set<string>` of routes already baselined inside `phases/execute.ts`, gate the hook on first observation. Idempotent across restart because page route is the dedup key.
- **Cluster-signature normalization.** Every new BugKind defines its `clusterSignature` deterministically. Two findings with the same root cause (different role, different occurrence) collapse to one cluster.
- **Re-entrancy.** Zero global mutable state. RunState read exclusively from `runs/<runId>/`.
- **No new dependency.** axe-core is already injected; SEO scrapes via the existing browser MCP `evaluate` channel.

### 2.3 DO NOT

- Do **not** modify `BrowserMcpAdapter`. The keyboard probe is a sibling adapter.
- Do **not** create a new HTTP client; SEO `robots.txt` fetch reuses the existing surface-MCP adapter pattern (one origin, one fetch, cached).
- Do **not** write outside `runs/<runId>/`.
- Do **not** wrap Lighthouse.
- Do **not** duplicate axe injection — reuse `AXE_RUN_SCRIPT` from `classify/accessibility.ts`.
- Do **not** run keyboard-trap probe inside an action context. It runs **once per page**, not per-action; otherwise N actions × N tab presses degrades runtime by an order of magnitude.

---

## 3. New modules

### 3.1 `classify/a11y-baseline.ts` — baseline a11y classifier

**Purpose.** Run the existing `AXE_RUN_SCRIPT` once per page (not delta) and emit `BugDetection`s for the 5 a11y kinds.

**Public surface:**

```ts
export type A11yBaselineInput = {
  pageRoute: string;
  axeViolations: A11yViolation[];   // raw output of AXE_RUN_SCRIPT
  keyboardTrap?: KeyboardTrapResult; // null if probe skipped
  focusAfterAction?: FocusAfterActionResult; // null if no action ran on this page
};

export function classifyA11yBaseline(input: A11yBaselineInput): BugDetection[];
```

**Behavior.**
- Filter `axeViolations` to four buckets by `id`:
  - `id === 'color-contrast'` → emit one detection per node, kind `axe_color_contrast_strong`. Include `selectorClass` from `node.target[0]`.
  - `id === 'image-alt'` → emit one detection per node, kind `image_missing_alt`. Include `selectorClass` from `node.target[0]` plus the offending `<img src>` URL.
  - `id === 'label'` → emit one detection per node, kind `form_input_unlabeled`. Include `selectorClass` from `node.target[0]` plus the `name` attribute if present.
  - All other axe ids: ignored at baseline (delta path still handles them per-action).
- If `keyboardTrap?.trapped === true` → emit one detection, kind `keyboard_trap`. Include `selectorClass` of trapping element + tab-press count.
- If `focusAfterAction?.lost === true` → emit one detection per action, kind `focus_lost_after_action`. Include `selectorClass` of the originating trigger + the resolved `document.activeElement` tag (`'BODY'` or `null`).

**Side effects:** none. Pure function on input.

### 3.2 `adapters/keyboard-trap-probe.ts` — keyboard trap detection

**Purpose.** Per page, focus the first tabbable element, press `Tab` up to `keyboardTrapMaxPresses` times (default 20), and check if focus stays inside any single element across the whole sequence.

**Public surface:**

```ts
export type KeyboardTrapResult =
  | { trapped: true; selectorClass: string; pressCount: number; observedFocusChain: string[] }
  | { trapped: false };

export interface KeyboardTrapProbeInterface {
  probe(scope: TabScope, maxPresses: number): Promise<KeyboardTrapResult>;
}

export class PlaywrightKeyboardTrapProbe implements KeyboardTrapProbeInterface { /* ... */ }
```

**Behavior.**
1. `await scope.evaluate(() => document.body.focus())`.
2. For `i = 1..maxPresses`:
   - `await scope.keyboard.press('Tab')`.
   - `const sel = await scope.evaluate(() => document.activeElement?.tagName + (document.activeElement?.id ? '#' + document.activeElement.id : ''))`.
   - Push `sel` onto `chain`.
3. After the loop:
   - If `chain[0..maxPresses-1]` is the same element repeated → trap detected. Return `{ trapped: true, selectorClass: chain[0], pressCount: maxPresses, observedFocusChain: chain }`.
   - Else → return `{ trapped: false }`.

**Edge cases.**
- If no element is focusable on the page → return `{ trapped: false }` (page is non-interactive; not a trap).
- If keyboard press throws (browser crash, navigation fired) → caller treats as `infraFailure`; do not emit a trap detection.
- Implementation runs after page load, **before** any action triggers, to avoid cross-state contamination.

### 3.3 `adapters/focus-tracker.ts` — focus-after-action probe

**Purpose.** After each triggered action, observe whether focus is preserved (kept on a meaningful element).

**Public surface:**

```ts
export type FocusAfterActionResult =
  | { lost: false; activeElementTag: string }
  | { lost: true; activeElementTag: string | null; triggeringSelector: string };

export interface FocusTrackerInterface {
  observe(scope: TabScope, triggeringSelector: string): Promise<FocusAfterActionResult>;
}
```

**Behavior.**
- Called from `phases/execute.ts` immediately after every action that completes successfully.
- `await scope.evaluate(() => document.activeElement?.tagName ?? null)`.
- If result is `'BODY'` or `null` → `{ lost: true, activeElementTag, triggeringSelector }`.
- If result is any other tag → `{ lost: false, activeElementTag }`.
- One detection per **(triggeringSelector, pageRoute)**; cluster-signature collapses repeats.

**Performance budget.** ≤ 30ms per action. The evaluate is a single `tagName` read.

### 3.4 `classify/seo.ts` — SEO hygiene classifier

**Purpose.** Per page, scrape `<title>`, `<meta name="description">`, `<link rel="canonical">`, all `<h1>` elements, and the `<meta name="robots">` directive. Cross-reference with the project's `robots.txt`. Emit detections for the 6 SEO kinds.

**Public surface:**

```ts
export type SeoPageInput = {
  pageRoute: string;
  title: string | null;
  metaDescription: string | null;
  canonicalHref: string | null;
  h1Count: number;
  metaRobots: string | null;
};

export type SeoCorpusInput = {
  pages: SeoPageInput[];
  robotsTxt: string | null;
  origin: string;
};

export function classifySeoCorpus(input: SeoCorpusInput): BugDetection[];
```

**Behavior.**
- For each page:
  - `title === null || title.trim() === ''` → emit `seo_title_missing`.
  - `metaDescription === null || metaDescription.trim() === ''` → emit `seo_meta_description_missing`.
  - `canonicalHref === null` AND ≥1 other page in corpus has `canonicalHref !== null` → emit `seo_canonical_missing`.
  - `h1Count !== 1` → emit `seo_h1_missing_or_multiple` with `h1Count` in context.
  - `metaRobots?.toLowerCase().includes('noindex')` AND page reachable via crawl → emit `seo_robots_blocking_crawl`.
- Cross-page:
  - Group by `title` (lowercase, trimmed). Any group with > 1 distinct route → emit one `seo_title_duplicate_across_routes` detection per group.
- `robotsTxt` parsing: rudimentary — split by lines, find `User-agent: *` block, find `Disallow:` rules. If any rule disallows `/` AND the project's homepage is in the page corpus → emit `seo_robots_blocking_crawl`.

**Robust parsing.** Use a 30-line vendored mini-parser; do **not** add `robots-parser` as a runtime dep.

### 3.5 New `BugDetection` fields

Add to `types.ts`:

```ts
seoContext?: {
  field: 'title' | 'meta_description' | 'canonical' | 'h1' | 'robots_meta' | 'robots_txt';
  observedValue: string | null;
  expectedShape: string;
  affectedRoutes?: string[];        // for seo_title_duplicate_across_routes
};

a11yContext?: {
  axeRuleId?: string;               // 'color-contrast' | 'image-alt' | 'label'
  observedFocusChain?: string[];    // for keyboard_trap
  pressCount?: number;              // for keyboard_trap
  triggeringSelector?: string;      // for focus_lost_after_action
  activeElementTag?: string | null; // for focus_lost_after_action
};
```

Both fields are optional. Do **not** repurpose `headerContext` or `staticContext`; keep the schema typed-by-domain.

---

## 4. BugKind detection contracts

### 4.1 `axe_color_contrast_strong`

**Trigger.** Axe-core baseline run on a page surfaces a violation with `id: 'color-contrast'`.

**Cluster signature.** `axe_color_contrast_strong | <pageRoute> | <selectorClass>`.

**Done-when:** TraiderJo run produces ≥1 finding on the dashboard's stat-card text where contrast falls below 4.5:1.

### 4.2 `keyboard_trap`

**Trigger.** Keyboard trap probe returns `{ trapped: true }`.

**Cluster signature.** `keyboard_trap | <pageRoute> | <selectorClass>`.

**Edge cases.** Modal dialogs that intentionally trap focus until close (typical pattern) **will produce a positive**. Mitigation: probe runs on initial page load before any modal opens. Document this caveat in `BugDetection.rootCause`.

**Done-when:** Synthetic fixture with focus loop emits exactly 1 detection.

### 4.3 `focus_lost_after_action`

**Trigger.** Focus tracker reports `{ lost: true }` after a successful action.

**Cluster signature.** `focus_lost_after_action | <pageRoute> | <triggeringSelector>`.

**Edge cases.** Some actions intentionally move focus to body (e.g., closing a dropdown). Suppression: if the triggering action's element no longer exists in DOM after the action, treat as expected and **suppress**.

**Done-when:** Synthetic fixture with a button that calls `document.body.focus()` produces exactly 1 detection.

### 4.4 `image_missing_alt`

**Trigger.** Axe-core baseline `id: 'image-alt'`.

**Cluster signature.** `image_missing_alt | <pageRoute> | <selectorClass>`.

**Done-when:** Synthetic fixture with an `<img>` lacking `alt` produces exactly 1 detection.

### 4.5 `form_input_unlabeled`

**Trigger.** Axe-core baseline `id: 'label'`.

**Cluster signature.** `form_input_unlabeled | <pageRoute> | <selectorClass>`.

**Done-when:** Synthetic fixture with `<input>` lacking `<label>` produces exactly 1 detection.

### 4.6 `seo_title_missing`

**Trigger.** Page DOM lacks `<title>` element OR `title.trim() === ''`.

**Cluster signature.** `seo_title_missing | <pageRoute>`.

**Done-when:** Synthetic page with no title tag produces exactly 1 detection per page.

### 4.7 `seo_title_duplicate_across_routes`

**Trigger.** ≥2 distinct page routes share the same `title` (case-insensitive, trimmed).

**Cluster signature.** `seo_title_duplicate_across_routes | <normalizedTitle>`.

**Done-when:** Multi-page synthetic fixture with two routes sharing a title produces exactly 1 cluster with both routes in `affectedRoutes`.

### 4.8 `seo_meta_description_missing`

**Trigger.** Page lacks `<meta name="description">` OR content is empty after trim.

**Cluster signature.** `seo_meta_description_missing | <pageRoute>`.

### 4.9 `seo_canonical_missing`

**Trigger.** Page lacks `<link rel="canonical">` AND at least one peer page in the same corpus has one.

**Cluster signature.** `seo_canonical_missing | <pageRoute>`.

**Edge cases.** Single-page apps where no page has canonical → suppressed (zero detections). The "at least one peer has it" gate prevents universal-false-positive on canonical-free SPAs.

### 4.10 `seo_h1_missing_or_multiple`

**Trigger.** Page has 0 OR ≥2 `<h1>` elements.

**Cluster signature.** `seo_h1_missing_or_multiple | <pageRoute> | <h1Count>`.

### 4.11 `seo_robots_blocking_crawl`

**Trigger.** Page has `<meta name="robots" content="noindex">` AND was reached via crawl, OR `robots.txt` `Disallow: /` AND homepage is in the page corpus.

**Cluster signature.** `seo_robots_blocking_crawl | <pageRoute>`.

---

## 5. Config / CLI surface

```
--a11y                 (existing)  Enable accessibility_critical delta + axe injection.
--a11y-strict          (new)       Implies --a11y. Adds baseline + keyboard-trap + focus-lost detection.
--seo                  (new)       Enable SEO hygiene cluster.
--keyboard-trap-max=N  (new)       Default 20. Max tab presses during trap probe.
```

`config.ts` additions:

```ts
a11yStrict: boolean;
seoEnabled: boolean;
keyboardTrapMaxPresses: number; // default 20
```

Defaults:
- `--a11y-strict` is **off by default**. Adoption path: users already running `--a11y` migrate to `--a11y-strict` after their first run reviews the baseline noise.
- `--seo` is **off by default**. SEO is high-signal but ~30s extra runtime.

---

## 6. Negative requirements

- Coder must **not** modify `BrowserMcpAdapter`.
- Coder must **not** add a new browser session — keyboard probe + focus tracker reuse the existing scope.
- Coder must **not** add Lighthouse, robots-parser, or any new runtime dep.
- Coder must **not** run baseline axe per action — that's the existing delta path. Baseline runs **once per pageRoute**.
- Coder must **not** flag SEO heading-hierarchy skipping in v0.6.
- Coder must **not** emit `accessibility_critical` from baseline path — that kind is reserved for the per-action delta.

---

## 7. Task breakdown

| # | Task | File(s) | Deps | Owner |
|---|---|---|---|---|
| 1 | Add new BugKinds to `BugKind` union | `types.ts` | none | coder |
| 2 | Add `seoContext` + `a11yContext` to `BugDetection` | `types.ts` | 1 | coder |
| 3 | Implement `classifyA11yBaseline` | `classify/a11y-baseline.ts` (new) | 1, 2 | coder |
| 4 | Implement `PlaywrightKeyboardTrapProbe` | `adapters/keyboard-trap-probe.ts` (new) | 1, 2 | coder |
| 5 | Implement `FocusTracker` | `adapters/focus-tracker.ts` (new) | 1, 2 | coder |
| 6 | Implement `classifySeoCorpus` + `robots.txt` mini-parser | `classify/seo.ts` (new) | 1, 2 | coder |
| 7 | Add cluster signatures for 11 new kinds | `cluster/signature.ts` | 1, 2 | coder |
| 8 | Add `KIND_PRIORITY` slots | `phases/classify.ts` | 1 | coder |
| 9 | Wire per-page hook + per-action focus tracker into execute | `phases/execute.ts` | 3, 4, 5 | coder |
| 10 | Wire SEO corpus pass into post-execute | `phases/execute.ts` (or new `phases/seo.ts`) | 6 | coder |
| 11 | Add `--a11y-strict`, `--seo`, `--keyboard-trap-max` CLI flags | `cli/main.ts`, `config.ts` | 1–10 | coder |
| 12 | Unit tests for `classifyA11yBaseline` (10 cases) | `classify/a11y-baseline.test.ts` (new) | 3 | coder |
| 13 | Unit tests for `classifySeoCorpus` (12 cases) | `classify/seo.test.ts` (new) | 6 | coder |
| 14 | Unit tests for keyboard trap probe (5 cases via mock scope) | `adapters/keyboard-trap-probe.test.ts` (new) | 4 | coder |
| 15 | Unit tests for focus tracker (4 cases) | `adapters/focus-tracker.test.ts` (new) | 5 | coder |
| 16 | Synthetic a11y fixture (`fixtures/a11y-bad/`) — page with each violation | `fixtures/a11y-bad/` (new) | none | coder |
| 17 | Synthetic SEO fixture (`fixtures/seo-bad/`) — multi-page with each violation | `fixtures/seo-bad/` (new) | none | coder |
| 18 | Integration test: smoke against `fixtures/a11y-bad` produces all 5 a11y kinds | `tests/integration/a11y-smoke.test.ts` | 9, 11, 16 | coder |
| 19 | Integration test: smoke against `fixtures/seo-bad` produces all 6 SEO kinds | `tests/integration/seo-smoke.test.ts` | 10, 11, 17 | coder |
| 20 | TraiderJo killer-demo runbook update — `--a11y-strict --seo` produces ≥3 kinds with ≥1 finding | `SPEC_V06_A11Y_SEO.md` §9 | 18, 19 | architect |

---

## 8. Acceptance + done-when matrix

| BugKind | Synthetic fixture proof | TraiderJo killer-demo target |
|---|---|---|
| `axe_color_contrast_strong` | `fixtures/a11y-bad/contrast` → ≥1 cluster | ≥1 finding on stat-card |
| `keyboard_trap` | `fixtures/a11y-bad/trap` → ≥1 cluster | best-effort (TraiderJo may not have a real trap) |
| `focus_lost_after_action` | `fixtures/a11y-bad/focus-lost` → ≥1 cluster | best-effort |
| `image_missing_alt` | `fixtures/a11y-bad/no-alt` → ≥1 cluster | best-effort |
| `form_input_unlabeled` | `fixtures/a11y-bad/no-label` → ≥1 cluster | likely on TraiderJo's filter inputs |
| `seo_title_missing` | `fixtures/seo-bad/no-title` → ≥1 cluster | unlikely on TraiderJo |
| `seo_title_duplicate_across_routes` | `fixtures/seo-bad/duplicate-titles` → ≥1 cluster | likely on TraiderJo (SPA tabs share document title) |
| `seo_meta_description_missing` | `fixtures/seo-bad/no-meta-description` → ≥1 cluster | likely on TraiderJo |
| `seo_canonical_missing` | `fixtures/seo-bad/no-canonical` → ≥1 cluster | likely on TraiderJo |
| `seo_h1_missing_or_multiple` | `fixtures/seo-bad/h1-issues` → ≥1 cluster per page | best-effort |
| `seo_robots_blocking_crawl` | `fixtures/seo-bad/robots-block` → ≥1 cluster | unlikely on TraiderJo |

**Phase passes when:**
- All 11 BugKinds emit at least one detection on synthetic fixtures.
- `--a11y-strict --seo` on TraiderJo produces ≥3 distinct BugKinds across both clusters.
- Total perf overhead (`--a11y-strict --seo`) on TraiderJo run < 90s additional walltime vs. v0.5 baseline.
- Zero new infra failures introduced.
- Zero global mutable state added (re-entrancy gate).

---

## 9. Killer-demo runbook (TraiderJo)

```bash
cd /tmp/TraiderJo
# crawl is config-only (config.crawl.enabled); vision is config-only
# (vision.enabled in .bughunter/config.json); --since-static was never landed.
bughunt run --a11y-strict --seo
```

Expected output (lower bound):
- 1× `seo_title_duplicate_across_routes` (TraiderJo SPA shares title across tabs)
- 1× `seo_meta_description_missing` (Vite default templates ship without meta description)
- 1× `seo_canonical_missing` if any peer route has canonical (likely none — suppressed correctly)
- 1× `form_input_unlabeled` on dashboard filter input
- 1× `axe_color_contrast_strong` on the muted-secondary-text panels

Document the actual outputs and add to the v0.6 release notes section of the README.

---

## 10. Risk + escape hatches

- **Risk: keyboard-trap probe induces side effects.** Pressing Tab 20× could trigger blur/focus listeners with side effects. Mitigation: run before any action, only if `--a11y-strict`. Document in BugDetection that probe ran.
- **Risk: SEO duplicate-title flags every SPA falsely.** SPAs commonly share title across tabs. Mitigation: this is a real bug for SPA SEO — flag it. Users can suppress via `--no-seo-duplicate-titles` (cli flag added in same PR).
- **Risk: per-page baseline doubles axe runtime.** Mitigation: per-page (not per-action) means O(P), not O(P×A). For ~10 pages, ≤2s overhead.
- **Risk: `<meta name="description">` is rendered late by client-side JS in SPAs.** Mitigation: read DOM after first action settles (parallel with vision baseline), not at initial navigation. Same scope as v0.5 vision-state-reopen captured.
- **Escape hatch:** `--no-a11y-baseline` and `--no-seo-corpus` flags — disable the corresponding pass without disabling the cluster's per-action probes.
