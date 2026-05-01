# SPEC — v0.37 "i18n / locale stress"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-04-30
**Depends on:**
- v0.23 frozen-clock & timezone polyfill (the time-of-day arithmetic side; V37 owns the *display-format* side and explicitly defers anything driven by `Date.now()` to V23)
- v0.36 vision-pipeline (per-page baseline-and-diff screenshot infrastructure; V37 reuses the same screenshot store and same diff helper, registering one extra "RTL" capture branch)

**Predecessor in family:** SPEC_PATH_TO_EXHAUSTIVE §3.2, §9 Phase E.
**Sibling V-specs in Phase E:** v0.34 browser-platform-probe (§3.1), v0.38 form/input edge cases (§3.3), v0.40 mobile/responsive (§3.6).

This spec adds seven `i18n_*` BugKinds and a `--locale-stress` CLI flag that runs a per-page locale-variant pass over the existing discovery walk. The pass renders each reachable page in a small set of locale variants (LTR baseline / RTL / long-string / ambiguous-date / ambiguous-currency / pluralization), measures DOM-side layout invariants, vision-diffs against the LTR baseline, and emits findings. A static-analysis sub-pass scans the source tree for hardcoded user-facing strings outside translation calls.

The cohort target is the same vibe-coded SPA that BugHunter already walks: most ship English-only, then bolt on Spanish or German under sales pressure, and the resulting RTL-and-overflow defects are exactly the high-signal mechanical bugs BugHunter is best positioned to catch. None of the proposed detectors require localization-domain expertise from the user — every one is invariant-driven (overflow, overlap, clipping, format-roundtrip, regex-with-allowlist).

---

## 1. Objective

Add an opt-in `--locale-stress` pass to BugHunter that:

1. Renders each reachable page under a fixed set of locale variants and detects layout / format / overflow defects from the *visual* and *DOM-measurement* outputs.
2. Statically scans the project's source tree for hardcoded user-facing strings outside an allowlist of translation-function call sites.
3. Emits findings under seven new `i18n_*` BugKinds, all of which carry stable bugIdentity values consistent with §7.1 of `SPEC_PATH_TO_EXHAUSTIVE`.

The pass is opt-in (off by default), reuses the V36 vision-pipeline screenshot store, reuses the V23 frozen-clock for the date-format BugKind, and adds zero new mandatory runtime dependencies. The static analyzer is heuristic with an explicit allowlist; false positives are expected and the spec includes a calibrated suppression mechanism.

**In scope:**
- Seven new BugKinds in the `BugKind` discriminated union
- One new CLI flag (`--locale-stress`)
- One new orchestrator phase (`packages/cli/src/phases/locale-stress.ts`)
- One new mutation-palette extension for currency/date inputs (extension, not replacement, of `mutation/palette.ts`)
- One new static-analysis tool wired into the existing static runner (`static/tools/hardcoded-strings.ts`)
- Configuration block in BugHunter config schema for the locale variant set
- Acceptance fixtures: a tiny RTL-broken page and a tiny long-string-overflow page in `fixtures/i18n/`

**Out of scope (deferred or rejected):**
- ICU MessageFormat parsing depth — we read the rendered DOM, not the message catalog. Out forever; that's a job for a translation linter, not a runtime walker.
- Locale-aware screen-reader assertion — V06 axe rules already test ARIA-lang. Defer to V06 follow-up.
- BiDi character isolation auditing (Unicode TR9) — niche; defer to v0.41 if a target needs it.
- Auto-detection of which library handles translations (i18next vs react-intl vs Lingui) — heuristic does string-match on the call-site name; user supplies overrides via config. We do not auto-import `i18next.parse`.
- Date arithmetic across DST / leap / Y2038 — owned by V23. V37 only checks how a *given* date *displays*.
- Locale-aware sort order audits — out forever; pure data-layer concern.
- Right-to-left mirrored *iconography* (e.g. an arrow icon that should flip in RTL) — too target-specific; defer indefinitely.
- Locale-aware *form validation* error message verification — overlaps with V09 form-submit; rejected because the assertions are property-based per locale, which doesn't fit BugHunter's surface model.

