# SPEC — v0.52 "Classic visual regression (per-route pixel-diff vs. baseline)"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-05-02 · **Roadmap slot:** complements `SPEC_PATH_TO_EXHAUSTIVE.md` §3 (detection-coverage gaps); the roadmap doesn't list classic visual-regression because the existing vision pass (`phases/discover.ts:screenshotPhase` + `discover-vision-baseline.test.ts`) was assumed to cover it. It doesn't — vision-LLM anomaly detection emits `visual_anomaly` clusters from semantic prompts, not pixel diffs against a captured baseline. v0.52 fills that gap. · **Depends on:** v0.17 multi-viewport (`browser.setViewport`, the `viewports` config + `screenshotPhase` per-viewport loop), v0.32 deterministic-mode (frozen-clock browser polyfill — the pixel-diff is unstable without it), v0.36 browser-platform probe (pattern reference for "passive observation per pageRoute"), v0.29 export/SARIF (severity wiring for the new BugKinds) · **Sibling specs (do NOT overlap):** v0.41 mobile/responsive (handles `viewport_100vh_break` / `touch_target_too_small` — those are structural mobile-mode kinds, not pixel-diff kinds), v0.47 web UI viewer (renders bugs.jsonl — does not perform diffs), v0.51 cross-browser visual diff (separate spec, NOT this one — v0.52 is single-engine same-camofox-version-vs-prior-run) · **Out of scope (firm):** perceptual diff (SSIM, LPIPS, neural perceptual metrics), video-frame diff, animation-frame-by-frame diff, accessibility color-contrast regression (v0.41 owns it), design-system compliance, cross-browser visual diff (v0.51), SaaS upload (Percy / Chromatic / Applitools — vibe coders won't set them up, and BugHunter is local-first by construction).

This spec adds **classic** visual regression: per-(route, viewport) screenshots are compared, pixel-by-pixel, against a committed baseline image; significant differences are emitted as `visual_diff_*` BugKinds. The whole product question is **the baseline-update workflow** (§7) — without a frictionless way to say "this is the new baseline," every CSS commit fails the build and the feature is worse than nothing. The flow is `bughunter accept-baselines [--run <runId>] [--route <pattern>] [--viewport <px>]` which copies `actual.png` over `baseline.png` for the matched scope. The user's iteration loop becomes: edit CSS, run BugHunter, look at the diff PNGs, accept-baselines if intentional, commit baselines + code. Determinism (§8) is the make-or-break — frozen clock + animation suppression + dynamic-region masking — without all three, the diff is noise. Phasing (§10) ships capture+diff first, masking second, accept-baselines UX third.

---

## 1. Problem statement

Vibe-coded SPAs ship UI breakage that no structural detector catches. Three concrete examples we've watched happen:

1. **Footer pushed off-screen by a new banner.** The dev added a notification banner above the header (40 px tall). The footer, anchored with `bottom: 0` and `padding-bottom: 64px`, now overlaps the last row of content because `100vh` doesn't subtract the banner. axe doesn't flag it; console is clean; network is fine; vision-LLM scoring emits a non-actionable "looks fine to me" because the vision pass evaluates each screenshot in isolation, not against a prior baseline.

2. **Modal breaks when a translation string runs longer in DE.** The English label "Cancel" fits on one line; the German label "Abbrechen" is one character longer and triggers a `flex-wrap` break that pushes the primary button below the secondary button. The locale-stress pass (v0.37) reports text-overflow only when the bbox actually clips; here the text fits the box, the *layout* breaks. v0.52 catches it because the pixel diff at the modal's bbox is significant.

3. **Chart legend overlaps a tooltip.** A library upgrade (Chart.js 4.4 → 4.5) changed the tooltip's default offset by 8 px. Visually the chart still renders; nothing throws; vision-LLM scoring gives "looks like a chart"; but every tooltip now sits under the legend on hover. The diff captures the entire tooltip-vs-legend region as changed pixels in the hover-state route.

