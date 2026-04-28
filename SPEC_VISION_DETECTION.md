# BugHunter v0.4 — Vision-based visual anomaly detection

**Status:** Draft · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-27 · **For implementation by:** @coder (Sonnet)

This spec adds a new bug `kind: 'visual_anomaly'` produced by a multimodal-LLM pass over post-action screenshots. Default-off, opt-in via config. Backward compatible — existing runs are unaffected.

---

## 1. Problem Statement

A recent `/bughunt fix` run against TraiderJo (a "vibe-coded" trading-journal SaaS) produced **0 verified bugs**. The architect-orchestrator refused all 8 critical clusters with file:line citations — honestly characterized as smoke-fixture / probe-palette artifacts. The user's correct intuition: TraiderJo cannot really have zero bugs. The issue is **detection scope**.

Today's `BugKind` union covers:

| Detector | Catches |
| --- | --- |
| `console_error`, `react_error`, `unhandled_exception` | Things the page logs to console |
| `network_5xx`, `network_4xx_unexpected`, `surface_call_failed`, `404_for_linked_route` | API/network failures |
| `dom_error_text` | Visible "Error" / "Failed" text in DOM |
| `missing_state_change` | MutationObserver saw nothing after a mutating action |
| `accessibility_critical` | axe-core delta, only with `--a11y` |

What this **misses**, by construction:

1. **Broken layout** — overlapping elements, sidebar pushed off-screen, modal rendered as full-page block.
2. **Silent rendering failures** — blank `<main>` where the trades table should be, infinite spinner, "0 results" when seed data exists.
3. **Content bugs** — wrong copy, missing labels, raw template strings (`{{trade.symbol}}`) leaking through.
4. **Wrong-state UI** — logged-in nav showing on logged-out page, dark-mode-only style on light theme, button label says "Save" but state still says "Editing…".
5. **Empty-state-that-should-not-be** — clicked into a populated route and it renders the empty-state graphic.
6. **Form validation not rendering** — submitted invalid form, server returns 400 but no visible error message.
7. **Z-index / focus-trap glitches** — modal backdrop on top of modal, dropdown rendered behind sibling, scroll locked when it shouldn't be.

**None of these throw, log, or fire console errors.** The MutationObserver sees DOM changes (a broken layout still mutates the DOM) so `missing_state_change` is silent. Network is fine (the 200 response renders broken HTML). Console is clean. **The application looks broken, but every existing detector returns "no bug."**

The natural addition: **feed the post-action screenshot to a vision-capable LLM and ask "is this UI broken?"** Screenshots are already captured (`scope.screenshot(...)` runs after every UI test, see `phases/execute.ts:168`). The cluster pipeline accepts arbitrary `kind` values — adding `visual_anomaly` is a small surface change.

The cost is bounded (haiku at ~$0.0001/screenshot, ~$0.10 for a 1000-test run) and the failure mode that kills this feature in practice is **false positives**, not cost. The spec is heavy on prompt engineering, severity gating, and dedup precisely for that reason.

---

## 2. Boundaries

### In scope

- New file `packages/cli/src/classify/vision.ts` exporting `classifyVisualAnomalies()` and the prompt builder.
- New file `packages/cli/src/adapters/vision-client.ts` — thin wrapper over `@anthropic-ai/sdk`'s `messages.create` with multimodal input. Pure transport; no business logic.
- New `BugKind` member: `'visual_anomaly'`. Add to the union in `packages/cli/src/types.ts`.
- New optional `BugDetection` fields used only by visual: `visualCategory`, `visualSeverity`, `visualSuggestedFix`. Existing detectors ignore them; cluster signature reads them when `kind === 'visual_anomaly'`.
- Cluster signature branch for `visual_anomaly` in `packages/cli/src/cluster/signature.ts`.
- Fix-hint generator branch for `visual_anomaly` in `packages/cli/src/phases/cluster.ts`.
- Two integration points in `runDiscover` (per-page baseline) and `executeUiTestInner` (per-occurrence on `missing_state_change`). Both gated by `config.vision?.enabled`.
- Config schema extension: `vision?: VisionConfig` in `BugHunterConfig` + Zod schema in `src/config.ts`.
- Per-run vision budget (`maxCalls`), concurrency cap (`concurrency`), severity threshold, screenshot-hash dedup, per-call detection cap, response timeout.
- Unit tests for `classify/vision.ts` (8+ cases enumerated in § 10).
- Integration test using a static fixture page with known visual bugs (overlapping divs, blank container) under `fixtures/vision-broken-page/`.
- Plumbing through `runCommand` so `vision.enabled: true` works end-to-end.
- Add `@anthropic-ai/sdk` as a dependency in `packages/cli/package.json` (pinned version, see § 4.4).
- Update `.bughunter/config.example.json` (if present in init template) and `init.ts` interactive prompts only enough to accept-by-default-disabled.

### Out of scope

- Any vision pass that runs without an explicit screenshot (we never invoke vision speculatively).
- Vision fallback to a non-Anthropic provider. No OpenAI, no local models, no router. One provider, one SDK, one pricing model. (Open question O-1 left for future work.)
- Caching responses across runs. Each run starts fresh (consistent with the rest of BugHunter — runs are ephemeral). Within a run, screenshot-hash dedup applies.
- Asking the model to **fix** the bug. The model classifies + describes; the architect-orchestrator handles fixes via the existing pipeline.
- Ground-truthing against a labeled dataset. The vision pass is a heuristic surfacer, not a benchmarked classifier; the user reviews findings before they go to fix.
- Re-running vision on `verify` retests. The retest compares JSON detections, not pixels; verify-by-vision is plausible but a separate spec.
- Per-region prompts ("look at the trade table specifically"). Whole-screenshot only in v0.4.
- Element-level grounding (sending bounding boxes). Plain-language descriptions only.
- Sending DOM along with the screenshot. **Explicitly excluded** — DOM is verbose, the model gets confused, and the cost grows with token count. Screenshot + URL + action only.
- Capturing additional screenshots solely for vision (e.g. above-the-fold + below-the-fold). v0.4 uses the existing single post-action screenshot.
- Image preprocessing (cropping, denoising). v0.4 sends raw PNG bytes from camofox, optionally downscaled (§ 7).

### External dependencies

- `@anthropic-ai/sdk` (npm, well-maintained, ~30 KB gzipped, pure JS, no native deps). Pin to `0.32.x` (latest stable as of 2026-01).
- `ANTHROPIC_API_KEY` environment variable, OR `vision.apiKey` in config. The skill harness already runs in a Claude session but that's session-scoped; vision needs a programmatic key. **The user must set this before enabling vision** — the spec documents the env var explicitly and `runDiscover` errors loudly if `vision.enabled === true` and no key is resolvable (see § 4.5).
- No other new npm deps. `node:crypto` (built-in) supplies SHA-256 for screenshot hashing.