**Acceptance target on Aspectv3 + a fresh RTL-broken fixture:**
With `--locale-stress` enabled, the next smoke produces:
- `summary.json.localeStress.variantsRun >= 6` (LTR baseline + 5 stress variants per page sampled)
- ≥ 1 `i18n_rtl_layout_break` cluster on the synthetic RTL fixture (controlled positive)
- 0 `i18n_*` clusters on a known-clean fixture page (controlled negative; precision floor)
- Static analyzer reports a `summary.json.localeStress.hardcodedStringsScanned >= 1`
- Total run-time overhead with `--locale-stress` ≤ 60% on top of a non-stress run on the same target (budget ceiling)

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` discriminated union — extend with seven new variants. Single edit; keep alphabetical inside the v0.37 block. |
| `packages/cli/src/discovery/dom-walker.ts` | Vision-baseline anchor pattern. The locale-stress phase renders the same pages already collected here; do **not** re-discover. Pull from the existing `DomWalkResult`. |
| `packages/cli/src/phases/discover.ts` | Top-level discovery orchestrator. The new locale-stress phase plugs in **after** discover and **after** the V36 vision-baseline pass — operates on already-rendered URLs. |
| `packages/cli/src/phases/discover-vision-baseline.test.ts` | Pattern for a per-URL screenshot-and-diff test. Mirror its `vi.mock` shape exactly; reuse `VisionClientInterface`. |
| `packages/cli/src/classify/vision.ts` | `runVisionClassification` — the same call pattern used for visual_anomaly. The new RTL diff uses the same client; we just feed it two screenshots and a different prompt. |
| `packages/cli/src/classify/vision-budget.ts` | Per-run vision-call budget. The locale-stress pass is governed by the same budget; do not bypass it. |
| `packages/cli/src/mutation/palette.ts` | Existing palette generators. Add one new generator for `i18n_long_string` that returns `{variant: 'happy', value: '<200-char compound>'}` style entries — slot in alongside existing per-type generators. |
| `packages/cli/src/static/runner.ts` | Static-analysis orchestrator. Register the new `hardcoded-strings.ts` tool here. Do **not** create a parallel runner. |
| `packages/cli/src/static/tools/semgrep.ts` | Pattern for a static-analysis tool entry: `name`, `run(opts) -> Promise<Finding[]>`, deterministic outputs. Mirror exactly. |
| `packages/cli/src/cli/main.ts` | CLI flag parser. Add `--locale-stress` to the flag list (alongside `--a11y`, `--seo`). Wire to `runOptions`. |
| `packages/cli/src/cli/run.ts` | The `run` command body. Pass `localeStress` into the discovery phase config. |
| `packages/cli/src/adapters/browser-mcp.ts` | `evaluate(script)` and `screenshot(outputPath?)` — the only two browser primitives the locale-stress pass needs. Do **not** add new browser-mcp methods. |
| `packages/cli/src/store/` (whichever JSONL writer is current) | Findings emit pattern — the new BugKinds emit through the same writer; verify the schema accepts the new `kind` strings without migration. |
| `SPEC_V13_VISION_BASELINE_AUTH.md` | Vision-baseline lifecycle reference. Locale-stress runs after baseline, never before. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §3.2 | The class table that defined the seven detection categories — V37 implements exactly this table. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | This V-spec format reference. Match section ordering. |

### 2.2 Patterns to follow

- **Phase boundary:** locale-stress is a *post-discovery* phase, not an in-discovery mutation. It receives an immutable `DomWalkResult[]` and a per-URL screenshot list; it does not re-walk. Mirror the way V06 a11y baseline plugs in.
- **Vision-budget gating:** every screenshot taken inside the pass decrements the per-run vision budget through the existing `VisionBudget`. If the budget is exhausted, the pass logs a skip-reason and exits cleanly — it never blocks.
- **Deterministic seeding:** locale variants are a fixed list, not a sample. The pass is deterministic — no random selection. Order: `[ltr_baseline, rtl, long_string_de, long_string_zh, ambiguous_date, currency_jpy_bhd, pluralization_n0_n1_nmany]`.
- **Discriminated-union returns:** every detector function returns `BugDetection[]` (the existing emit shape). New BugKinds carry the same `screenshotPath`, `selector`, `evidence` fields used by `visual_anomaly`.
- **Empty / null behavior:** if the page can't be re-rendered in a variant (navigation fails, evaluate throws, screenshot returns empty), emit a `surface_call_failed` (existing kind), not an i18n kind. Don't fabricate signal from infrastructure failure.
- **No dependency installs:** all required text manipulation is vanilla JS. The hardcoded-string scanner uses Node's built-in `fs/promises` plus a regex; no parser deps.
- **Static-analyzer contract:** the new hardcoded-strings tool follows the existing `Tool` interface in `static/runner.ts`. Run-time: ≤ 200 ms on a 50k-LOC tree; deterministic; emits findings in the same shape as semgrep.

### 2.3 DO NOT

- Do **not** re-walk the DOM in the locale-stress phase. Reuse the discovery output. Re-walking is a 5-10x overhead and breaks budget.
- Do **not** install `i18next-parser`, `react-intl`, `negotiator`, `globalize`, or any locale library. Heuristic-only.
- Do **not** add a new browser-mcp method. Use the existing `evaluate` to inject `<html dir="rtl">` and the existing `screenshot` to capture. Adding adapter methods inflates surface and triggers V11 dom-consistency contract reviews.
- Do **not** use pixel-diff thresholds — pixel diff is fragile across font hinting, AA settings, and headless-mode renderer drift. Use bounding-box geometry diff plus a vision LLM judge.
- Do **not** make `--locale-stress` discoverable via heuristic. Opt-in only; users who don't ship i18n shouldn't pay the cost.
- Do **not** parse the project's translation catalog (e.g. `locales/*.json`) — out of scope. Symptom-only detection.
- Do **not** emit `i18n_hardcoded_string` for strings inside `*.test.{ts,tsx,js,jsx}`, `*.spec.*`, `*.stories.*`, or any path matched by the gitignore. Test fixtures are not user-facing.
- Do **not** treat single-word strings as user-facing. Heuristic floor: ≥ 3 chars, contains at least one whitespace OR is wrapped in JSX text. (Bare PascalCase identifiers and single tokens are noise.)
- Do **not** emit `i18n_long_string_overflow` for *every* page where a string overflows — cluster by component selector to avoid 500-finding floods.
- Do **not** modify V23's frozen-clock plumbing. The date-format detector reads the *rendered* date string and asks a regex whether the format is unambiguous; it doesn't manipulate `Date`.
- Do **not** introduce a new `Locale` type — the variant set is a const string union; locales are values, not domain types.

---

## 3. New BugKinds

All seven added to `packages/cli/src/types.ts` `BugKind` union, in a single v0.37 block placed after the v0.19 race-condition block (chronologically last). Order is alphabetical within the block.

```ts
// v0.37 i18n / locale stress kinds
| 'i18n_currency_format_broken'
| 'i18n_date_format_ambiguous'
| 'i18n_hardcoded_string'
| 'i18n_long_string_overflow'
| 'i18n_pluralization_broken'
| 'i18n_rtl_layout_break'
| 'i18n_timezone_display_wrong';
```

Per-kind detection contract follows.

### 3.1 `i18n_rtl_layout_break`

**What:** the page renders with `<html dir="rtl">` applied; layout exhibits clipped text, overlapping elements, or broken icon orientation that did not exist in the LTR baseline.

**Detector:**
1. Reuse the LTR baseline screenshot already captured by V36 vision-pipeline.
2. In the same browser tab (post-discovery, post-baseline), execute:
   ```js
   document.documentElement.setAttribute('dir', 'rtl');
   document.documentElement.setAttribute('lang', 'ar');
   ```
3. Wait `vision.preScreenshotSettleMs` (existing config) for layout to reflow.
4. Capture an RTL screenshot.
5. Run the **DOM measurement pass** before vision: query every interactive element and capture `getBoundingClientRect()`. Compare to the LTR rect set:
   - **Clipped text:** an element's `scrollWidth > clientWidth + 2` or `scrollHeight > clientHeight + 2` and was not clipped in LTR.
   - **Overlap:** for each pair of sibling interactive elements, compute rect intersection. If a non-zero intersection exists in RTL but not LTR, flag.
   - **Off-screen:** an element whose RTL rect places `right < 0` or `left > viewport.width`.
6. If any of (clipped, overlap, off-screen) occurred, emit `i18n_rtl_layout_break`. Vision is consulted only as a tie-breaker when the geometric heuristic flags ambiguous cases (see §6).
7. Restore `dir="ltr"` afterwards.

**Categories** (sub-classification in evidence): `clipped_text`, `overlapping_elements`, `off_screen`, `vision_judgment`.

**Selector + evidence:** the offending element's CSS selector (from existing `bestSelector` helper); the LTR + RTL rect tuple; both screenshot paths.

### 3.2 `i18n_long_string_overflow`

**What:** when a text input or text-rendering element receives a 200-char German compound or 1000-char Chinese string, the visible result truncates without an ellipsis indicator, overlaps an adjacent element, or pushes ancestor layout outside the viewport.

**Detector:**
1. Use the existing form-discovery results to enumerate text inputs on the page.
2. For each text input, fill with the long-string value via the existing fill helper (palette extension, see §5).
3. Re-run the geometric measurement pass.
4. Specifically:
   - Filled control's `scrollWidth > clientWidth + 8` AND parent has no `text-overflow: ellipsis` computed style → `truncated_no_indicator`.
   - Filled control's outer rect now overlaps a previously-non-overlapping sibling → `overlap_after_fill`.
   - Filled control's outer rect now extends past `document.documentElement.clientWidth + 16` → `viewport_overflow`.
5. Two payloads tested per input:
   - **DE compound:** `'Donaudampfschiffahrtsgesellschaftskapitänsmützenherstellungsverwaltungsgebäudemeisterschlüssel'.repeat(2).slice(0, 200)`
   - **ZH long:** `'长'.repeat(1000)`

**Cluster key:** input field selector + payload class — at most 2 findings per input, regardless of how many parents it busts.

### 3.3 `i18n_date_format_ambiguous`

**What:** a date that is ambiguous between US (`MM/DD/YYYY`) and EU (`DD/MM/YYYY`) formats is rendered without disambiguating context (no month name, no ISO 8601, no locale-aware suffix).

**Detector:**
1. Inject `2026-03-04` (which is `Mar 4 2026` in US, `April 3 2026` in EU) into any reachable date input. Submit the form per the existing form-submit runner.
2. After re-render, scan the visible DOM (`document.body.innerText`) for occurrences of the rendered date.
3. Run a regex set:
   - **Bad:** `/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}\b/` (numeric `MM/DD/YYYY` or `DD/MM/YYYY` — ambiguous).
   - **Good:** `/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i`, `/\b\d{4}-\d{2}-\d{2}\b/` (ISO), `/\b\d{1,2}\.\d{1,2}\.\d{4}\b/` (DE dotted — at least disambiguates by separator).
4. If a match for the **Bad** regex appears within 200 chars of the date input's label (DOM proximity heuristic) AND no **Good** regex match appears in the same window, emit.

**Why proximity:** to avoid flagging unrelated dates elsewhere on the page. The 200-char window approximates "this is the field's display."

**Boundary with V23:** V23 owns "the date arithmetic was wrong because the clock was injected with the wrong tz." V37 owns "the displayed string is ambiguous regardless of arithmetic." If both fire, both stay — they describe different defects.

### 3.4 `i18n_hardcoded_string`

**What:** a user-facing string literal in source code that is not wrapped in a translation function. Static-only.

**Detector:** new tool `static/tools/hardcoded-strings.ts` invoked via the existing static runner.

**Heuristic (regex with allowlist):**
- File globs: `**/*.{ts,tsx,js,jsx}` minus `**/*.{test,spec,stories,d}.{ts,tsx,js,jsx}` minus paths in `.gitignore` minus paths matching `**/node_modules/**`.
- For each file, find string literals (`'...'`, `"..."`, JSX text nodes) where:
  - Length ≥ 3
  - Contains at least one whitespace OR is JSX text (heuristic for "user-facing prose")
  - Starts with an ASCII letter (rejects URLs, paths, dotted accessors)
  - Is **not** within `MAX_AST_DEPTH` of any of the call-site names in the **allowlist** (see below). AST-free heuristic: scan a 60-char window before the literal for the function-call pattern.

- **Allowlist call sites** (default, configurable):
  - `t(`, `i18n.t(`, `useTranslation(`, `<Trans`, `<FormattedMessage`, `formatMessage(`, `__(`, `_(`, `gettext(`, `Lingui.`, `intl.formatMessage(`
- **Allowlist path patterns:**
  - Anything under `import` / `from` clauses
  - JSX prop names: `data-*`, `aria-*` excluding `aria-label`/`aria-labelledby`/`aria-description` (those ARE user-facing)
  - The first arg to `console.{log,warn,error,info,debug}` (developer noise, not user-facing)
  - String members of constant arrays declared with `// i18n-allow` directive on the previous line (suppression mechanism)

- **Cluster key:** `<file-path>:<line>:<first-30-chars-of-string>` — stable bugIdentity across runs.

**Confidence:** every finding carries `confidence: 'heuristic'` to distinguish from runtime-verified findings. Triage UI surfaces this.

**Run-time budget:** scanner reads files once, regex per file. On a 50k-LOC TS tree expect ≤ 200 ms. If exceeded, log a perf telemetry entry — do not fail the run.

### 3.5 `i18n_pluralization_broken`

**What:** a count-driven string ("0 items" / "1 item" / "5 items") reads wrongly for at least one of n=0, n=1, n=many.

**Detector:**
1. Look for a "count" text node — heuristic: any element whose text matches `/^\s*\d+\s+\S/` (e.g. "0 items", "5 results"). Tag the form/input that drives the count, if any.
2. For each tagged form, drive three executions:
   - n=0: clear all related state via the existing reset path
   - n=1: seed exactly one record (re-uses V14 seedHooks, if available; falls back to creating one through the form)
   - n=5: seed five records (or create through the form five times)
3. After each, capture the count text. Verify:
   - n=0 form: text contains `"0"` and the noun is *not* the same morph as n=1 (e.g. expect `"0 items"`, NOT `"0 item"`)
   - n=1: text contains `"1"` and the noun is singular morph
   - n=5: text contains `"5"` and the noun matches n=0's morph (plural)
4. Heuristic morph check (English only for now): noun ending in `s` for plural cases, no trailing `s` for singular. Languages with more complex pluralization (RU, AR, PL, CZ) flagged as `language_unsupported` skip-reason.

**Limitations** (documented as `coverage: 'english_only'` in the finding):
- Languages with ≥ 3 plural categories (Slavic, Arabic) are skipped with a recorded reason.
- Mass nouns ("0 information") are false negatives.

### 3.6 `i18n_currency_format_broken`

**What:** a currency value renders with the wrong number of decimal places for its currency code (JPY: 0 decimals, USD/EUR: 2, BHD/JOD/KWD: 3).

**Detector:**
1. Identify currency-format text — heuristic: `/[\$\€\¥\£]\s?\d/` or `/\b(USD|EUR|JPY|BHD|JOD|KWD|CHF|GBP)\s?\d/`.
2. For each, parse the rendered string and inspect decimal places:
   - JPY / KRW / VND symbols followed by digits → decimal count must be 0.
   - BHD / JOD / KWD → decimal count must be 3.
   - USD / EUR / GBP / CHF → decimal count must be 2 (or 0 for whole-amount flows; flag only when a fraction is present).
3. Inject ambiguous values via input mutation when a currency input is present (palette extension, see §5):
   - Value `100` for JPY → expect render `¥100` not `¥100.00`.
   - Value `100.123` for BHD → expect `BHD 100.123` not `BHD 100.12`.
   - Value `100` for USD → expect `$100.00` not `$100.000`.
4. Emit when render disagrees with currency code's decimal-place rule.

**Limitations:** does not detect locale-specific *separator* (1,000.00 vs 1.000,00 vs 1 000,00). Rejected for v0.37 — too noisy. Defer.

### 3.7 `i18n_timezone_display_wrong`

**What:** a timestamp renders in the wrong timezone for the user's locale OR without any tz indicator at all.

**Boundary with V23 (critical):**
- **V23 owns:** clock-arithmetic correctness. If `Date.now()` is frozen to `2026-03-08T07:00:00Z` and the app stores the wrong UTC offset, that is a V23 finding (`time_clock_arithmetic_off`).
- **V37 owns:** *displayed* timestamps. If the timestamp on screen is `7:00` with no tz, no AM/PM, no UTC offset — even if the underlying value was correct — V37 fires.

**Detector:**
1. Identify visible timestamp text — heuristic: `/\b\d{1,2}:\d{2}(:\d{2})?\b/`.
2. For each match, scan a 40-char window around it for any of: `AM`, `PM`, `UTC`, `GMT`, `Z`, `+HH:MM`, `-HH:MM`, named tz (heuristic: 3-letter uppercase like `EST`, `JST`, `IST`).
3. If no disambiguator present → `i18n_timezone_display_wrong` with sub-class `no_tz_indicator`.
4. If V23 frozen-clock is active and the rendered clock differs from the expected clock for the configured user-tz by more than 1h → sub-class `tz_arithmetic_disagrees_with_v23` and DEFER to V23's emission (V23 will emit; V37 suppresses to avoid double-counting).

**Cluster key:** `<page-url>:<text-around-timestamp-window>` to dedupe across re-renders.

---

## 4. Locale-variant pass — implementation

### 4.1 New file: `packages/cli/src/phases/locale-stress.ts`

```ts
// Simplified surface — full implementation is the @coder's job.
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { DomWalkResult } from '../discovery/dom-walker.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { BugDetection } from '../types.js';

export type LocaleVariant =
  | 'ltr_baseline'
  | 'rtl'
  | 'long_string_de'
  | 'long_string_zh'
  | 'ambiguous_date'
  | 'currency_jpy_bhd'
  | 'pluralization_n0_n1_nmany';

export type LocaleStressInput = {
  url: string;
  domWalk: DomWalkResult;
  ltrScreenshotPath: string;       // from V36 vision-baseline output
  ltrRectMap: Record<string, DOMRectLite>; // captured during V36 baseline; reused
  browser: BrowserMcpAdapter;
  vision: VisionClientInterface;
  visionBudget: VisionBudget;
  runId: string;
  outDir: string;
};

export type LocaleStressOutput = {
  url: string;
  variantsRun: LocaleVariant[];
  detections: BugDetection[];
  skippedReasons: { variant: LocaleVariant; reason: string }[];
};

export async function runLocaleStress(input: LocaleStressInput): Promise<LocaleStressOutput>;
```

- `DOMRectLite` is a 4-number tuple `{x, y, w, h}` — does not import the DOM type at the Node layer; defined in `types.ts` alongside the new BugKinds.
- `runLocaleStress` is **pure orchestration**: it coordinates per-variant render, geometry capture, screenshot, diff, emission. Each variant lives in its own file (`packages/cli/src/discovery/locale/<variant>.ts`) so unit tests can target one variant in isolation.

### 4.2 Per-variant rendering

The variant is applied through `browser.evaluate` only — never via reload. Sequence per page:

1. `browser.navigate(url)` — performed once per page (already done in V36 baseline).
2. Capture LTR rect map (already in V36 baseline output; reuse).
3. For each variant in `[rtl, long_string_de, long_string_zh, ambiguous_date, currency_jpy_bhd, pluralization_n0_n1_nmany]`:
   - Apply the variant via a single `browser.evaluate(SCRIPT)` call. Each variant has a *self-contained* script that mutates the page deterministically.
   - Wait `vision.preScreenshotSettleMs`.
   - Capture variant rect map (one `evaluate` round-trip).
   - Capture variant screenshot (decrement vision budget; skip variant if budget exhausted).
   - Run the variant's geometric checker against `(ltrRectMap, variantRectMap)` → preliminary detections.
   - **Tie-breaker vision pass** (§6) only when geometric checker emitted `ambiguous` — sends the `(ltrScreenshotPath, variantScreenshotPath)` tuple to the vision client with the prompt template described in §4.5.
4. Restore the page to LTR baseline state via the inverse `evaluate` (sets `dir`, restores DOM-mutations made by variants). If the inverse fails, emit a telemetry note and skip subsequent variants for this URL.

### 4.3 Variant scripts (illustrative)

**RTL variant:**
```js
(() => {
  document.documentElement.setAttribute('data-bughunter-locale-prev-dir',
    document.documentElement.getAttribute('dir') ?? '');
  document.documentElement.setAttribute('dir', 'rtl');
  document.documentElement.setAttribute('lang', 'ar');
})()
```

**Long-string DE variant:**
```js
(() => {
  const compound = 'Donaudampfschiffahrtsgesellschaftskapitänsmützenherstellungs'.repeat(4).slice(0, 200);
  document.querySelectorAll('input[type=text], input[type=search], textarea').forEach(el => {
    el.setAttribute('data-bughunter-locale-prev-value', el.value || '');
    el.value = compound;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
})()
```

(Same shape for ZH variant with `'长'.repeat(1000)`.)

**Inverse / restore script:**
```js
(() => {
  const prevDir = document.documentElement.getAttribute('data-bughunter-locale-prev-dir');
  if (prevDir !== null) document.documentElement.setAttribute('dir', prevDir || 'ltr');
  document.documentElement.removeAttribute('data-bughunter-locale-prev-dir');
  document.querySelectorAll('[data-bughunter-locale-prev-value]').forEach(el => {
    el.value = el.getAttribute('data-bughunter-locale-prev-value') ?? '';
    el.removeAttribute('data-bughunter-locale-prev-value');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
})()
```

### 4.4 Geometric checker (`packages/cli/src/discovery/locale/geometric-checker.ts`)

Pure function over `(ltrRectMap, variantRectMap, viewportSize)`:

```ts
export type GeometricFinding = {
  kind: 'clipped_text' | 'overlap_pair' | 'off_screen' | 'parent_overflow';
  selector: string;          // primary offender
  pairSelector?: string;     // for overlap_pair
  certainty: 'high' | 'ambiguous';  // 'ambiguous' triggers vision tie-breaker
};

export function checkGeometry(
  ltr: Record<string, DOMRectLite>,
  variant: Record<string, DOMRectLite>,
  viewport: { w: number; h: number }
): GeometricFinding[];
```

- `high` certainty: `off_screen` (rect is wholly outside viewport), `parent_overflow` (variant page's `documentElement.scrollWidth > viewport.w + 16` AND was not in LTR).
- `ambiguous`: `clipped_text` (within 4px tolerance) and `overlap_pair` (intersection ≤ 8px on a single axis) — these often legitimate in RTL, vision must adjudicate.

### 4.5 Vision tie-breaker prompt (§6)

Sent only for `ambiguous` geometric findings; capped by `VisionBudget`:

> You are reviewing two screenshots of the same SaaS web page: an LTR baseline and a variant rendered with `<html dir="rtl">`. The variant should still present the same controls and copy without text being clipped, controls overlapping, or icons appearing visually broken. Reply with a JSON object: `{"layout_broken": boolean, "categories": ("clipped"|"overlap"|"icon_orientation")[], "evidence": "<one-sentence>"}`. If RTL renders correctly (text flows right-to-left, controls visibly mirrored, no broken layout), return `layout_broken: false`.

- Output is parsed by the existing `parseVisionResponse` helper in `classify/vision.ts`; reuse, do not fork.
- Vision result over-rides geometric `ambiguous`: if vision says `layout_broken: false`, no emission. If vision says `true`, emit.

### 4.6 Concurrency

The pass is per-URL serial (it mutates document state in place). Across URLs the existing discovery concurrency applies — locale-stress runs inside the same per-URL fixture as V36 baseline, with the singleton-tab discipline V13 established.

---

## 5. Mutation-palette extensions

### 5.1 Add to `packages/cli/src/mutation/palette.ts`

Two new generators, both opt-in via the locale-stress pass (do NOT add them to the default palette — that would inflate every test plan with locale variants):

```ts
export function paletteForLocaleLongString(): Array<{variant: 'happy', value: string}> {
  return [
    { variant: 'happy', value: 'Donaudampfschiffahrtsgesellschaftskapitänsmützenherstellungs'.repeat(4).slice(0, 200) },
    { variant: 'happy', value: '长'.repeat(1000) },
  ];
}

export function paletteForCurrency(): Array<{variant: 'happy', value: string, currency: 'JPY'|'BHD'|'USD'}> {
  return [
    { variant: 'happy', value: '100', currency: 'JPY' },
    { variant: 'happy', value: '100.123', currency: 'BHD' },
    { variant: 'happy', value: '100', currency: 'USD' },
  ];
}

export function paletteForAmbiguousDate(): Array<{variant: 'happy', value: string}> {
  return [{ variant: 'happy', value: '2026-03-04' }];
}
```

**Invariant:** these generators do NOT extend `PaletteVariant`. The variant tag stays `'happy'` because they are not testing palette boundaries; they're driving the locale-stress pass with deliberate inputs. Extending `PaletteVariant` would force every palette consumer to handle locale variants — wrong.

### 5.2 Wire to locale-stress orchestrator

Each variant in `runLocaleStress` calls the appropriate palette generator. The palette is consumed only inside the locale-stress phase — no other phase changes.

---

## 6. Hardcoded-string static analyzer

### 6.1 New file: `packages/cli/src/static/tools/hardcoded-strings.ts`

```ts
import type { Tool, Finding } from '../runner.js';

export const hardcodedStringsTool: Tool = {
  name: 'hardcoded-strings',
  run: async (opts) => { /* see below */ },
};
```

### 6.2 Implementation outline

1. Read project root from `opts.projectRoot`.
2. Glob `**/*.{ts,tsx,js,jsx}`, exclude `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/*.{test,spec,stories,d}.{ts,tsx,js,jsx}`, gitignored paths.
3. For each file, scan line-by-line.
4. **String-literal pattern (regex, multi-line over the joined file content):**
   ```
   /(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|>([^<>{}\s][^<>{}]*)</g
   ```
   First two captures: ' and " literals. Third: JSX text nodes (between a `>` and a `<`).
5. **For each match:**
   - Reject if length < 3.
   - Reject if no whitespace AND not from JSX-text capture.
   - Reject if first non-space char is not an ASCII letter (rejects URLs, paths, regex, tags, dotted accessors).
   - Reject if 60-char preceding window matches any allowlist call-site (`/(?:^|[^\w])(?:t|i18n\.t|useTranslation|formatMessage|__|_|gettext)\s*\($/` plus JSX-component markers `<Trans` / `<FormattedMessage`).
   - Reject if 60-char preceding window matches `console\.\w+\(` for first-arg position.
   - Reject if 60-char preceding window matches `import\b|from\s*$|require\(`.
   - Reject if 30-char preceding window matches `data-\w+=` or `aria-(?!label|labelledby|description)\w+=`.
   - Reject if line is preceded (≤ 2 lines back) by a comment `// i18n-allow` or `// eslint-disable-next-line bughunter/i18n-hardcoded`.
6. Emit a `Finding` with `kind: 'i18n_hardcoded_string'`, `path`, `line`, `column`, `evidence: <first-80-chars>`.

### 6.3 Calibration knobs

Config block in `bughunter.config.json` (additive, optional):

```json
{
  "i18n": {
    "hardcodedStrings": {
      "translationCallsites": ["t", "i18n.t", "useTranslation", "formatMessage", "__"],
      "extraExcludes": ["**/legacy/**"],
      "minStringLength": 3,
      "requireWhitespace": true
    }
  }
}
```

The call-site list is project-supplied; defaults shipped per §3.4.

### 6.4 Performance budget

- File read concurrent via `Promise.all(globFiles.map(readFile))` capped at 32 in-flight.
- Single `RegExp.exec` loop per file.
- Acceptance: ≤ 200 ms for a 50k-LOC TS tree on a developer laptop. Beyond that, the run logs `localeStress.hardcodedStringsScannerSlow: true` and continues — never a hard fail.

### 6.5 False-positive policy

The detector is HEURISTIC and labelled `confidence: 'heuristic'` on every emission. If precision falls below 70% on the calibration corpus (Phase F), the detector becomes opt-in (gated under `--locale-stress --locale-stress-static`). Until then it's enabled by `--locale-stress` by default.

---

## 7. CLI

### 7.1 New flag

In `packages/cli/src/cli/main.ts`, add to the help block (alphabetically in the Phase E flag list once V37 lands):

```
  --locale-stress             Enable i18n / locale stress pass (RTL render, long-string overflow,
                              date format, currency format, pluralization, hardcoded-strings static)
```

### 7.2 Plumbing

- `parseArgs` already handles boolean flags. Add `localeStress: flags['locale-stress'] === true` to the `runOptions` shape.
- `cli/run.ts` passes `localeStress` into the discovery phase config.
- `phases/discover.ts` invokes `runLocaleStress` per page after V36 baseline completes when `config.localeStress === true`.
- The static analyzer (hardcoded-strings) runs in the existing static phase; gated by the same flag.

### 7.3 Telemetry

`summary.json.localeStress` block added on every run with `--locale-stress`:

```json
{
  "localeStress": {
    "enabled": true,
    "variantsConfigured": 6,
    "variantsRunPerUrl": { "<url>": ["rtl","long_string_de", ...] },
    "skippedReasons": [{"url":"...","variant":"rtl","reason":"vision_budget_exhausted"}],
    "hardcodedStringsScanned": 312,
    "hardcodedStringsFlagged": 14,
    "hardcodedStringsScannerSlow": false,
    "totalDurationMs": 8420
  }
}
```

If `--locale-stress` is not set, the `localeStress` key is omitted (not `null`).

---

## 8. Acceptance criteria

| Criterion | Verifier |
|---|---|
| Seven new BugKinds present in `BugKind` union and exported | `grep "i18n_" packages/cli/src/types.ts \| wc -l` returns 7 |
| `--locale-stress` flag parses, propagates to discover phase | unit test in `cli/run-auth-flow.test.ts` style |
| `runLocaleStress` returns clean result on a stable LTR-only fixture (zero detections) | integration test in `phases/locale-stress.test.ts` against `fixtures/i18n/clean/` |
| `runLocaleStress` emits `i18n_rtl_layout_break` on `fixtures/i18n/rtl-broken/` | integration test |
| `runLocaleStress` emits `i18n_long_string_overflow` on `fixtures/i18n/overflow/` | integration test |
| Hardcoded-strings tool flags 3 known-bad literals in `fixtures/i18n/source/` and 0 false positives in 5 known-clean files | unit test in `static/tools/hardcoded-strings.test.ts` |
| Vision tie-breaker is bypassed when geometric checker returns `high` certainty | unit test |
| Vision tie-breaker is gated by `VisionBudget` (no calls when exhausted) | unit test |
| Pass is no-op when `--locale-stress` not present | integration test verifies `localeStress` key absent in summary |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| `npx vitest run` passes | `vitest` |
| End-to-end smoke against Aspectv3 with `--locale-stress`: completes within budget, emits ≥ 0 findings, no crash | manual smoke |
| Locale-stress overhead vs no-flag run on Aspectv3 ≤ 60% | manual measure |
| Hardcoded-strings scanner ≤ 200 ms on a 50k-LOC TS tree | benchmark in scanner test |

---

## 9. Files

### 9.1 To create

| Path | Purpose |
|---|---|
| `packages/cli/src/phases/locale-stress.ts` | Orchestrator. ≤ 220 lines. |
| `packages/cli/src/phases/locale-stress.test.ts` | Phase tests (mocked browser + vision). |
| `packages/cli/src/discovery/locale/rtl.ts` | RTL variant apply + restore + checker. ≤ 80 lines. |
| `packages/cli/src/discovery/locale/long-string.ts` | Long-string variant. ≤ 80 lines. |
| `packages/cli/src/discovery/locale/ambiguous-date.ts` | Ambiguous-date variant. ≤ 80 lines. |
| `packages/cli/src/discovery/locale/currency.ts` | Currency variant. ≤ 80 lines. |
| `packages/cli/src/discovery/locale/pluralization.ts` | Pluralization variant. ≤ 100 lines (English-only morph check). |
| `packages/cli/src/discovery/locale/timezone-display.ts` | Timezone display checker (post-V23 boundary). ≤ 60 lines. |
| `packages/cli/src/discovery/locale/geometric-checker.ts` | Pure geometric diff. ≤ 120 lines. |
| `packages/cli/src/discovery/locale/geometric-checker.test.ts` | Geometric checker tests. |
| `packages/cli/src/static/tools/hardcoded-strings.ts` | Static analyzer. ≤ 180 lines. |
| `packages/cli/src/static/tools/hardcoded-strings.test.ts` | Scanner tests. |
| `fixtures/i18n/clean/index.html` | Clean LTR fixture. |
| `fixtures/i18n/rtl-broken/index.html` | RTL-broken fixture (positive control). |
| `fixtures/i18n/overflow/index.html` | Long-string overflow fixture. |
| `fixtures/i18n/source/{good,bad}/*.tsx` | Hardcoded-strings scanner fixtures. |

### 9.2 To modify

| Path | Change |
|---|---|
| `packages/cli/src/types.ts` | Add 7 BugKinds; add `DOMRectLite`, `LocaleVariant` types. |
| `packages/cli/src/mutation/palette.ts` | Add 3 palette generators (long-string, currency, ambiguous-date). NO change to existing generators. |
| `packages/cli/src/cli/main.ts` | Add `--locale-stress` flag parsing + help text. |
| `packages/cli/src/cli/run.ts` | Pass `localeStress` into runOptions. |
| `packages/cli/src/phases/discover.ts` | Invoke `runLocaleStress` after V36 baseline when flag set. |
| `packages/cli/src/static/runner.ts` | Register `hardcodedStringsTool`. |
| `packages/cli/src/store/<writer>.ts` | Verify the JSONL writer accepts the new `kind` strings without migration (likely no-op). |
| `README.md` | Add `--locale-stress` to flag table. |

### 9.3 Forbidden to create

- New `Locale` domain type
- New browser-mcp adapter method
- New translation-library wrapper
- A second static-analysis runner

---

## 10. Definition of done

1. All seven BugKinds emit cleanly on their respective positive fixtures.
2. All seven emit zero findings on their respective negative fixtures.
3. `--locale-stress` flag is documented in README and `--help`.
4. `summary.json.localeStress` is well-formed and present iff the flag is set.
5. Without `--locale-stress`, run-time is unchanged within ±2% (no accidental cost on the default path).
6. Vision-budget exhaustion is logged as a skip-reason, never crashes.
7. Hardcoded-strings scanner produces deterministic output for the same input across runs.
8. End-to-end smoke against Aspectv3 with `--locale-stress` completes; findings (if any) are reproducible across re-runs.
9. `npx tsc --noEmit`, ESLint zero-warnings, vitest all green.
10. The pass respects the V11 dom-consistency contract: every `evaluate` script has a paired restore script and is idempotent.

---

## 11. Open questions

1. **Variant ordering inside one URL — is fixed order correct?** Alternatives: random shuffle (more diverse signal across runs but breaks `--seed` determinism), priority order (RTL first because it's the highest-signal). Lean fixed order; if Phase F precision data argues otherwise, revisit.

2. **Should `i18n_pluralization_broken` cover languages beyond English?** Current spec says no; English-only with `language_unsupported` skip. This bounds scope but means the detector is dead weight for non-English-default targets. Option B: ship CLDR plural-rule data (~25 KB gzipped, no runtime dep) and cover all CLDR languages. Defer to V37.1 unless reviewers push back.

3. **Hardcoded-strings scanner — AST-based vs regex?** Regex is 10x cheaper but ~70-85% precision. AST (TypeScript compiler API, no extra dep) is ~95% precision but adds 2-5 sec to a 50k-LOC scan. Spec ships regex; if Phase F precision is poor, switch to TS compiler API as a follow-up. The spec's `confidence: 'heuristic'` field is the contract that lets us upgrade later without breaking consumers.

4. **Vision tie-breaker on geometric `high`-certainty findings?** Current: vision skipped when geometry is high-certainty. Alternative: always run vision for the precision boost. Cost: ~6× vision calls per URL. Defer to Phase F precision data; meanwhile, geometry-only on `high`.

5. **RTL fixture realism — synthetic or live target?** The acceptance fixtures are synthetic. Plus side: deterministic. Minus side: doesn't catch real-world layout-break patterns. Plan: ship synthetic for v0.37; in Phase F, add a real-target sample (Wikipedia Arabic, Aspectv3 with Arabic locale shim) to the calibration corpus.

6. **Currency separator detection (1,000.00 vs 1.000,00) — really out of scope forever?** Probably reconsider in v0.41 after seeing how much currency-format signal real targets surface. The hard part isn't detection — it's distinguishing "the app picked the wrong locale" from "the app correctly used the user's preferred locale." Without a ground-truth user-locale signal we're guessing; that's why it's deferred.

7. **Should `i18n_timezone_display_wrong` defer entirely to V23 instead of carving the boundary?** Argument for full defer: less double-emission risk. Argument against: V23 is fundamentally clock-arithmetic; "the timestamp on screen has no tz indicator" is a presentation defect that V23 has no business detecting. Spec keeps the carve-out; see §3.7.

8. **Should we capture per-variant DOM snapshots for the eventual `bughunter view` UI?** Storage cost: ~40 KB per variant per URL. Helpful for triage. Lean yes — write to `runs/<runId>/locale-stress/<url-hash>/<variant>.html.gz` and reference from the finding. Open until store-writer review.