None of these are catchable by structural detectors. None are catchable by vision-LLM anomaly detection (which evaluates a single screenshot's plausibility, not against a prior anchor). Pixel-diff vs. baseline is the right tool. v0.52 wires it.

---

## 2. Scope

### 2.1 In scope

- Per-(route, viewport) screenshot capture into a stable, committed baseline directory.
- Pixel-diff (pixelmatch) of the current run's screenshots vs. the committed baselines.
- Threshold-tuned diff classification → four new BugKinds (§3.4).
- A "new baseline" reviewer-loop — when a route has no committed baseline, the run records the screenshot as the **proposed** baseline and emits a non-fatal `visual_baseline_missing` cluster.
- A **`bughunter accept-baselines`** CLI subcommand that promotes proposed baselines to committed baselines, scoped by run / route / viewport.
- Determinism scaffolding: animation/transition suppression CSS injection, dynamic-region masking via selector blackout, settle-after-load timing.
- SARIF export wiring for the new BugKinds at `info` severity by default (§9).
- Per-viewport baselines — same route at 375 / 768 / 1280 produces three independent baselines.
- New `visualRegression` config block + `--visual-regression` / `--no-visual-regression` flag.
- Telemetry rollup on `summary.json.visualRegression`.
- Synthetic fixture `fixtures/v52-visual-regression/` with two routes (one stable, one CSS-mutated) used in CI.

### 2.2 Out of scope (firm)

- **Perceptual diff (SSIM / LPIPS / DSSIM).** Too expensive (DSSIM ~ 200ms / 1MP image; LPIPS requires a Torch model in-process), too noisy (perceptual scoring catches anti-aliasing changes that aren't bugs). Stick with pixelmatch.
- **Video / animation-frame diff.** Out forever; we capture stills with animations suppressed.
- **Accessibility color-contrast regression.** Owned by v0.41 (`axe_color_contrast_strong` + the mobile-mode contrast pass). v0.52 detects pixel changes; semantic contrast belongs to axe.
- **Cross-browser visual diff.** v0.51 (separate spec). v0.52 compares same-engine to same-engine baseline.
- **SaaS upload (Percy, Chromatic, Applitools, Loki).** Vibe coders won't set them up; BugHunter is local-first.
- **Full-page screenshots.** Default is fold (above-the-fold, viewport-height-aligned). Full-page is opt-in via `visualRegression.fullPage = true` because below-the-fold content often includes lazy-loaded images / dynamically-rendered analytics widgets that destabilize the diff. See §6.
- **Design-system compliance.** "Does this match Figma" is a different problem.
- **Hover / focus / active state diffs.** Every screenshot in v0.52 is the page-loaded resting state. Interactive-state diffs are deferred.
- **Auto-fix.** v0.52 is detection-only. Vibe coders look at the diff PNG and decide.

### 2.3 Acceptance target on the v52 fixture

`bughunter run --visual-regression --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z fixtures/v52-visual-regression/test-project` produces:

- First run: zero baselines → 2 `visual_baseline_missing` clusters (one per fixture route × default viewport 1280); `proposed-baselines/` contains 2 PNGs; exit 0 (baseline-missing is non-fatal info).
- After `bughunter accept-baselines --run <runId>`: `baselines/` contains 2 PNGs; `proposed-baselines/` is empty.
- Second run against unchanged fixture: zero `visual_diff_*` clusters; `summary.json.visualRegression.matched === 2`, `…changed === 0`.
- Third run after intentional CSS edit (footer color change): ≥ 1 `visual_diff_above_threshold` cluster, diff PNG saved to `<runDir>/visual-diffs/<routeSlug>-<vp>.diff.png`, exit 0 (default severity is `info`; severity controls fail-on, not detection).

---

## 3. Existing code map

### 3.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `/root/BugHunter/SPEC_PATH_TO_EXHAUSTIVE.md` §3, §6.1, §9 Phase E | Roadmap context. v0.52 is detection-coverage expansion (Phase E). |
| `/root/BugHunter/SPEC_V32_DETERMINISTIC_MODE.md` §3.2, §EC-7 | Frozen-clock browser polyfill (`installFrozenClock`) is a hard prereq for pixel determinism. v0.52 reuses it; do NOT reimplement. EC-7 (compositor jitter) is the canonical statement of why we coarsen to thresholds. |
| `/root/BugHunter/SPEC_V36_BROWSER_PLATFORM.md` §2.2, §3.1 | Pattern reference: "passive probe runs once per unique pageRoute, after axe baseline, before SEO." v0.52 slots in **after** the browser-platform probe and before the vision-LLM baseline (which still runs for `visual_anomaly` semantic detection — they coexist). |
| `/root/BugHunter/SPEC_V41_MOBILE_RESPONSIVE.md` §2.1, §3.1 | Pattern reference for adding a config block + CLI flag + telemetry rollup. v0.52 mirrors the `mobile` config shape exactly. |
| `/root/BugHunter/SPEC_V29_EXPORT_CI.md` §3.1, §3.2 | Severity registry. v0.52 adds four kinds; all four default to `info` severity — `visual_diff_above_threshold` is the most user-actionable but visual diffs are noisy by nature; `info` is the right default. Users can `--fail-on info` if they want a hard gate. |
| `/root/BugHunter/SPEC_V47_WEB_UI_VIEWER.md` §1 | Distinguishes "viewer" from "diff engine." v0.52 produces the diff PNGs; v0.47 viewer renders them. Do NOT bundle a viewer in v0.52. |
| `packages/cli/src/types.ts` line 29-148 (BugKind), line 241 (Severity) | Add 4 new BugKinds. Add `VisualDiffContext` shape. Do NOT fork. |
| `packages/cli/src/config.ts` | Add `visualRegression` block alongside `vision` (line 106 area) and `mobile` (v0.41 area). Mirror v0.41 shape exactly. |
| `packages/cli/src/cli/main.ts` | Subcommand dispatch + USAGE string. Add `accept-baselines` case + `--visual-regression` flag mention. |
| `packages/cli/src/cli/run.ts` | Run-pipeline entry point. v0.52 hooks into the existing screenshotPhase output (re-uses the captured PNGs); does NOT add a new phase loop. |
| `packages/cli/src/phases/discover.ts` line 313-444 (`screenshotPhase`) | The existing per-(route, viewport) capture loop. v0.52 reuses these screenshots; do NOT capture independently. The `ScreenshotEntry` shape (`{ page, screenshotPath, viewportPx }`) is what v0.52 consumes. |
| `packages/cli/src/phases/discover.ts` line 446-500 (`classifyPhase`) | Where vision-LLM scoring runs. v0.52's pixel-diff phase runs **alongside** this — both consume the same `ScreenshotEntry[]`. They produce different `BugKind`s and don't duplicate findings. |
| `packages/cli/src/adapters/browser-mcp.ts` line 89, 125, 610, 1187 (`screenshot`) | Existing screenshot primitive. v0.52 uses it via `screenshotPhase`; do NOT call it directly. |
| `packages/cli/src/adapters/browser-mcp.ts` line 161 (`setViewport`), §V41 docs | Per-viewport capture is already wired. |
| `packages/cli/src/store/filesystem.ts` line 6-38 (`runPaths`) | Add `visualDiffsDir` (`<runDir>/visual-diffs/`) and `proposedBaselinesDir` (`<projectRoot>/.bughunter/baselines/.proposed/`). Committed baselines live at `.bughunter/baselines/` (project-relative). |
| `packages/cli/src/phases/cluster.ts` line 64-140 | Where `BugDetection` rolls up to `BugCluster`. v0.52 emits one `BugDetection` per (route, viewport) with a diff > threshold; clusters group by `(kind, route)` — viewport is in the cluster's `pageContext` for drill-down. |
| `packages/cli/src/cluster/signature.ts` | Add 4 new `case` arms. Signatures: `visual_diff_above_threshold|<route>|<viewport>`, `visual_baseline_missing|<route>|<viewport>`, `visual_layout_shift|<route>|<viewport>|<bboxSig>`, `visual_text_overflow|<route>|<viewport>|<bboxSig>`. |
| `packages/cli/src/phases/classify.ts` `KIND_PRIORITY` | Insert 4 new kinds AFTER `visual_anomaly` and BEFORE the SEO kinds. Rationale: visual-diff is a render-tier concern; same neighborhood as vision-LLM anomaly. |
| `packages/cli/src/detectors/registry.ts` | Add 4 new `DetectorMetadata` entries. All 4 at severity `info`. |
| `packages/cli/src/cli/inspect.ts` | Pattern for "open an existing run, read bugs.jsonl." Mirror for the new `accept-baselines` subcommand. |
| `packages/cli/src/store/run-state.ts` | The on-disk `run-state.json` shape. v0.52 adds `visualRegression: { proposedBaselines: Array<{ route, viewport, proposedPath }> }` to the per-run state — the accept-baselines subcommand reads this to know what to promote. |
| `packages/cli/src/phases/emit.ts` lines 36-130 | Where `summary.json` is written. Add `summary.visualRegression` rollup block. |

### 3.2 Patterns to follow

- **Discriminated `VisualDiffContext`.** One field `kind: 'above_threshold' | 'baseline_missing' | 'layout_shift' | 'text_overflow'` plus per-kind payload. Mirrors `RaceContext` / `HeaderContext` / `BrowserPlatformContext` shape.
- **One detection per (route, viewport, kind).** Same diff at the same route at three viewports → three detections, one cluster (cluster signature is per-(kind, route); viewport diversity within a cluster is normal).
- **Pixel-diff is a phase that consumes `ScreenshotEntry[]`.** New module `packages/cli/src/phases/visual-regression.ts` (~280 LoC). Pure function — no browser, no I/O beyond reading baseline PNGs and writing diff PNGs. Returns `BugDetection[]` and a telemetry payload.
- **Baseline path layout is canonical.** `<projectRoot>/.bughunter/baselines/<routeSlug>--<viewportPx>.png` (committed). `<projectRoot>/.bughunter/baselines/.proposed/<routeSlug>--<viewportPx>.png` (proposed; `.gitignored` by template). The `routeSlug` matches the existing `screenshotPhase` slug logic verbatim (line 397-398 of `discover.ts`) — do NOT redefine.
- **Discriminated returns from the diff function.** `diffPair(baseline, actual, opts): { kind: 'identical' } | { kind: 'changed'; diff: Buffer; pctChanged: number } | { kind: 'baseline_missing' } | { kind: 'baseline_unreadable'; reason: string }`. Caller maps each to detections or telemetry.
- **Determinism gate is a precondition.** When `visualRegression.enabled === true` AND `clock.kind !== 'frozen'`, log a one-line warning: "visual-regression: --frozen-clock not set; expect noise in pixel diffs." Do NOT auto-skip; the user opted in.
- **Single static dependency.** `pixelmatch@5.x` + `pngjs@7.x`. Both are MIT, ~10 KB gzipped each, zero transitive deps beyond Node built-ins. Do NOT add ImageMagick, Sharp, OpenCV, or any native binding. No alternatives evaluated; this choice is made.

### 3.3 DO NOT

- Do **not** create a new `phases/visual-screenshot-phase.ts` that duplicates the v0.13/v0.17 screenshot loop. Reuse the existing `ScreenshotEntry[]` from `screenshotPhase`.
- Do **not** evaluate **multiple** diff libraries. pixelmatch is the one path. (`looks-same`, `image-ssim`, `resemblejs`, `Sharp`-based custom — all rejected. pixelmatch is established, dep-light, and matches our threshold model.)
- Do **not** add a SaaS-upload path (Percy / Chromatic / Applitools). Out of scope per §2.2.
- Do **not** use `puppeteer` or `playwright` directly. The screenshot primitive is `browser.screenshot()` from the existing camofox MCP adapter. Importing `playwright-core` directly violates v0.13's adapter discipline.
- Do **not** auto-promote proposed baselines on the next run. Promotion is **always** user-initiated via `bughunter accept-baselines`. Silent promotion turns visual-regression into a feedback loop ("the baseline is whatever last ran") that catches nothing.
- Do **not** commit `.proposed/` to git. The repo template adds `.bughunter/baselines/.proposed/` to `.gitignore`. Committed `baselines/` are the source of truth.
- Do **not** make `visual_diff_above_threshold` severity higher than `info` by default. Visual diffs are noisy. `info` is the right default; `--fail-on info` is the user's opt-in.
- Do **not** mask dynamic regions by AI inference / heuristics. Masking is **selector-driven**, declared in `visualRegression.maskSelectors`. No magic.
- Do **not** retry a failed diff. If pixelmatch throws (bad PNG, dimension mismatch), emit a single `visual_diff_unreadable` telemetry entry (not a BugDetection — telemetry only) and move on.
- Do **not** introduce a new id format for routeSlug. Reuse `discover.ts` line 397-398 verbatim. Diverging routeSlug logic produces ghost baselines (path mismatch on subsequent runs).
- Do **not** make baseline-acceptance a destructive operation without confirmation when scope is unscoped. `bughunter accept-baselines` (no flags) prints what it would copy and requires `--yes` to actually copy.
- Do **not** fall back to the live network during accept-baselines. Accept-baselines is filesystem-only; no browser, no network, no MCP.

---

## 4. Architecture decision: where do baselines live? (the §2.3 brief calls this §7 — addressed first because it constrains everything else)

Three candidates:

| Option | Pros | Cons |
|---|---|---|
| **(a) Committed in the project repo at `.bughunter/baselines/<routeSlug>--<vp>.png`** | Zero setup. Git-tracked (audit, blame, revert). Works offline. Diff against `git diff` shows when baselines changed. PR review surface for free. | Repo size grows. Binary diffs are noisy in PR view (mitigated by the diff PNG being a separate artifact, not a baseline overwrite). |
| **(b) S3 / object-store keyed by run** | Repo stays small. Baselines per-environment (CI vs. local). | Vibe coders won't configure S3. Requires creds in CI. Drives no value over (a) for the target cohort. |
| **(c) Hash-only stored in repo; image fetched on diff** | Tiny repo footprint. Audit trail of hashes. | Requires a baseline-host (S3 or HTTP server). Same setup tax as (b). On-demand fetch breaks offline + CI cache. |

**Decision: (a) — committed in the project repo at `.bughunter/baselines/<routeSlug>--<vp>.png`.**

Rationale:
1. **Vibe coders won't set up S3 or a hash-host.** The premise of BugHunter is local-first. A feature that requires cloud infra for the baseline-of-record is a feature half the cohort won't enable.
2. **Git already does the audit job for free.** `git log -- .bughunter/baselines/` shows when each baseline changed and (with `git blame`) who promoted it. PR review naturally surfaces baseline changes.
3. **PR diff noise is the most-cited objection.** Mitigation: the diff PNG (not the baseline) is the visual review surface; PR reviewers look at `<runDir>/visual-diffs/*.diff.png`, not raw baselines. Baselines change as binary blobs in `git diff`, which is fine — reviewers see "footer.png changed" and approve based on the diff PNG.
4. **Repo growth is bounded.** Typical app: 10–50 routes × 3 viewports × ~50 KB / PNG = 1.5–7.5 MB total. Sub-1% of a typical SPA repo.
5. **Offline + CI parity is free.** Same baseline file works in CI as in local. No environment drift.

**Path layout (canonical, do not deviate):**

```
<projectRoot>/.bughunter/
  baselines/
    <routeSlug>--<viewportPx>.png            # committed, source of truth
    .proposed/
      <routeSlug>--<viewportPx>.png          # accept-baselines candidates; .gitignored
  runs/<runId>/
    visual-diffs/
      <routeSlug>--<viewportPx>.actual.png   # this run's screenshot
      <routeSlug>--<viewportPx>.diff.png     # pixelmatch output
      <routeSlug>--<viewportPx>.diff.json    # { pctChanged, pixelsChanged, threshold }
    bugs.jsonl                               # cluster lines as usual
    summary.json                             # has summary.visualRegression
    run-state.json                           # has visualRegression.proposedBaselines
```

`routeSlug` is computed by the existing logic at `discover.ts:397-398`:
```ts
const routeSlugRaw = page.route.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '');
const routeSlug = routeSlugRaw !== '' ? routeSlugRaw : 'root';
```

Do **not** redefine. v0.52 imports a helper `routeSlugFor(route)` extracted into `packages/cli/src/store/route-slug.ts` (new, ~10 LoC) that v0.52 and `discover.ts` both call. Refactoring `discover.ts` to use the helper is task #2.

**Filename separator is `--` (double-dash).** `<routeSlug>--<viewportPx>.png`. Single-dash (`<slug>-<vp>`) collides with route slugs that already contain dashes (e.g. `account-settings-1280` is ambiguous). Double-dash makes the viewport boundary unambiguous and matches no character in the slug regex.

---

## 5. BugKinds proposed (4 new)

Added to `BugKind` union in `types.ts` after `'streaming_response_truncated'` (the v0.43 agentic block end), in this order:

```ts
  // v0.52 visual regression kinds
  | 'visual_diff_above_threshold'
  | 'visual_baseline_missing'
  | 'visual_layout_shift'
  | 'visual_text_overflow'
```

| Kind | Detection signal | Notes |
|---|---|---|
| `visual_diff_above_threshold` | `pctChanged > visualRegression.diffThresholdPct` (default 0.5%, see §6) AND no more-specific kind matches | The catch-all. The other three are higher-confidence subsets that, when matched, **replace** this one for the same (route, viewport). |
| `visual_baseline_missing` | The expected `<projectRoot>/.bughunter/baselines/<routeSlug>--<vp>.png` does not exist | Non-fatal info. Records the actual screenshot to `proposedBaselines` and to `<runDir>/visual-diffs/<slug>--<vp>.actual.png`. The accept-baselines subcommand promotes it. First run on a new project produces this for every (route, viewport). |
| `visual_layout_shift` | Diff pixels are concentrated along **straight horizontal edges** spanning > 30% of the page width AND the rectangular hull of changed pixels has aspect ratio > 4:1 | High-confidence subset. Footer-pushed-down case (§1 example 1) hits this. The detector is `cluster/visual-shape.ts:isLayoutShift(diffPixels, width, height)` — pure function, ~40 LoC. |
| `visual_text_overflow` | Diff pixels are **fully contained** within the bounding box of a known text element (collected during the same `walkDom` pass that v0.36 uses) AND the bbox's `overflow` computed style is `visible` AND `pctChanged > 0` within the bbox | High-confidence subset. The DE translation case (§1 example 2) hits this. Requires the DOM walker to emit text-element bboxes — v0.52 extends `dom-walker.ts:COLLECT_ELEMENTS_SCRIPT` to also collect `getBoundingClientRect()` for text-bearing elements (only when `visualRegression.enabled === true`, gated to avoid bloat for runs that don't need it). |

**Cluster signatures (in `cluster/signature.ts`):**

```ts
case 'visual_diff_above_threshold':
  return `visual_diff_above_threshold|${ctx.route}|${ctx.viewport}`;
case 'visual_baseline_missing':
  return `visual_baseline_missing|${ctx.route}|${ctx.viewport}`;
case 'visual_layout_shift':
  return `visual_layout_shift|${ctx.route}|${ctx.viewport}|${ctx.bboxSignature}`;
case 'visual_text_overflow':
  return `visual_text_overflow|${ctx.route}|${ctx.viewport}|${ctx.bboxSignature}`;
```

`bboxSignature` is `${Math.round(x/8)*8}x${Math.round(y/8)*8}+${Math.round(w/8)*8}x${Math.round(h/8)*8}` — coarsened to 8 px to absorb sub-pixel jitter and survive minor reflows of identical content.

**KIND_PRIORITY insertion:** insert all 4 directly after `'visual_anomaly'` (the existing vision-LLM kind) and before the SEO kinds. Order within the v0.52 block: `visual_baseline_missing` (lowest — info-only), `visual_diff_above_threshold` (catch-all), `visual_layout_shift`, `visual_text_overflow` (highest of the four — most specific). Cluster-collision tiebreak: when the same (route, viewport) hits two of the v0.52 kinds, the most specific wins via `KIND_PRIORITY`, so a layout-shift takes precedence over the catch-all.

---

## 6. Diff algorithm

**Library: `pixelmatch@5.x`** (with `pngjs@7.x` for PNG I/O). Add as exact-pinned deps in `packages/cli/package.json`. Bundle impact: ~25 KB gzipped combined; both pure JS; both MIT; both > 5 years stable.

**Parameters (canonical, in `packages/cli/src/phases/visual-regression.ts`):**

```ts
const PIXELMATCH_OPTS = {
  threshold: 0.1,        // per-pixel YIQ difference threshold; pixelmatch's "how different is THIS pixel"
  includeAA: false,      // ignore anti-aliasing differences (sub-pixel font rendering jitter)
  alpha: 0.5,            // diff overlay opacity for diff PNG output
  aaColor: [255, 255, 0],// anti-aliasing pixels marked yellow (debug only)
  diffColor: [255, 0, 0],// changed pixels marked red
};
```

**"Significant" definition:**

```ts
const pctChanged = (pixelsChanged / (width * height)) * 100;
const significant = pctChanged > visualRegression.diffThresholdPct;  // default 0.5%
```

Default `diffThresholdPct = 0.5` (half a percent of pixels). Rationale: at 1280×800 = 1,024,000 pixels, 0.5% = 5,120 changed pixels — a 70×70 region. Smaller than a button. Bigger than per-frame compositor noise. Tune via config.

**Tunable per-(route, viewport) via** `visualRegression.routeOverrides[<routePattern>] = { diffThresholdPct, fullPage, mask }`. Pattern is `micromatch` (already a dep). Useful for charts that flicker — set route `/dashboard` to a higher threshold without affecting `/login`.

**Dimension-mismatch handling:** if baseline and actual have different dimensions (viewport changed in config; CSS shifted page height for full-page mode), emit `visual_diff_above_threshold` with `pctChanged = 100` and a payload field `dimensionsChanged: true`. The diff PNG is the actual image (no overlay); reviewers see the new size and decide.

**No upscale / downscale.** We never resize either image. Dimensions match or the diff is rejected.

---

## 7. Capture mechanism (and the fold-vs-full-page trade-off)

**Capture is reused from `phases/discover.ts:screenshotPhase`.** v0.52 does NOT call `browser.screenshot()` itself. The pixel-diff phase consumes the existing `ScreenshotEntry[]` (line 313 of discover.ts) and reads each entry's `screenshotPath`.

**Fold (default) vs. full-page (opt-in):**

The existing `screenshotPhase` calls `browser.screenshot(outputPath)` which under-the-hood passes `{ fullPage: false }` to camofox (verified at `browser-mcp.ts:613, 898, 1189, 1416`). This captures the **above-the-fold** view at the configured viewport — `1280×800` for desktop, `375×667` for iPhone-class, etc.

**Why fold by default:**
- Diff stability — below-the-fold content frequently includes lazy-loaded images, analytics widgets, intercom chat bubbles, footer ads. Each of these is a noise source the user can't easily mask.
- Page-height non-determinism — `document.body.scrollHeight` varies with content reflow; full-page captures change height across runs even when the visible page doesn't, making pixelmatch's dimension-mismatch path fire for cosmetic reasons.
- User-perceptible-bug coverage — users see above-the-fold first; a layout break the user doesn't see (4500 px down) is lower-priority than one they see immediately.

**Opt-in full-page:** `visualRegression.fullPage = true` (or per-route via `routeOverrides`). The `browser.screenshot()` adapter does not currently expose `{ fullPage: true }` — v0.52 task #3 extends `BrowserMcpAdapter.screenshot` to take an options arg `{ fullPage?: boolean }` (default `false`, current behavior preserved). Camofox's MCP `screenshot` tool already accepts `fullPage`; the change is plumbing.

**Settle delay:** `screenshotPhase` already settles `settleMs` after viewport resize (default 250 ms). v0.52 adds an additional `visualRegression.preCaptureDelayMs` (default 500 ms) **after** the existing settle but **before** the capture, applied only when visual-regression is enabled. Rationale: animation suppression CSS injection (§8) needs a tick to apply; lazy-load IntersectionObservers fire synchronously but layout reflow needs a paint cycle. 500 ms is empirically the floor where a frozen-clock + animation-suppressed page is fully settled.

---

## 8. Determinism (the make-or-break of the feature)

Pixel-diff is fragile. Without these mitigations, every run produces noise and the user disables visual-regression within a week. All four mitigations are MANDATORY when `visualRegression.enabled === true`.

### 8.1 Frozen clock (depends on v0.32 / V23)

**Required.** When `visualRegression.enabled === true` AND `clock.kind !== 'frozen'`, log a warning: `visual-regression: --frozen-clock not set; expect noise in pixel diffs.` Continue running — partial determinism is the user's choice. CI templates set `--frozen-clock` by default.

`installFrozenClock` (V23 / v0.32 §3.2) is already installed via `evaluate` after every `navigate` when frozen-clock is set. v0.52 does NOT install it — it relies on v0.32's installation.

### 8.2 Animation / transition suppression

CSS injection at navigation time (after `installFrozenClock`, before `screenshotPhase` capture). New helper `injectAnimationSuppression(scope)`:

```css
*, *::before, *::after {
  animation-delay: -1ms !important;
  animation-duration: 1ms !important;
  animation-iteration-count: 1 !important;
  background-attachment: initial !important;
  scroll-behavior: auto !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
}
```

Injected as a `<style>` tag with attribute `data-bughunter-suppression="visual-regression"` so subsequent runs can detect re-injection (idempotent). Injected via `browser.evaluate(INJECT_STYLE_SCRIPT)` — same primitive used by v0.36's bootstrap.

This pattern is canonical in visual-regression tooling (Storybook's `disableAnimations`, Percy's `freezePage`, Chromatic's `pauseAnimationAtEnd`). Cite no external library; the snippet is 8 lines.

### 8.3 Dynamic-region masking via selector-based blackout

Some content is unavoidably dynamic — user avatars, last-updated timestamps, intercom widgets, ad slots. Suppress via `visualRegression.maskSelectors: string[]`:

```jsonc
{
  "visualRegression": {
    "enabled": true,
    "maskSelectors": [
      "[data-testid='last-updated']",
      ".intercom-launcher",
      "[aria-label='Live notification feed']"
    ]
  }
}
```

Implementation: before screenshot capture, inject a stylesheet that blackouts each matched element:

```ts
const BLACKOUT_CSS = maskSelectors.map(s =>
  `${s} { background: black !important; color: black !important; visibility: visible !important; }`
).join('\n');
```

Use `background: black; color: black` (not `display: none`) so the page layout is preserved — masking should only blank the content, not change the layout (which would invalidate the baseline at every other location too).

Per-route masks via `routeOverrides[route].maskSelectors` override the global list (NOT merge — explicit override is less surprising).

### 8.4 Settle delay (covered in §7)

500 ms after viewport resize + animation-suppression injection. Captured before `browser.screenshot()`.

### 8.5 What we explicitly do NOT pin

- **GPU compositor jitter.** Even with frozen clock + suppressed animations, sub-pixel rendering can vary by < 1 unit. `pixelmatch.threshold = 0.1 + includeAA: false` absorbs this.
- **Font rendering.** Operating systems render fonts with subtly different hinting. The same Chromium build on macOS vs. Linux produces different sub-pixel glyph anti-aliasing. **v0.52 does NOT solve this** — visual-regression baselines are platform-specific. CI templates document this: "run baselines on the same OS as your CI host."
- **Real third-party iframes.** YouTube embeds, Stripe Elements, Google Maps — these contain non-deterministic content. Mask them via `maskSelectors` or accept the noise.
- **Localized content beyond locale-stress mode.** When `--locale-stress` is enabled (v0.37), each locale produces different baselines. v0.52's baseline path is `<routeSlug>--<vp>--<locale>.png` when locale-stress is active, falling back to the unsuffixed name otherwise. Locale is the existing `i18nStress.locales` value; baseline-acceptance is per-locale.

---

## 9. CI integration (SARIF + severity)

**Default severity = `info`** for all four kinds. Rationale: visual-diff is high-noise; defaulting to `major` would block PRs on aesthetic changes.

`packages/cli/src/detectors/registry.ts` adds:

```ts
visual_diff_above_threshold: {
  kind: 'visual_diff_above_threshold',
  severity: 'info',
  helpUri: 'https://bughunter.dev/docs/v52#diff-above-threshold',
},
visual_baseline_missing: {
  kind: 'visual_baseline_missing',
  severity: 'info',
  helpUri: 'https://bughunter.dev/docs/v52#baseline-missing',
},
visual_layout_shift: {
  kind: 'visual_layout_shift',
  severity: 'minor',  // higher than the catch-all because it's more specific
  helpUri: 'https://bughunter.dev/docs/v52#layout-shift',
},
visual_text_overflow: {
  kind: 'visual_text_overflow',
  severity: 'minor',
  helpUri: 'https://bughunter.dev/docs/v52#text-overflow',
},
```

**SARIF mapping (via v0.29's `severityToSarifLevel`):**
- `info` → `note`
- `minor` → `warning`

**SARIF result shape** (per cluster): `result.locations[].physicalLocation.artifactLocation.uri = "<runDir>/visual-diffs/<slug>--<vp>.diff.png"`. The diff PNG is the artifact attached to the result. GitHub code-scanning renders it inline.

**`bughunter ci --fail-on minor`** opts the user into hard-failing on `visual_layout_shift` / `visual_text_overflow` while still surfacing (but not failing on) the catch-all. `--fail-on info` fails on any visual diff. Default `bughunter ci` (no `--fail-on`) does not fail on visual kinds.

---

## 10. Phasing

### 10.1 v0.52.1 — capture, diff, BugKinds (this spec, primary deliverable)

Tasks 1-15 (§13). Ships:
- 4 new BugKinds in the union, registry, signature, KIND_PRIORITY.
- `visualRegression` config block + `--visual-regression` flag.
- `phases/visual-regression.ts` consuming `ScreenshotEntry[]`, emitting detections.
- Baseline path layout, hash-determinism, dimension-mismatch handling.
- Telemetry on `summary.json.visualRegression`.
- SARIF wiring at `info` / `minor` severity per kind.
- Frozen-clock determinism warning.
- v52 fixture + CI tests for: first-run-no-baseline → baseline-missing; identical re-run → zero diffs; CSS-changed run → ≥ 1 above-threshold cluster.
- The `bughunter accept-baselines` subcommand at minimum-viable scope: `accept-baselines [--run <runId>]` accepts all proposed baselines for one run.

### 10.2 v0.52.2 — masking + animation suppression hardening

Tasks 16-22 (§13). Ships:
- `visualRegression.maskSelectors` (global + per-route).
- `injectAnimationSuppression` CSS pre-capture.
- `routeOverrides` config (per-route `diffThresholdPct`, `fullPage`, `maskSelectors`).
- Documentation + CI template updates.

### 10.3 v0.52.3 — accept-baselines UX

Tasks 23-28 (§13). Ships:
- Granular accept: `accept-baselines --route <pattern> --viewport <px>`.
- Dry-run + confirmation: bare `accept-baselines` prints what it would copy and requires `--yes`.
- Diff PNG opening: `accept-baselines --review` opens each diff PNG via `open` (already a dep) and waits for `[a]ccept / [r]eject / [s]kip` keypress.
- The `visual_layout_shift` and `visual_text_overflow` high-confidence subset detectors (these need bbox extraction from the DOM walker — moved here because they're refinements over the catch-all).

The phasing is intentional: v0.52.1 alone is not a shippable product (every CSS commit fails the build). v0.52.1 + v0.52.2 is shippable for users who tolerate a manual "review the diff PNGs and re-run" loop. v0.52.1 + v0.52.2 + v0.52.3 is the shippable end-state.

---

## 11. Acceptance criteria (concrete, testable)

### 11.1 Determinism gate (the headline acceptance)

Two consecutive runs against an identical fixture, both with `--seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z --visual-regression`, produce **zero** `visual_diff_*` clusters. The CI test:

```bash
SEED=1234 CLOCK="2026-05-01T12:00:00.000Z"
PROJ=fixtures/v52-visual-regression/test-project

# Seed baselines from the first run, accept them
bughunter run --seed $SEED --frozen-clock $CLOCK --visual-regression $PROJ
RUN_INIT=$(ls -t $PROJ/.bughunter/runs/ | head -1)
bughunter accept-baselines --run $RUN_INIT --yes

# First "real" run vs. baselines
bughunter run --seed $SEED --frozen-clock $CLOCK --visual-regression $PROJ
RUN1=$(ls -t $PROJ/.bughunter/runs/ | head -1)
DIFFS_1=$(jq -r '.byKind | to_entries[] | select(.key | startswith("visual_diff")) | .value' $PROJ/.bughunter/runs/$RUN1/summary.json | paste -sd+ | bc)
[ "${DIFFS_1:-0}" = "0" ] || { echo "FAIL: run1 had $DIFFS_1 visual diffs"; exit 1; }

# Second run (no changes) vs. same baselines
bughunter run --seed $SEED --frozen-clock $CLOCK --visual-regression $PROJ
RUN2=$(ls -t $PROJ/.bughunter/runs/ | head -1)
DIFFS_2=$(jq -r '.byKind | to_entries[] | select(.key | startswith("visual_diff")) | .value' $PROJ/.bughunter/runs/$RUN2/summary.json | paste -sd+ | bc)
[ "${DIFFS_2:-0}" = "0" ] || { echo "FAIL: run2 had $DIFFS_2 visual diffs"; exit 1; }

echo "PASS: visual-regression determinism"
```

### 11.2 Sensitivity gate

One run against a CSS-modified fixture (the fixture provides a `mutated/` variant with a footer color change) produces **≥ 1** `visual_diff_above_threshold` cluster:

```bash
bughunter run --seed $SEED --frozen-clock $CLOCK --visual-regression \
  fixtures/v52-visual-regression/test-project-mutated
RUN_M=$(ls -t fixtures/v52-visual-regression/test-project-mutated/.bughunter/runs/ | head -1)
DIFFS_M=$(jq -r '.byKind.visual_diff_above_threshold // 0' \
  fixtures/v52-visual-regression/test-project-mutated/.bughunter/runs/$RUN_M/summary.json)
[ "$DIFFS_M" -ge 1 ] || { echo "FAIL: expected ≥ 1 visual_diff_above_threshold cluster"; exit 1; }

# Diff PNG was written
[ -f fixtures/.../runs/$RUN_M/visual-diffs/index--1280.diff.png ] || { echo "FAIL: diff PNG missing"; exit 1; }

echo "PASS: visual-regression sensitivity"
```

### 11.3 Baseline-missing path

A fresh fixture with no committed baselines produces `visual_baseline_missing` for every (route, viewport) and exit 0:

```bash
rm -rf $PROJ/.bughunter/baselines/
bughunter run --seed $SEED --frozen-clock $CLOCK --visual-regression $PROJ
RUN_FRESH=$(ls -t $PROJ/.bughunter/runs/ | head -1)
MISSING=$(jq -r '.byKind.visual_baseline_missing // 0' $PROJ/.bughunter/runs/$RUN_FRESH/summary.json)
[ "$MISSING" -ge 1 ] || { echo "FAIL: expected ≥ 1 visual_baseline_missing"; exit 1; }
[ -d $PROJ/.bughunter/baselines/.proposed/ ] || { echo "FAIL: proposed dir missing"; exit 1; }
[ "$(ls $PROJ/.bughunter/baselines/.proposed/ | wc -l)" -ge 1 ] || { echo "FAIL: no proposed PNGs"; exit 1; }
```

### 11.4 Accept-baselines round-trip

```bash
# Setup as in 11.3
bughunter accept-baselines --run $RUN_FRESH --yes
[ "$(ls $PROJ/.bughunter/baselines/ | grep -v '.proposed' | wc -l)" -ge 1 ] || { echo "FAIL: baselines not promoted"; exit 1; }
[ "$(ls $PROJ/.bughunter/baselines/.proposed/ 2>/dev/null | wc -l)" = "0" ] || { echo "FAIL: proposed not cleared"; exit 1; }
```

### 11.5 Dimension-mismatch handling

Saved baseline at 1280×800, run captures at 1280×600 (config change) → exactly 1 cluster of `visual_diff_above_threshold` with `pctChanged === 100` and payload `dimensionsChanged: true`.

### 11.6 Mask-selector functionality

Fixture with a `<div data-testid="timestamp">{Date.now()}</div>` + `maskSelectors: ['[data-testid=timestamp]']` produces zero diffs across two runs (the timestamp is masked black on both, identical).

### 11.7 SARIF integration

`bughunter export <runId> --format sarif` emits a SARIF document with `result[].level === 'note'` for `visual_diff_above_threshold` and `'warning'` for `visual_layout_shift`. The diff PNG path appears in `result.locations[].physicalLocation.artifactLocation.uri`.

### 11.8 Help + error messages

- `bughunter run --help` lists `--visual-regression` / `--no-visual-regression`.
- `bughunter accept-baselines --help` documents `--run`, `--route`, `--viewport`, `--yes`, `--review`.
- `bughunter accept-baselines` (no flags, no `--yes`) prints a dry-run summary and exits 0 with code "0 (dry run; pass --yes to apply)".
- `bughunter accept-baselines --run <bogus>` errors: `"Error: --run: run not found: <bogus>"`.

### 11.9 Determinism warning

When `--visual-regression` is set without `--frozen-clock`, stderr contains: `visual-regression: --frozen-clock not set; expect noise in pixel diffs.`

### 11.10 Telemetry block

`summary.json.visualRegression` is present when the flag is set, absent otherwise. Shape:

```ts
type VisualRegressionTelemetry = {
  enabled: true;
  baselineDir: string;            // absolute path
  matched: number;                // (route, vp) pairs that diffed clean
  changed: number;                // (route, vp) pairs above threshold
  baselineMissing: number;        // (route, vp) pairs without a baseline
  layoutShifts: number;
  textOverflows: number;
  unreadable: number;             // PNG decode errors etc.
  dimensionsChanged: number;
  thresholdPct: number;
  proposedBaselines: Array<{ route: string; viewport: number; proposedPath: string }>;
};
```

---

## 12. Non-goals (firm — restated for emphasis)

- **Perceptual quality scoring (SSIM, LPIPS).** Out forever — too expensive, too noisy.
- **Design-system compliance ("matches Figma").** Different problem.
- **Accessibility color-contrast regression.** v0.41 owns it.
- **Cross-browser visual diff.** v0.51 owns it. v0.52 is single-engine.
- **Hover / focus / active state diffs.** Deferred indefinitely; the page-loaded resting state is the v0.52 contract.
- **Auto-fix.** Detection only.
- **SaaS upload (Percy / Chromatic / Applitools / Loki).** Local-first, by construction.
- **Animation-frame-by-frame diff.** Out forever.
- **Mobile-specific layout breaks (`viewport_100vh_break`, `touch_target_too_small`).** v0.41 owns these as structural detections; v0.52 still produces pixel diffs at mobile viewports as a complementary signal, but the structural detectors remain the source-of-truth for those bugs.

---

## 13. Task breakdown (agent-sized; each ≤ 30 min human-equivalent)

| # | Task | Files (modify / create) | Deps | Effort |
|---|---|---|---|---|
| 1 | Add 4 new `BugKind`s + 4 entries in `KIND_PRIORITY` + 4 cluster-signature cases | `types.ts`, `phases/classify.ts`, `cluster/signature.ts` | none | 30 min |
| 2 | Extract `routeSlugFor(route)` helper from `discover.ts:397-398`; update both call sites | `store/route-slug.ts` (new), `phases/discover.ts` | none | 20 min |
| 3 | Extend `BrowserMcpAdapter.screenshot` to accept `{ fullPage?: boolean }` (default false; current behavior preserved) | `adapters/browser-mcp.ts` (4 sites: lines 89, 125, 610, 1187) | none | 30 min |
| 4 | Add pixelmatch + pngjs deps; verify build | `packages/cli/package.json` | none | 10 min |
| 5 | Add `VisualRegressionConfig` Zod schema + defaults | `config.ts` | 1 | 30 min |
| 6 | Wire `--visual-regression` / `--no-visual-regression` flags + USAGE block | `cli/run.ts`, `cli/main.ts` | 5 | 30 min |
| 7 | Add `runPaths.visualDiffsDir` + `baselinesDir(projectRoot)` + `proposedBaselinesDir(projectRoot)` helpers | `store/filesystem.ts` | 2 | 20 min |
| 8 | Implement `diffPair(baseline, actual, opts)` pure-function with discriminated-union return; PNG decode via pngjs; pixelmatch invocation; diff PNG output to buffer | `phases/visual-regression-diff.ts` (new) | 4 | 45 min |
| 9 | Implement `phases/visual-regression.ts:runVisualRegression(entries, projectRoot, runDir, config)` returning `BugDetection[]` + telemetry; calls diffPair per entry; writes diff PNGs and proposed baselines | `phases/visual-regression.ts` (new) | 7, 8 | 1 hour |
| 10 | Wire visualRegression phase into the run pipeline AFTER `screenshotPhase` and BEFORE `classifyPhase` (vision-LLM); both phases read the same `ScreenshotEntry[]` | `phases/discover.ts` (or equivalent orchestrator), `cli/run.ts` | 9 | 45 min |
| 11 | Add 4 `DetectorMetadata` entries with severity + helpUri | `detectors/registry.ts` | 1 | 15 min |
| 12 | Populate `summary.visualRegression` block in emit; add `run-state.visualRegression.proposedBaselines` write at end of phase | `phases/emit.ts`, `store/run-state.ts` | 9, 11 | 30 min |
| 13 | Frozen-clock warning when `--visual-regression` without `--frozen-clock` | `cli/run.ts` | 6 | 10 min |
| 14 | Build the v52 fixture: `test-project/index.html` + `test-project-mutated/index.html` (one-byte CSS color change) | `fixtures/v52-visual-regression/*` | 9 | 1 hour |
| 15 | CI tests: 11.1, 11.2, 11.3, 11.5 (determinism, sensitivity, baseline-missing, dimension-mismatch) | `tests/v52-visual-regression/*.test.ts` | 14 | 2 hours |
| **v0.52.1 milestone** | | | | **~9 hrs** |
| 16 | `injectAnimationSuppression(scope)` helper; install at navigate time when `visualRegression.enabled` | `discovery/animation-suppression.ts` (new), `phases/discover.ts` | 5, 10 | 45 min |
| 17 | `visualRegression.maskSelectors` (global) — apply via blackout CSS injection before capture | `phases/visual-regression.ts`, `discovery/visual-mask.ts` (new) | 16 | 45 min |
| 18 | `visualRegression.routeOverrides[<pattern>]` config — per-route `diffThresholdPct`, `fullPage`, `maskSelectors`; resolution helper | `config.ts`, `phases/visual-regression.ts` | 17 | 45 min |
| 19 | `preCaptureDelayMs` (default 500 ms) honored in screenshotPhase when visual-regression enabled | `phases/discover.ts` | 16 | 15 min |
| 20 | Test 11.6 (mask functionality with synthetic timestamp element) | `tests/v52-visual-regression/mask.test.ts` | 17 | 45 min |
| 21 | Test the animation-suppression idempotency (re-injection on re-navigate is a no-op) | `tests/v52-visual-regression/animation-suppression.test.ts` | 16 | 45 min |
| 22 | Documentation block in run output: `bughunter run --help` mentions visual-regression masking workflow | `cli/main.ts` USAGE | 17, 18 | 15 min |
| **v0.52.2 milestone** | | | | **~5 hrs** |
| 23 | `bughunter accept-baselines` subcommand: `--run <id>` (required), `--yes` (apply), default dry-run | `cli/accept-baselines.ts` (new), `cli/main.ts` | 12 | 45 min |
| 24 | `accept-baselines --route <pattern> --viewport <px>` scoping | `cli/accept-baselines.ts` | 23 | 30 min |
| 25 | `accept-baselines --review` opens each diff PNG via `open` and prompts `[a/r/s]`; uses `ink` for the prompt | `cli/accept-baselines.ts` | 23 | 1 hour |
| 26 | Layout-shift detector: `cluster/visual-shape.ts:isLayoutShift(diffPixels, w, h)` pure function; promote `visual_diff_above_threshold` → `visual_layout_shift` when matched | `cluster/visual-shape.ts` (new), `phases/visual-regression.ts` | 9 | 45 min |
| 27 | Text-overflow detector: extend `dom-walker.ts` to collect text-element bboxes when visual-regression enabled; add `isTextOverflow(diffPixels, bboxes)` | `discovery/dom-walker.ts`, `cluster/visual-shape.ts`, `phases/visual-regression.ts` | 9, 26 | 1.5 hours |
| 28 | Tests for accept-baselines, layout-shift detection, text-overflow detection | `tests/v52-visual-regression/*` | 23-27 | 2 hours |
| 29 | SARIF emitter: visual-diff results carry the diff PNG as `artifactLocation.uri` | `export/sarif.ts` | 11 | 30 min |
| 30 | Test 11.7 (SARIF level mapping for visual kinds) | `tests/v52-visual-regression/sarif.test.ts` | 29 | 30 min |
| **v0.52.3 milestone** | | | | **~7 hrs** |

**Total: ~21 hours of focused agent work across the 3 phases.**

**Critical path (v0.52.1 alone):** 1 → 2 → 3, 4 → 5 → 6 → 7 → 8 → 9 → 10 → 12 → 14 → 15. Tasks 1, 2, 3, 4 are parallelizable across multiple agents. Task 11 + 13 are leaf-level and fit anywhere.

---

## 14. Definition of Done

| Criterion | Verifier |
|---|---|
| All new unit + CI tests pass | `npm test` in `packages/cli` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Determinism gate test passes (§11.1) | `npm test -- v52-visual-regression/determinism` |
| Sensitivity gate test passes (§11.2) | `npm test -- v52-visual-regression/sensitivity` |
| Baseline-missing test passes (§11.3) | `npm test -- v52-visual-regression/baseline-missing` |
| Accept-baselines round-trip test passes (§11.4) | `npm test -- v52-visual-regression/accept-baselines` |
| Dimension-mismatch test passes (§11.5) | `npm test -- v52-visual-regression/dimension-mismatch` |
| Mask-selector test passes (§11.6) | `npm test -- v52-visual-regression/mask` |
| SARIF level mapping test passes (§11.7) | `npm test -- v52-visual-regression/sarif` |
| `bughunter run --help` lists `--visual-regression` | manual |
| `bughunter accept-baselines --help` lists `--run`, `--route`, `--viewport`, `--yes`, `--review` | manual |
| Existing test suite (~ all V05–V47 tests) passes unchanged | `npm test` |
| `summary.json.visualRegression` block present when flag set, absent otherwise | unit + integration test |
| `.gitignore` template includes `.bughunter/baselines/.proposed/` | template inspection |
| Smoke run on Aspectv3 with `--visual-regression --seed 1234 --frozen-clock <iso>` produces 0 diffs across two consecutive runs after baselines are accepted | manual runbook |

---

## 15. Open questions

1. **Is `info` the right default severity for `visual_diff_above_threshold`?** Argues for `minor`: it's a real bug surface, and `info`-by-default means CI never fails on it without a `--fail-on info`. Argues for `info`: visual diffs are intrinsically noisier than (say) `console_error`. Recommendation: ship `info` in v0.52.1; collect data; bump to `minor` in v0.53 if the noise rate proves manageable.

2. **Should baselines be per-OS / per-Camofox-version?** Font hinting differs across OSes. Recommendation: baselines are per-checkout (whatever git tracks). Document that CI must match the OS that produced the baselines. Cross-OS support is a v0.53+ concern, possibly via OS-suffixed baselines (`<slug>--<vp>--linux.png`).

3. **Should the diff PNG be committed alongside the baseline as a "previous diff"?** No — diffs are per-run artifacts under `<runDir>/visual-diffs/`. Committing them would re-introduce the PR-noise problem we're avoiding.

4. **`accept-baselines --review` UX — Ink prompt vs. terminal-only prompt.** Ink is already a dep (used by the v0.47 viewer / TUI scaffolding). Recommendation: Ink-based prompt with j/k navigation in v0.52.3; terminal-only `[a/r/s]` keypress in v0.52.1's minimal subcommand.

5. **What if a vibe-coder runs `bughunter run --visual-regression` against a project with no `.bughunter/baselines/` dir at all?** v0.52 auto-creates the dir on first run; every (route, viewport) emits `visual_baseline_missing`; the user accepts via `bughunter accept-baselines --run <runId> --yes`. The first run's `visual_baseline_missing` clusters are info-only (don't fail CI under any reasonable `--fail-on`). Recommendation: this IS the documented onboarding flow.

6. **Should `visual_diff_above_threshold` cluster across viewports?** Today the cluster signature includes `viewport`, so a diff at 1280 and 768 produce two clusters. Argues for one cluster: a single CSS bug causes both. Argues for two: viewports may diverge (the bug exists at 1280 but not 768). Recommendation: keep two-clusters — drift is information; the user can mentally aggregate. v0.53 may add cross-viewport meta-clusters.

7. **`maskSelectors` matched against shadow DOM (v0.36)?** Recommendation: yes — extend the existing v0.36 shadow-DOM walker. Apply the blackout CSS inside the shadow root via the same selector. Out of scope for v0.52.1; ship in v0.52.2 if the v0.36 walker is already shadow-aware (verify before scoping).

8. **Visual-regression interaction with `--mobile` (v0.41).** The mobile-mode pass produces additional viewports (`375×667`, `390×844`). Each gets its own baseline. No conflict; baselines are keyed by viewport pixel width. Verify in v0.52.1 task #14 that the fixture exercises at least one mobile viewport.

9. **`accept-baselines` on a run with `visual_diff_above_threshold` clusters — does it overwrite the baseline with the new (regressed) image?** YES — that's the entire point. The user looked at the diff PNG, decided "this is the new look," and ran accept-baselines. There is no automated guard against regression-acceptance — that's social/PR-review's job. Document this clearly in `bughunter accept-baselines --help`.

10. **Do we need a `visualRegression.ignoreSelectors` (don't include in diff at all) separate from `maskSelectors` (blackout but still in diff)?** Recommendation: `maskSelectors` (blackout) is sufficient for v0.52. A blackout in baseline + actual produces zero diff; effectively ignored. A separate `ignoreSelectors` is over-engineering. Defer.

---

## 16. Risks + escape hatches

- **Risk: pixelmatch threshold tuning takes more iterations than expected.** Mitigation: ship the default 0.5% as configurable; document tuning in the help output; v0.52.2 task #18 adds per-route thresholds.
- **Risk: `injectAnimationSuppression` doesn't catch every animation source (CSS-in-JS, Web Animations API, RAF-driven canvas).** Mitigation: documented limitation. Users mask the offending element via `maskSelectors`. v0.53 may add a Web Animations API freeze via CDP.
- **Risk: pngjs decoder fails on PNGs produced by camofox (color profile mismatches).** Pre-implementation check in task #8 — verify a camofox-produced PNG decodes via pngjs cleanly. If it fails, switch to `sharp` (heavier dep) or pre-process via `playwright-core`'s built-in decoder.
- **Risk: Filesystem committed-baseline approach causes massive PR diffs on first acceptance.** Mitigation: documented onboarding — `accept-baselines --yes` happens once, in a "seed baselines" PR, separate from feature PRs. CI templates document this pattern.
- **Risk: A vibe-coder runs the CSS auto-fixer, the diff PNGs scream, they panic and disable the feature.** Mitigation: `bughunter accept-baselines --review` (v0.52.3) makes the accept-loop low-friction. Documentation explicitly covers "what to do when every route fails" — usually answer is `accept-baselines --yes` for an intentional refactor.
- **Escape hatch: `--no-visual-regression`** even when the config sets `enabled: true` — emergency disable for one run. Mirrors the existing `--no-a11y` pattern.

---

## 17. Killer-demo runbook (Aspectv3)

```bash
# 1. First run — seed proposed baselines (everything is "missing")
cd /root/Aspectv3
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --visual-regression \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --max-bugs 100 --budget 600000

RUN1=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.visualRegression' /root/Aspectv3/.bughunter/runs/$RUN1/summary.json
# Expect: { ..., baselineMissing: <N>, changed: 0, matched: 0, ... }

# 2. Accept all proposed baselines
node /root/BugHunter/packages/cli/dist/cli/main.js accept-baselines --run $RUN1 --yes
ls /root/Aspectv3/.bughunter/baselines/ | head -5
# Expect: <N> committed baseline PNGs

# 3. Run again unchanged — zero diffs
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --visual-regression \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --max-bugs 100 --budget 600000
RUN2=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.visualRegression' /root/Aspectv3/.bughunter/runs/$RUN2/summary.json
# Expect: { ..., baselineMissing: 0, changed: 0, matched: <N>, ... }

# 4. Edit a CSS file, re-run — diff fires
sed -i 's/color: #333/color: #f00/' /root/Aspectv3/src/styles/footer.css
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --visual-regression \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --max-bugs 100 --budget 600000
RUN3=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.byKind.visual_diff_above_threshold // 0' /root/Aspectv3/.bughunter/runs/$RUN3/summary.json
# Expect: ≥ 1
ls /root/Aspectv3/.bughunter/runs/$RUN3/visual-diffs/
# Expect: <slug>--1280.actual.png, <slug>--1280.diff.png, <slug>--1280.diff.json

# 5. The user looks at the diff PNG, decides "yep, intentional," accepts
node /root/BugHunter/packages/cli/dist/cli/main.js accept-baselines --run $RUN3 --yes

# 6. Next run: clean again
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --visual-regression \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --max-bugs 100 --budget 600000
RUN4=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.visualRegression.changed' /root/Aspectv3/.bughunter/runs/$RUN4/summary.json
# Expect: 0
```

Expected: each step terminates as documented. The full loop demonstrates capture → diff → review → accept → re-baseline, which is the entire product.