---

## 3. Existing Code to Reuse

### 3.1 Files you MUST read before writing any code

- `packages/cli/src/types.ts` — `BugKind`, `BugDetection`, `BugHunterConfig`. Extend the union and config in place, do not duplicate.
- `packages/cli/src/config.ts` — Zod `ConfigSchema`. Add the `vision` block exactly like the existing `crawl` and `browserLogin` blocks (matching pattern).
- `packages/cli/src/classify/console.ts` — single-page reference for what a classifier looks like. `classifyVisualAnomalies` follows the same export shape: pure function returning `BugDetection[]`.
- `packages/cli/src/classify/state-change.ts` — shows the "single-detection or null" pattern. Vision can return many detections from one call; that's the only structural difference.
- `packages/cli/src/classify/accessibility.ts` — second reference, shows that `BugDetection[]` returns are common.
- `packages/cli/src/cluster/signature.ts` — `clusterSignature` switch. Add the `case 'visual_anomaly':` branch (§ 6).
- `packages/cli/src/phases/cluster.ts` — `generateFixHints` switch. Add the `case 'visual_anomaly':` branch.
- `packages/cli/src/phases/execute.ts` — `executeUiTestInner` (lines 188-321). The vision call hooks in **after** `persistUiArtifacts` writes the screenshot but **before** the function returns, gated by config and by whether a `missing_state_change` was detected (see § 4.3.2).
- `packages/cli/src/phases/discover.ts` — `runDiscover` returns the discovered pages. The per-page baseline vision pass runs **after** the existing discover loop (§ 4.3.1), reusing the same `browser` adapter to take fresh screenshots.
- `packages/cli/src/cli/run.ts` — orchestrator. The vision-budget controller is constructed in `runCommand` and passed down to both phases. One controller per run; both call sites share it so the budget is global.
- `packages/cli/src/log.ts` — use `log.info`/`log.warn`/`log.error` everywhere. No `console.log`.
- `packages/cli/src/adapters/surface-mcp.ts` and `adapters/browser-mcp.ts` — adapter style reference for the new `vision-client.ts`.

### 3.2 Patterns to follow

- **Classifier shape:** pure function, sync or async, returns `BugDetection[]`. No fs writes, no global state. The two integration points are responsible for fs (the screenshot is already on disk).
- **Adapter shape:** small interface with a single concrete implementation. Constructor takes config, methods return typed results, errors are mapped to a domain-specific error type (mirror `BrowserMcpError`).
- **Config:** `BugHunterConfig` field is optional; resolution of defaults happens in `resolvedConfig`. Vision adds another optional block with the same pattern as `crawl` and `browserLogin`.
- **Zod-validate** at config load. Do not add runtime checks downstream once the config is parsed; trust the schema.
- **Logging:** every meaningful step gets a `log.info`. Failures get `log.warn` (not error) when the run continues; only escalate to `log.error` if the run aborts.
- **Backward-compat:** when `vision.enabled` is false (default) or unset, NO new code paths execute. No SDK is imported eagerly — the import inside `vision-client.ts` is lazy at construction time so a project without `@anthropic-ai/sdk` installed (e.g. tests that don't mock vision) doesn't crash. (This is also why the SDK is a regular dep, not a peer dep.)

### 3.3 Patterns to avoid

- Do **not** create a separate "vision phase" between `execute` and `classify`. Vision detections flow into the existing classify→cluster pipeline alongside other detections from the same test. Adding a phase would invalidate `RunPhase`, the resume protocol, and the saved state schema.
- Do **not** invent a new fixHints field type. `fixHints: string[]` already accommodates rich text; the visual-cluster fix-hint is a multi-line string starting with the description, screenshot path, suggested fix.
- Do **not** add a new artifacts directory. The screenshot the model already saw is the same one the cluster already has. Reuse `screenshotsDir`.
- Do **not** retry the API on classification failures. The vision pass is best-effort; one shot, log on failure, move on.

---

## 4. Architecture

### 4.1 High-level flow

```
runCommand
  ├── runValidate
  ├── construct VisionBudget (one per run; § 4.4)
  ├── runDiscover
  │     └── if vision.enabled: per-page baseline vision pass (§ 4.3.1)
  ├── runPlan
  ├── runExecute
  │     └── per UI test:
  │         ├── existing pre/action/post + classify console + missing_state_change
  │         └── if vision.enabled AND missing_state_change fired:
  │              per-occurrence vision pass (§ 4.3.2) — only on this signal
  ├── runClassify  (no change)
  ├── runCluster   (new signature branch + fix-hint branch)
  └── runEmit      (no change — bugs.jsonl serialises whatever clusters contain)
```

The vision detector is a **classifier**, exactly like `classifyConsoleErrors`. It returns `BugDetection[]` that the executor merges into `bugs` (per-occurrence path) or that the discover phase synthesises into a synthetic test result (per-page baseline path; § 4.3.1).

### 4.2 Why per-page baseline + per-occurrence on missing_state_change (option A3)

Three options were considered:

- **A1 — per-occurrence on every UI test.** Catches interaction-induced visual bugs (modal renders broken). Cost is unbounded with test-case count: a TraiderJo run today executes ~412 UI tests, so ~$0.04 with haiku, fine. But the cost scales with `maxBugs` and with palette breadth, both of which already grow nonlinearly. More importantly, **most UI tests do not change what the screenshot shows in a useful way** (clicking through identical filter buttons produces 30 near-identical screenshots), so the marginal vision call is mostly noise.
- **A2 — per-page baseline only.** Cheap (one call per discovered page; ~30-50 calls for a typical app). Catches static layout/content bugs. **Misses** interaction-induced bugs entirely. The TraiderJo "click did nothing → broken modal appeared" failure mode is the single most valuable one to catch and A2 misses it.
- **A3 (chosen) — per-page baseline AND per-occurrence on `missing_state_change`.** Best signal-per-cost. The per-page pass catches static visual bugs cheaply. The per-occurrence pass runs **only** when a `missing_state_change` already fired — that is the exact signal that says "the action did something the existing detectors can't characterise; vision can disambiguate." The marginal call is roughly `count(missing_state_change clusters) × cluster size`, which on TraiderJo is small (low single digits to low tens). Per-occurrence vision turns "click did nothing" into either:
  - "click broke the layout" (visual_anomaly cluster, useful)
  - "click rendered an unexpected error banner" (visual_anomaly with category=error, useful)
  - "no visual anomaly either" (still a missing_state_change cluster, no change)

  So the per-occurrence vision pass either upgrades the bug to something more actionable or leaves it untouched. It cannot mislabel an unrelated test.

**Decision: A3.** Both paths share the same classifier and the same budget controller. § 4.3 details each.

### 4.3 Integration points

#### 4.3.1 Per-page baseline (in discover phase)

After the existing `runDiscover` body finishes building `pages: DiscoveredPage[]`, **before** returning, iterate `pages` and for each one:

1. If `!browser` or `!config.vision?.enabled`, skip.
2. If the budget controller refuses (`budget.tryConsume()` returns false), log once and break out of the loop.
3. Open a new tab (`browser.openTab`) at `appBaseUrl + page.route` with a 15s timeout. On open-tab failure, log warn, skip page, continue.
4. Wait 1500 ms after open (let async data settle — TraiderJo's dashboards fetch on mount). This is a hardcoded constant in vision.ts; expose later if needed.
5. Take a screenshot to a tmpfile path (use `fs.mkdtempSync` + `path.join`, deterministic filename `vision-baseline-<routeSlug>.png`).
6. Hash the screenshot bytes (SHA-256, hex). If the hash is in the per-run `seenScreenshotHashes` set, close tab and skip. Otherwise add it.
7. Call `classifyVisualAnomalies({ screenshotPath, url: appBaseUrl + page.route, action: { kind: 'render', ... }, role: roles[0] ?? 'anonymous' })`.
8. Close tab.
9. For each returned `BugDetection`, synthesise a `TestResult` with a fresh `testId` and `occurrenceId`, `bugs: [detection]`, and `passed: false`, and **append it to `runState.testResults`** at the discover phase. Implementation note: the discover phase doesn't currently produce `TestResult`s — instead, the new function returns `BugDetection[]` paired with a synthesised `TestCase` (kind: `render`, palette: `happy`, expectedOutcome: `success`) per page-with-detection, and these are merged into the executor input as **pre-baked** test cases that `executeUiTest` short-circuits because they already have a result. Two sub-options:
   - **Option a** (preferred): `runDiscover` returns an extra `visualBaselineDetections: Array<{ page: DiscoveredPage; detection: BugDetection; screenshotPath: string }>`. `runCommand` synthesises one `TestCase` + `TestResult` per detection between discover and plan. The synthesised `TestCase`s are added to `testCases` so the cluster phase can find them via `testCaseMap.get(testId)`. The synthesised `TestResult`s are added to `results` after `runExecute`.
   - **Option b** (rejected): execute a pseudo-test inside discover. Couples discover to execute, complicates resume.

   Use Option a. The runCommand orchestrator becomes:
   ```ts
   const discovery = await runDiscover(...);
   const visualBaselineCases = synthesiseVisualBaselineCases(discovery.visualBaselineDetections);
   // … runPlan returns testCases; concatenate visualBaselineCases.testCases
   const allTestCases = [...visualBaselineCases.testCases, ...testCases];
   // … runExecute sees the synthesised cases but executeUiTest never runs them because…
   // Cleanest approach: do not feed them through executor at all. Instead:
   //   - testCases used for plan/execute = real cases
   //   - testCases passed to runCluster = real cases ∪ visualBaselineCases.testCases
   //   - results passed to runClassify = realResults ∪ visualBaselineCases.results
   ```
   This keeps the executor untouched.

10. The synthesised `OccurrenceFull` for a baseline detection has `screenshotPath` pointing at a runDir-local copy of the screenshot. The discover-phase code copies the tmpfile to `paths.screenshotsDir/<occurrenceId>.png` before constructing the result. Other artifact paths (DOM, console, network, action-log) get empty-stub files written so the `OccurrenceFull` invariants hold (see `cluster.ts:upgradeToFull`). Reuse `persistUiArtifacts` if convenient; otherwise inline the stubs.

**Concurrency:** the per-page loop is **sequential** (one tab at a time; current camofox session holds a single browser context). The vision API call inside the loop is async; do not wait for one page's vision to finish before opening the next page's tab — that would serialise the work. Instead, open tab → screenshot → close tab synchronously, but enqueue the vision call to a promise pool with `vision.concurrency` slots (default 4). The discover phase awaits all pending vision calls before returning.

#### 4.3.2 Per-occurrence on missing_state_change (in execute phase)

Inside `executeUiTestInner`, after `bugs.push(...)` calls and the `missingChange` push:

```ts
if (missingChange && opts.visionEnabled && opts.budget?.tryConsume()) {
  const screenshotPath = path.join(opts.paths.screenshotsDir, `${occurrenceId}.png`);
  // The screenshot is already saved by persistUiArtifacts above.
  const visualDetections = await classifyVisualAnomalies({
    screenshotPath,
    url: tc.page,
    action: tc.action,
    role: tc.role,
    config: opts.visionConfig,
    budget: opts.budget,
  }).catch(err => {
    log.warn('vision: classification failed', { occurrenceId, err: String(err) });
    return [];
  });
  bugs.push(...visualDetections);
}
```

`opts.budget`, `opts.visionConfig`, `opts.visionEnabled` are added to `ExecuteOptions` and threaded through `runTest` → `executeUiTest` → `executeUiTestInner`. The screenshot is already on disk by the time the vision call fires (`persistUiArtifacts` is awaited before the vision check; reorder if needed).

This means a UI test with a `missing_state_change` may emit one `missing_state_change` detection AND zero-or-more `visual_anomaly` detections from the same screenshot. The classify phase's priority filter (`KIND_PRIORITY`) needs `visual_anomaly` slotted in (§ 4.6 — between `dom_error_text` and `missing_state_change`).

### 4.4 Vision budget controller

`packages/cli/src/classify/vision-budget.ts`:

```ts
export type VisionBudget = {
  /** Returns true if a call slot is available; consumes it if so. */
  tryConsume(): boolean;
  /** For tests / observability. */
  consumed: number;
  remaining: number;
  cap: number;
};

export function makeVisionBudget(maxCalls: number): VisionBudget {
  let consumed = 0;
  return {
    tryConsume() {
      if (consumed >= maxCalls) return false;
      consumed++;
      return true;
    },
    get consumed() { return consumed; },
    get remaining() { return maxCalls - consumed; },
    get cap() { return maxCalls; },
  };
}
```

Single-threaded counter. The Node event loop guarantees no race within a single process; the loop never yields between the `if` and the `++` (no await). Used by both per-page and per-occurrence paths.

`runCommand` constructs one budget instance and threads it through both phases. When the budget is exhausted, `log.info('vision: per-run budget exhausted')` exactly once (gate with a flag inside the controller) and subsequent calls return false.

### 4.5 SDK integration & API key resolution

`packages/cli/src/adapters/vision-client.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type VisionRequest = {
  imagePath: string;          // PNG on disk
  promptText: string;         // built by classify/vision.ts
  model: string;              // e.g. 'claude-haiku-4-5-20251001'
  timeoutMs: number;          // default 30000
};

export type VisionResponse = {
  rawText: string;            // model's text output (JSON expected, parsed by classifier)
  usage?: { inputTokens: number; outputTokens: number };
};

export class VisionApiError extends Error {
  constructor(public kind: 'auth' | 'timeout' | 'rate_limit' | 'transport' | 'malformed', message: string) {
    super(message);
  }
}

export class AnthropicVisionClient {
  constructor(private apiKey: string, private model: string, private timeoutMs: number) {}

  async classify(req: VisionRequest): Promise<VisionResponse> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const imageBytes = fs.readFileSync(req.imagePath);
    const imageB64 = imageBytes.toString('base64');
    const mediaType = path.extname(req.imagePath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const msg = await client.messages.create({
        model: req.model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
            { type: 'text', text: req.promptText },
          ],
        }],
      }, { signal: ctrl.signal });

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      return {
        rawText: text,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    } catch (err) {
      throw mapVisionError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapVisionError(err: unknown): VisionApiError { /* … see § 8 … */ }
```

**API key resolution** (in this priority order, computed once in `runCommand`):

1. `config.vision.apiKey` if provided in `.bughunter/config.json`. **Discouraged in committed config** — config.json is checked in.
2. `process.env.ANTHROPIC_API_KEY`.
3. `process.env.CLAUDE_API_KEY` (some tooling uses this).
4. None — if `vision.enabled === true` and no key is found: **fail loudly at runValidate** (`throw new Error('vision.enabled is true but no Anthropic API key was found. Set ANTHROPIC_API_KEY or vision.apiKey.')`). Do not silently downgrade to disabled — silent downgrade is the "noisy report" failure mode in reverse, and just as confusing.

**Model selection:** default `'claude-haiku-4-5-20251001'`. The user can override via `vision.model`. Document in the config schema that haiku is the cost-optimal choice; sonnet/opus are 6×/30× more expensive without proportional accuracy gains for "is this UI broken?" classification.

### 4.6 Classify-phase priority insertion

`packages/cli/src/phases/classify.ts:KIND_PRIORITY` becomes:

```ts
const KIND_PRIORITY: BugKind[] = [
  'unhandled_exception',
  'network_5xx',
  'react_error',
  'surface_call_failed',
  'network_4xx_unexpected',
  '404_for_linked_route',
  'dom_error_text',
  'visual_anomaly',         // NEW — between dom_error_text and missing_state_change
  'missing_state_change',
  'console_error',
  'accessibility_critical',
];
```

Rationale: a visual anomaly is a stronger signal than a missing_state_change (it confirms something visible is wrong) but a weaker signal than a `dom_error_text` (which is a literal "Error" in the page). When both fire on the same test, the visual_anomaly absorbs the missing_state_change as a secondaryObservation. Net result: the cluster report says "visual_anomaly: broken modal" instead of "missing_state_change: click did nothing," which is what the user wanted.

---

## 5. Prompt Template

Single multi-line prompt, built by `buildPrompt(req)` in `classify/vision.ts`. Inputs: `url`, `actionDescription`, `role`. The prompt is **identical** for the per-page and per-occurrence paths except for the `actionDescription` line (per-page uses `"the page rendered fresh on navigation; nothing has been clicked"`).

```text
You are a senior front-end engineer reviewing a SaaS web app screenshot for visual defects.

CONTEXT:
- URL: {{url}}
- User role: {{role}}
- Action just taken: {{actionDescription}}

TASK:
Identify visual anomalies that a typical user would consider a bug. Focus on these categories:
- layout: overlapping elements, content cut off by viewport, sidebar/header rendered on top of main content, broken grid alignment, modal rendered as a full-page block, text wrapping breaking the layout
- content: missing labels, raw template strings (e.g. {{ }} or ${var}), placeholder text in production positions, wrong copy clearly inconsistent with the surrounding UI
- state: blank container where data is expected (a list area showing no rows when seed data should exist), infinite spinner (loading indicator visible with no data after the action), wrong-state UI (logged-in nav on a public page, "Save" button while form still says "Editing")
- error: visible error banner, "500 Internal Server Error", "Something went wrong" text, broken-image icons, stack traces leaking into the UI
- a11y: text in unreadably-low contrast, focus indicator missing on a clearly focused element

DO NOT report any of these:
- Loading states (spinners) by themselves — only report a spinner if the whole content area is a spinner with no data after a typical wait
- Intentional empty states with a clear message ("No trades yet — add one to get started")
- Minor pixel misalignment (1-2 px)
- Stylistic preferences (font choice, spacing, color palette) unless contrast is unreadable
- Anything you are uncertain about

SEVERITY GUIDE:
- critical: the page is unusable for its purpose (whole content blank; layout is shattered; clear error overlay)
- major: a primary feature is visibly broken (one section empty/broken while the rest of the page works; visible error banner; raw template string in a header)
- minor: cosmetic only — DO NOT REPORT THESE; if everything you see is minor, return an empty array

Return STRICT JSON, no prose, no markdown fences:
{
  "anomalies": [
    {
      "severity": "critical" | "major",
      "category": "layout" | "content" | "state" | "error" | "a11y" | "other",
      "element": "<concrete element reference, e.g. 'the trade-list table on the right side'>",
      "description": "<what is wrong, one sentence>",
      "suggestedFix": "<optional, one short sentence; omit if not obvious>"
    }
  ]
}

If there are no anomalies meeting the major/critical bar, return: {"anomalies": []}

EXAMPLES:

Example 1 (broken layout):
{
  "anomalies": [{
    "severity": "critical",
    "category": "layout",
    "element": "the entire main content area",
    "description": "The sidebar is rendered on top of the main content; trades table is fully obscured.",
    "suggestedFix": "Check sidebar z-index and the parent flex container."
  }]
}

Example 2 (state bug):
{
  "anomalies": [{
    "severity": "major",
    "category": "state",
    "element": "the trades table",
    "description": "The trades list area is empty with no empty-state message; expected at least one row given the dashboard shows '12 trades this week'."
  }]
}

Example 3 (no anomalies):
{"anomalies": []}
```

**Prompt length budget:** ~600 input tokens of text + ~1200 input tokens for the base64 image (haiku tokenises images at ~1500/image at 1024px). Total ~1800 input tokens, ~250 output tokens. Per-call cost on haiku: ~$0.0006 input + ~$0.0003 output ≈ **$0.0009/call**. A 100-call run: ~$0.09. Well under any threshold.

**Prompt versioning:** the prompt text is exported as `VISION_PROMPT_TEMPLATE_V1` so future bumps don't accidentally rewrite history. Tests assert the v1 template exact-matches a fixture string (catches accidental edits).

---

## 6. Cluster Signature Design

`packages/cli/src/cluster/signature.ts`, add a branch:

```ts
case 'visual_anomaly': {
  const cat = detection.visualCategory ?? 'other';
  // Normalise the description so different pages with the same root layout bug cluster.
  const descNorm = normalizeVisualDescription(detection.rootCause);
  return `${detection.kind}|${cat}|${descNorm}`;
}
```

`normalizeVisualDescription(text: string): string`:

1. Lowercase.
2. Strip route paths (`/dashboard`, `/trades/123`) and bare numbers ≥ 4 digits (use existing `normalizeErrorMessage` helpers if reusable; this normaliser is intentionally distinct because routes inside descriptions are common and should be redacted).
3. Strip quoted strings (single, double, backtick).
4. Take the **first 8 words** (after stripping). 8 chosen empirically: long enough to disambiguate "broken sidebar" vs "broken modal" but short enough that "broken sidebar on dashboard" and "broken sidebar on trades" cluster together.
5. Trim and join with `-`.

Result: `visual_anomaly|layout|sidebar-rendered-on-top-of-main-content`. The same root cause appearing on 5 pages forms one cluster of size 5, not 5 singleton clusters.

**Edge case:** when the model returns wildly different descriptions for the same underlying bug (a known weakness of LLM classification consistency), the dedup may under-cluster. v0.4 accepts this; § 13 lists it as a risk, with future-work mitigation noted (deduplicate by clustering description embeddings).

`extractNormalizedFields` does **not** populate `errorMessageNormalized` or `stackTraceFingerprint` for visual; those fields remain undefined for visual clusters (consistent with how `network_5xx` doesn't populate them either). Cluster signature is the single source of truth for visual identity.

---

## 7. Cost Gates & Rate Limiting

| Gate | Default | Source |
| --- | --- | --- |
| Per-run max calls | 100 | `config.vision.maxCalls` |
| Concurrency | 4 | `config.vision.concurrency` |
| Per-call timeout | 30 s | `config.vision.timeoutMs` (not user-facing in v0.4; constant in classify/vision.ts) |
| Severity threshold | `'major'` | `config.vision.severityThreshold` |
| Detections per call cap | 5 | constant in classify/vision.ts; `MAX_DETECTIONS_PER_CALL` |
| Image max width | 1024 px | `MAX_IMAGE_WIDTH_PX`; downscale with `fs`-only pipeline if larger (see below) |
| Screenshot dedup | per-run set of SHA-256 hashes | implicit |

**Image downscaling:** camofox screenshots are typically 1280-1920 px wide and ~500 KB-1.2 MB on disk. Haiku accepts up to ~5 MB but bigger = slower and tokenizes more aggressively. Downscale to max 1024 px on the long side **only if the source is wider**. Use a tiny dependency-free PNG width inspector (parse IHDR; the IHDR chunk is at byte offset 16, width is the next 4 BE bytes) — if width > 1024, fall back to using `sharp` if installed OR skip downscale and pay the marginal cost. **Decision:** v0.4 ships **without** downscaling — measure the actual cost first; if it's under target, keep the simpler code path. The constant `MAX_IMAGE_WIDTH_PX = 1024` is recorded as future-work toggle. Document this in code comments. (This is a deliberate de-scope; see § 13 risk R-3.)

**Screenshot dedup:** before calling the API, hash the screenshot bytes (`crypto.createHash('sha256').update(buf).digest('hex')`). Store in a per-run `Set<string>`. If the hash is already present, skip the API call entirely. The set lives on the budget controller (or a sibling controller `VisionDedup`). Deduping covers the common case of "ten consecutive tests on the same page took identical screenshots" — saves both calls AND duplicate work in clustering.

**Rate-limit handling:** if Anthropic returns 429 (rate limit) — log warn, **do not retry**, drop the detection. The next test will try again; `tryConsume` already capped the run rate. This avoids exponential backoff thundering herds on transient rate limits.

---

## 8. Failure Modes

| Failure | Detection | Behaviour |
| --- | --- | --- |
| API auth fails (401) | `VisionApiError(kind='auth')` | log error; **abort vision for the rest of the run** — set a flag in the budget so further `tryConsume()` returns false; do NOT abort the run itself |
| API timeout (>30s) | `VisionApiError(kind='timeout')` | log warn `vision: timeout` with occurrenceId/route; emit an `InfrastructureFailure` (kind: `timeout`, detail: `vision call timeout`) on per-occurrence path; on per-page baseline path simply skip the page (no infra failure — the test wasn't real) |
| API rate-limit (429) | `VisionApiError(kind='rate_limit')` | log warn; skip detection; do not retry |
| Transport error (DNS, network) | `VisionApiError(kind='transport')` | log warn; skip detection |
| Malformed JSON in response | parser raises in classify/vision.ts | log warn `vision: malformed response` with first 200 chars of `rawText`; skip detection (do not synthesise a "model is broken" bug) |
| Model returns >5 anomalies | classifier truncates to first 5; logs `log.info('vision: response truncated', { kept: 5, dropped: N })` |
| Model returns severity: 'minor' | filtered by classifier per `severityThreshold`; not added |
| Image too large to read (rare; camofox crash) | `fs.readFileSync` throws | log warn; skip detection |
| `vision.enabled = true` but no API key | `runValidate` throws | run aborts with clear message |
| `@anthropic-ai/sdk` missing at runtime | dynamic import fails | log error and abort vision (set budget abort flag); run continues |

**Anthropic API down:** treat as rate-limit / transport. The run completes with whatever bugs were captured up to the point of failure; the `summary.json` should record the abort (TODO: wire `bugs.json` summary to include `vision: { enabled, called, succeeded, aborted: 'auth' | 'transport' | null }`). This summary surface is small (5 fields) and lives in `RunSummary`. Add `RunSummary.vision?: { ... }`.

**Prompt injection:** the screenshot can in principle contain attacker-controlled text (a malicious page that says "ignore previous instructions"). Mitigation: the system prompt is the *user* message and the image is part of the same message; haiku is well-aligned against treating image-text as instructions, but to harden:
- Cap per-call detections at 5.
- Cap per-detection description at 500 chars (truncate before storing).
- The `category` field is validated against the enum; out-of-enum → coerce to `'other'`.
- The `severity` field is validated against `{'minor','major','critical'}`; out-of-enum → drop the detection.
- The `element` and `description` fields are stored as-is in `BugDetection.rootCause` BUT no part of them is interpolated into shell or SQL; they only ever land in `bugs.jsonl` and the architect-orchestrator's text input. The orchestrator already treats bug text as untrusted.

---

## 9. Config Schema

### 9.1 TypeScript

In `packages/cli/src/types.ts`, after `BrowserLoginConfig`:

```ts
export type VisionSeverity = 'minor' | 'major' | 'critical';
export type VisionCategory = 'layout' | 'content' | 'state' | 'error' | 'a11y' | 'other';

export type VisionConfig = {
  /** Master switch. Default: false (opt-in). */
  enabled?: boolean;
  /** Anthropic model id. Default: 'claude-haiku-4-5-20251001'. */
  model?: string;
  /**
   * Anthropic API key. PREFERRED location is the ANTHROPIC_API_KEY env var.
   * Use this field only if env var is unavailable; do not commit the key.
   */
  apiKey?: string;
  /** Per-run cap on API calls. Default: 100. Hard ceiling; calls beyond skip. */
  maxCalls?: number;
  /** Concurrency cap for vision calls (independent of browser concurrency). Default: 4. */
  concurrency?: number;
  /**
   * Severity below this is filtered out and never becomes a BugDetection.
   * Default: 'major'. 'minor' is intentionally not exposed as a default —
   * minor anomalies are noisy by construction. 'critical' is for ultra-strict runs.
   */
  severityThreshold?: VisionSeverity;
};
```

Extend `BugHunterConfig`:

```ts
export type BugHunterConfig = {
  // … existing fields …
  vision?: VisionConfig;
};
```

Extend `BugKind`:

```ts
export type BugKind =
  | 'console_error'
  | 'react_error'
  | 'network_5xx'
  | 'network_4xx_unexpected'
  | '404_for_linked_route'
  | 'missing_state_change'
  | 'unhandled_exception'
  | 'accessibility_critical'
  | 'dom_error_text'
  | 'surface_call_failed'
  | 'visual_anomaly';        // NEW
```

Extend `BugDetection`:

```ts
export type BugDetection = {
  kind: BugKind;
  rootCause: string;
  // … existing fields …
  // visual_anomaly only:
  visualCategory?: VisionCategory;
  visualSeverity?: VisionSeverity;
  visualSuggestedFix?: string;
  /** Path to the screenshot that produced this detection. Always set when kind === 'visual_anomaly'. */
  screenshotPath?: string;
};
```

### 9.2 Zod (config.ts)

Add to `ConfigSchema`:

```ts
vision: z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  maxCalls: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  severityThreshold: z.enum(['minor', 'major', 'critical']).optional(),
}).optional(),
```

`resolvedConfig` does **not** add a default `vision` block (consistent with the `crawl` and `browserLogin` patterns — those leave defaults to the consuming code). Defaults are applied inside `classify/vision.ts` via `pickVisionConfig`:

```ts
export function resolveVisionConfig(c: VisionConfig | undefined, apiKey: string): Required<VisionConfig> & { apiKey: string } {
  return {
    enabled: c?.enabled ?? false,
    model: c?.model ?? 'claude-haiku-4-5-20251001',
    apiKey,
    maxCalls: c?.maxCalls ?? 100,
    concurrency: c?.concurrency ?? 4,
    severityThreshold: c?.severityThreshold ?? 'major',
  };
}
```

---

## 10. Test Plan

### 10.1 Unit tests — `packages/cli/tests/classify-vision.test.ts`

All tests mock `AnthropicVisionClient` via constructor injection (do NOT mock the SDK itself). The classifier accepts a `VisionClient` interface; the test passes a stub that returns canned `VisionResponse` objects.

| # | Case | Expected |
| --- | --- | --- |
| 1 | Mock returns `{anomalies: [{severity:'critical',category:'layout',description:'broken sidebar'}]}` | One `BugDetection` with `kind='visual_anomaly'`, `visualCategory='layout'`, `visualSeverity='critical'`, `rootCause` includes the description |
| 2 | Mock returns `{anomalies: []}` | Empty array |
| 3 | Mock returns malformed JSON (trailing prose) | Empty array; one `log.warn` call (assert via spy on `log`) |
| 4 | Mock returns valid JSON wrapped in markdown fences | Strips fences, parses; matches case 1 |
| 5 | Mock throws `VisionApiError(kind='timeout')` | Empty array; `log.warn` called |
| 6 | Mock returns 8 anomalies | Result has exactly 5 entries; `log.info('vision: response truncated', { kept: 5, dropped: 3 })` |
| 7 | Mock returns one `severity:'minor'` and one `severity:'major'`; threshold default | Result has only the `major` |
| 8 | Mock returns one `severity:'critical'`; threshold = `'critical'` | Result has the critical |
| 9 | Mock returns invalid `severity: 'showstopper'` | That detection is dropped; others kept |
| 10 | Mock returns invalid `category: 'foo'` | Detection kept with `visualCategory='other'` |
| 11 | Description > 500 chars | Truncated to 500 in `rootCause` |
| 12 | `screenshotPath` populated correctly in returned detection | Asserted exact path |

### 10.2 Unit tests — `packages/cli/tests/vision-budget.test.ts`

| # | Case | Expected |
| --- | --- | --- |
| 1 | `tryConsume` returns true for the first `cap` calls | `consumed === cap` after `cap` calls |
| 2 | `tryConsume` returns false on call `cap+1` | `consumed === cap`; `remaining === 0` |
| 3 | Budget abort flag (set via `markAborted('auth')`) makes all subsequent `tryConsume` return false | Asserted |
| 4 | "Budget exhausted" log emitted exactly once | Spy on log.info; assert call count = 1 across N calls past cap |

### 10.3 Unit tests — extend `packages/cli/tests/cluster.test.ts`

| # | Case | Expected |
| --- | --- | --- |
| 1 | `clusterSignature` for two visual detections with same category and same first-8-words | Equal signature |
| 2 | `clusterSignature` for visual with route in description (`/dashboard` vs `/trades`) | Equal signature (route stripped) |
| 3 | `clusterSignature` for visual with same description but different category | Distinct signatures |
| 4 | `runCluster` clusters 5 visual detections from 5 pages with same root cause into one cluster of size 5 | Asserted |
| 5 | `generateFixHints` for visual detection includes description, screenshot path, suggestedFix when present | Asserted |

### 10.4 Unit tests — extend `packages/cli/tests/classify-priority.test.ts`

| # | Case | Expected |
| --- | --- | --- |
| 1 | `visual_anomaly` + `missing_state_change` on same test → canonical is `visual_anomaly`, secondary contains missing_state_change | Asserted |
| 2 | `dom_error_text` + `visual_anomaly` → canonical is `dom_error_text`, secondary contains visual_anomaly | Asserted |
| 3 | `react_error` + `visual_anomaly` → canonical is `react_error`, secondary contains visual_anomaly | Asserted |

### 10.5 Integration test — `packages/cli/tests/vision-integration.test.ts`

Two static fixture screenshots committed to the repo under `fixtures/vision-broken-page/`:

- `broken-layout.png` — synthesised programmatically (HTML page with `position:absolute` overlap rendered to PNG via headless camofox in a `pretest` step) OR checked-in static PNG.
- `clean-page.png` — HTML page rendering normally; checked-in PNG.

The integration test runs `classifyVisualAnomalies` against each fixture using a **stubbed `VisionClient`** (we do not call the real API in CI). The stub maps screenshot SHA-256 → canned response, so the test covers the orchestration end-to-end (file read, hash, prompt build, response parse, severity filter, detection cap) without spending money or requiring network.

Live integration test (manual, not CI):
- Run `bughunter run` with `vision.enabled: true` against TraiderJo with a real ANTHROPIC_API_KEY in env.
- Expected: non-zero `visual_anomaly` clusters in `bugs.jsonl`. Acceptable: zero clusters (TraiderJo turns out to be visually pristine), but in that case the user has a positive signal that vision is a no-op rather than the silent-zero of today.

### 10.6 Test commands

- `npm test -w packages/cli` — runs all vitest unit + integration tests; must pass.
- `npm run typecheck` — must pass; `BugKind` extension and `BugDetection` extension must not break existing tests.
- `npm run lint` — must pass with zero warnings.

---

## 11. Acceptance Criteria

- A1. **Default-off, backward-compat**: with no `vision` block in `.bughunter/config.json`, `bughunter run` produces byte-identical output to the pre-spec implementation. Verified by re-running the existing TraiderJo smoke test on this branch and comparing `bugs.jsonl` and `summary.json` to the pre-merge baseline. Allowed delta: timestamps, run ids, occurrence ids.
- A2. **Opt-in works**: with `{"vision": {"enabled": true}}` in config and `ANTHROPIC_API_KEY` set, `bughunter run` against a fixture page with a known visual bug emits at least one `visual_anomaly` cluster in `bugs.jsonl`.
- A3. **Missing API key fails fast**: with `vision.enabled: true` and no key resolvable, `bughunter run` exits with a clear error referencing `ANTHROPIC_API_KEY`. Tested via `runValidate` integration test.
- A4. **Budget cap honoured**: with `maxCalls: 5` and a fixture set producing >5 vision-eligible occurrences, exactly 5 API calls are made (verified via stub call count).
- A5. **Severity threshold honoured**: with `severityThreshold: 'critical'`, mock responses returning `'major'` produce zero detections.
- A6. **Cluster signature dedups across pages**: 3 pages all triggering "broken sidebar" produce one cluster of size 3.
- A7. **Priority filter slots correctly**: a test result with both `missing_state_change` and `visual_anomaly` produces one bug of kind `visual_anomaly` with `missing_state_change` in `secondaryObservations`.
- A8. **Failure tolerance**: API timeout / transport error / malformed JSON each result in zero new `visual_anomaly` detections, a single `log.warn`, and the run continues. Verified by 3 separate unit tests.
- A9. **TraiderJo bring-up**: after merging, a manual `bughunter run` against TraiderJo with `vision.enabled: true` is documented in a follow-up comment with: number of clusters, sample fixHints from one cluster, total spend (from Anthropic dashboard or response usage), runtime delta vs vision-off run.
- A10. **Type integrity**: `BugKind` is exhaustively switched everywhere it's switched today (signature.ts, classify.ts, cluster.ts) without `as any` or `default:` escape hatches.
- A11. **Lint and typecheck**: `npm run typecheck && npm run lint` pass cleanly.
- A12. **Test suite green**: all existing tests still pass; new tests pass.

---

## 12. Files to Touch

### 12.1 Files to create

- `packages/cli/src/classify/vision.ts` — classifier + prompt template + response parser. ~250 lines max.
- `packages/cli/src/classify/vision-budget.ts` — budget controller. ~50 lines.
- `packages/cli/src/adapters/vision-client.ts` — Anthropic SDK wrapper. ~120 lines.
- `packages/cli/tests/classify-vision.test.ts` — unit tests (10.1).
- `packages/cli/tests/vision-budget.test.ts` — unit tests (10.2).
- `packages/cli/tests/vision-integration.test.ts` — orchestration test (10.5) using stub client.
- `fixtures/vision-broken-page/broken-layout.png` — fixture screenshot.
- `fixtures/vision-broken-page/clean-page.png` — fixture screenshot.
- `fixtures/vision-broken-page/README.md` — describes fixture origin and how to regenerate.

### 12.2 Files to modify

- `packages/cli/src/types.ts` — add `'visual_anomaly'` to `BugKind`; add `VisionConfig`, `VisionSeverity`, `VisionCategory`; extend `BugDetection` with visual fields; extend `BugHunterConfig`.
- `packages/cli/src/config.ts` — extend `ConfigSchema` with `vision` block.
- `packages/cli/src/cluster/signature.ts` — add `case 'visual_anomaly':` branch + `normalizeVisualDescription` helper.
- `packages/cli/src/phases/cluster.ts` — extend `generateFixHints` switch.
- `packages/cli/src/phases/classify.ts` — insert `'visual_anomaly'` in `KIND_PRIORITY`.
- `packages/cli/src/phases/discover.ts` — append per-page baseline pass after the existing loop; return `visualBaselineDetections` from `runDiscover` (typed addition to `DiscoveryOutput`).
- `packages/cli/src/types.ts` — extend `DiscoveryOutput` with optional `visualBaselineDetections?: VisualBaselineEntry[]`. Type defined alongside.
- `packages/cli/src/phases/execute.ts` — extend `ExecuteOptions` with `visionEnabled`, `visionConfig`, `visionClient`, `budget`; insert per-occurrence vision call inside `executeUiTestInner` after `missingChange` push and after `persistUiArtifacts`.
- `packages/cli/src/cli/run.ts` — construct `VisionBudget` and `AnthropicVisionClient`; resolve API key; thread through to discover and execute; synthesise visual-baseline test cases + results; merge into final `runCluster` inputs; populate `RunSummary.vision`.
- `packages/cli/src/types.ts` — extend `RunSummary` with `vision?: { enabled, called, succeeded, anomaliesFound, abortReason? }`.
- `packages/cli/src/phases/emit.ts` — populate `RunSummary.vision` if vision was enabled.
- `packages/cli/package.json` — add `@anthropic-ai/sdk` to `dependencies`. Pinned to `0.32.x` (latest stable as of Jan 2026; coder verifies on implementation).
- `packages/cli/src/cli/init.ts` — DO NOT add interactive vision prompts in v0.4. The user opts in by editing `.bughunter/config.json` directly. (Deliberately minimal init surface.)
- `packages/cli/tests/cluster.test.ts` — extend with visual cluster tests (10.3).
- `packages/cli/tests/classify-priority.test.ts` — extend with visual priority tests (10.4).
- `SPEC.md` (project root) — append a brief paragraph in the relevant detection-coverage section linking to this spec. Coder uses light touch; no rewrites.

### 12.3 Files NOT to touch

- `packages/mcp/**` — vision is CLI-only; SurfaceMCP and the camofox adapter are unaffected.
- Existing fixture under `fixtures/vite-crawl-app/` — do not introduce vision-related content there.
- `packages/cli/src/discovery/**` (other than discover.ts wiring) — vision is post-discovery, not a discovery source.
- `packages/cli/src/repro/**` — replay/repro untouched; visual detections inherit existing repro semantics.
- `packages/cli/src/store/run-state.ts` — RunState shape already accommodates additions through nested fields; no schema migration needed.

---

## 13. Risks

- **R-1. False positive rate.** This is the single failure mode that kills the feature. Mitigations: severity threshold defaults to `'major'`; per-call detection cap; explicit "DO NOT report these" list in prompt; few-shot examples; per-run budget cap so even a fully-broken model can't spam. Open mitigation for future: a small calibration suite (5-10 known-clean and known-broken fixture screenshots) auto-run on every prompt change to flag drift.
- **R-2. API cost runaway.** Mitigation: hard `maxCalls` cap in budget controller, screenshot-hash dedup, default-disabled. Worst case at default cap × haiku price × 2 enabled paths: ~$0.10/run. Even pathological runs cap at $1.
- **R-3. Image size growth.** Mitigation: v0.4 ships without downscaling but documents `MAX_IMAGE_WIDTH_PX = 1024` as a future toggle. If observed costs exceed estimates after 5 real runs, file follow-up issue and add downscale.
- **R-4. Model bias / inconsistency.** Same root-cause bug producing different descriptions on different pages → under-clustering. Mitigation: 8-word description fingerprint clusters most cases; future work uses embeddings. Severity: low — under-clustering produces extra clusters, not extra noise.
- **R-5. Prompt injection.** A page rendering "ignore previous instructions" might fool the model. Mitigation: structured JSON schema validation; severity/category enum coercion; truncation. Severity: low — even if injected, output is bounded at 5 detections × 500 chars, all destined for human review.
- **R-6. SDK version drift.** Anthropic SDK adds breaking changes. Mitigation: pin to a specific minor (`0.32.x`). Coder bumps in a followup PR.
- **R-7. Per-page baseline tab leakage.** If `closeTab` fails after `openTab`, tabs accumulate. Mitigation: use `try/finally` around the open/close pair; the existing `closeAllExistingTabs` in `runCommand` guards startup.
- **R-8. Resume semantics.** A run resumed mid-discover would need to skip already-processed pages. Mitigation: visual baseline runs at the END of discover (after all pages are walked), and the discover-phase output (`DiscoveryOutput`) already snapshots into `runState.discovery` after the call. On resume from `plan` or later, the saved `visualBaselineDetections` are reused. Resume from inside discover restarts vision from scratch, which is acceptable (the budget controller is per-process, but the `maxCalls` cap is checked against fresh state — minor over-budget on resume is documented as accepted).
- **R-9. Discord-bridge / OpenClaw session credentials are not a programmatic API key.** The user confirmed: enabling vision requires a programmatic `ANTHROPIC_API_KEY`. Spec calls this out in § 4.5 and acceptance A3.

---

## 14. Open Questions

- **O-1. Multi-provider abstraction.** Is the team comfortable being Anthropic-only at the integration layer? The current spec hard-couples to `@anthropic-ai/sdk`. A provider interface would cost ~50 lines and unlock OpenAI / Gemini fallback. **Recommendation:** ship single-provider in v0.4; abstract in v0.5 only if a second provider is actually needed. (No action item for coder.)
- **O-2. Should the per-occurrence vision pass also fire on `dom_error_text`?** A `dom_error_text` says "the DOM contains visible 'Error' text" — vision could disambiguate "real error" from "the word 'error' in flavor copy." Tradeoff: ~10× the per-occurrence calls. **Recommendation:** ship without; revisit after the first TraiderJo run produces signal.

---

## 15. Implementation Order (suggested)

1. Type extensions (`types.ts`, `config.ts` Zod). Compile-only; no behaviour change.
2. `vision-budget.ts` + tests.
3. `vision-client.ts` (with stubbable `VisionClient` interface) + tests.
4. `classify/vision.ts` + tests (10.1).
5. Cluster signature branch + fix-hint branch + extending cluster tests (10.3).
6. Classify priority insertion + extending priority tests (10.4).
7. Wire into `executeUiTestInner` (per-occurrence path); integration test scaffolding.
8. Wire into `runDiscover` (per-page baseline path).
9. Wire `runCommand` orchestration — synthesise baseline cases/results, populate RunSummary, fail-fast on missing key.
10. Integration test (10.5) end-to-end with stub client.
11. Manual TraiderJo smoke (acceptance A9). Document in PR description.

Each step is independently committable. Steps 1-6 are pure additions and break nothing. Steps 7-9 are the wiring — the vision flag must remain default-off through this whole sequence; only flip the smoke test on at step 11.

---

## Addendum — v0.13: singleton-tab auth survival in Phase-1 (2026-04-28)

**See `SPEC_V13_VISION_BASELINE_AUTH.md` for the full implementation contract.**

v0.13 changed Phase-1 (the per-route screenshot loop inside `runVisualBaseline`) from opening a fresh tab per route via `browser.withTab(url, ...)` to navigating the **singleton tab** that is already authenticated from the login step. The classifier contract (`classifyVisualAnomalies` signature, prompt template, severity gating, dedup) is **unchanged**.

Root cause that motivated the change: on a 32-route auth-walled SPA, fresh tabs opened in the Vite dev-server cold-start window failed to hydrate the Zustand `persist` middleware in time. The `AuthGate` read `token === null` and redirected every tab to `/login`. All 32 screenshots hashed identically → 1 unique vision call instead of 32.

The singleton-tab design (Design C in the spec) eliminates the cold-start race entirely: the tab is already authenticated, the bundle is already warm, and `navigate(url)` navigates within the existing session. Auth state survives by definition because the `BrowserContext` (and its `localStorage`) is shared across the entire BugHunter process lifetime.

**What changed in `phases/discover.ts`:**
- Phase-1 now uses `browser.navigate(url)` + `browser.screenshot(path)` on the singleton tab. `browser.withTab(...)` is no longer called inside `runVisualBaseline`.
- A one-time auth-health probe (`probeAuthHealth`) runs before the loop to detect degraded session state early.
- A per-iteration post-navigate URL check (EC-1) detects mid-loop auth loss and aborts the vision pass cleanly.
- New config field `vision.preScreenshotSettleMs` (default 2500 ms) controls the settle delay before each screenshot. The previous hard-coded `VISION_BASELINE_SETTLE_MS` (1500 ms) remains as the floor.
- New telemetry: `discovery.visionBaselineTelemetry.{uniqueScreenshots, dedupedScreenshots, authLostMidLoop, screenshotsTooSmall}` in `state.json`.

**`withTab` is unchanged** — it is still used by `phases/execute.ts` and `cli/replay.ts` where tab isolation between tests is the desired property.
