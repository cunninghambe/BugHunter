# SPEC — v0.17 "Multi-viewport responsive pass"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-29 · **Predecessor:** v0.13 vision-baseline auth survival, v0.15 vision N-of-M consistency · **Sibling:** v0.14 seed-data hooks (data quality) and v0.15 (output quality).

This spec adds a **multi-viewport vision pass** that screenshots each unique authenticated route at three viewport widths (375 / 768 / 1280 px) using the same singleton tab established in v0.13. Every responsive bug class (mobile menu clipped, table horizontal-scroll missing, modal full-page-on-phone, fixed-width header overflowing, sidebar collapse failing, touch-target-too-small at mobile) is invisible to a single 1280px capture. With the singleton tab + v0.15 consistency aggregator already in place, adding a viewport-loop is mechanical. Cost: 3× vision budget (still well under the default $20 cap on a typical SaaS app).

---

## 1. Objective

Add a `viewports` config knob to `VisionConfig` (default `[375, 768, 1280]`) that resizes the singleton baseline tab between captures, hashes each capture, and feeds the unique screenshots through the existing `classifyVisualAnomaliesConsistent` pipeline. Findings are tagged with the viewport they were captured at via a new `viewportPx` field on `BugDetection.visualContext`. Per-viewport telemetry is emitted on `summary.json.vision.byViewport`.

**In scope:**
- `VisionConfig.viewports: number[]` (default `[375, 768, 1280]`, max 6 widths)
- For each viewport in order: resize the singleton tab → settle (existing `preScreenshotSettleMs`) → screenshot → hash-dedup (existing) → classify
- New `BugDetection.visualContext.viewportPx?: number` field
- `cluster/signature.ts` includes `viewportPx` in the cluster key for `visual_anomaly` so the same bug at desktop and mobile clusters separately (they're often genuinely different bugs)
- Telemetry: `vision.byViewport: Record<number, { uniqueScreenshots: number; anomaliesFound: number }>`
- Cost: ~3× vision budget. Default `maxCalls` bumped from 100 → 200; default `costCapUsd` unchanged at $20 (Sonnet at $0.005/call gives 4000+ calls of headroom).

**Out of scope (deferred):**
- Mobile-specific BugKinds (touch-target-too-small, viewport-meta-missing, etc.) — v0.18. v0.17 reuses `visual_anomaly` and lets Sonnet's prose judgment carry the mobile signals.
- Device-pixel-ratio simulation — v0.18.
- Touch-event simulation (tap/swipe/pinch) — v0.19.
- Network-throttling / 3G simulation — v0.6 has the CDP plumbing; activation deferred to v0.19.
- Per-viewport a11y / SEO passes — both already run once per page; no win from re-running.
- Per-viewport perf metrics (LCP varies by viewport) — v0.18 if telemetry justifies it.

**Acceptance target on Aspectv3:**
With `viewports: [375, 768, 1280]`, the smoke run produces:
- Vision unique-screenshot count ≥ 2× the single-viewport baseline (most pages produce different DOM at 375 vs 1280; some content-only pages dedup across viewports — that's correct behavior).
- At least 1 `visual_anomaly` finding tagged `viewportPx: 375` that does NOT appear at `viewportPx: 1280`. SaaS apps almost universally have ≥1 mobile-only bug.
- Total vision cost ≤ $1.00.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `VisionConfig`. Add `viewports?: number[]`. Add `BugDetection.visualContext.viewportPx?: number`. |
| `packages/cli/src/config.ts` | Zod schema for `vision`. Add `viewports: z.array(z.number().int().min(320).max(2560)).max(6).default([375, 768, 1280])`. |
| `packages/cli/src/classify/vision.ts` | `resolveVisionConfig` returns `viewports: number[]`. The classifier itself is unchanged — only the loop in `discover.ts` uses the viewport list. |
| `packages/cli/src/phases/discover.ts` | `runVisualBaseline` (line ~232) and the singleton-tab loop (Phase 1, line ~424 area). **This is where the viewport loop wraps**. For each page in the existing loop, iterate viewports, resize, capture, hash-dedup, then push to the classify pool. |
| `packages/cli/src/adapters/browser-mcp.ts` | The browser adapter. `setViewport(width, height)` already exists per camofox-mcp's `set_viewport` tool. **Verify** this before assuming. If missing, add a `BrowserMcpAdapter.setViewport(width: number, height: number): Promise<void>` that calls `browser_set_viewport` (camofox-mcp tool name TBD — check `/root/camofox-mcp/src/core/tools.ts`). |
| `packages/cli/src/cluster/signature.ts` | `visual_anomaly` cluster signature. Append `|<viewportPx>` so per-viewport findings cluster separately. |
| `packages/cli/src/phases/emit.ts` | Add `byViewport` aggregation to the vision telemetry block. |

### 2.2 Patterns to follow

- **Singleton tab is preserved.** Resize between captures via `setViewport`; do NOT close + reopen tabs. Auth state (v0.13's whole point) must survive the viewport change.
- **Hash dedup applies per-viewport bucket.** A 375-wide screenshot of route A and a 1280-wide screenshot of route A hash differently → both classified. Two 375-wide screenshots that hash identical (e.g., both routes redirect to login) → one classified. The existing `tryConsumeHash` works as-is; no changes needed.
- **Settle delay applies per resize.** Reuse `preScreenshotSettleMs` (default 2500ms — see v0.13). SPAs often re-render on viewport change (responsive grid breakpoints, sidebar collapse).
- **Order matters.** Iterate viewports smallest-to-largest. Resizing to mobile first triggers responsive logic; resizing back to desktop is a benign restoration. Reverse order can leave the page in a "stuck-mobile" state if a CSS rule depends on `prefers-reduced-motion` or similar.
- **Discriminated-union returns** for the resize helper: `{ ok: true } | { ok: false; reason: string }`.

### 2.3 DO NOT

- Do **not** open a new tab per viewport. The whole point of v0.13 was to keep auth state in one tab.
- Do **not** parallelize viewports for the same route. Camofox/Playwright's viewport setter is a per-context mutation; concurrent setters race.
- Do **not** add a new BugKind — `visual_anomaly` carries the viewport via `visualContext.viewportPx`.
- Do **not** change `clusterSignature` for any kind other than `visual_anomaly`.
- Do **not** screenshot at viewports outside the configured list (no "exhaustive search" mode).
- Do **not** carry per-viewport state across pages. Reset to the first viewport (375) at the start of each page so the captured DOM is mobile-first.

---

## 3. Configuration shape

Add to `VisionConfig` in `types.ts`:

```ts
export type VisionConfig = {
  // ... existing fields ...

  /**
   * Viewport widths (px) at which to capture each unique route.
   * Default: [375, 768, 1280] (iPhone, tablet, desktop).
   * Max 6 entries; values must be in [320, 2560].
   * Pass [1280] to disable multi-viewport (single-desktop pass).
   */
  viewports?: number[];
};
```

Heights are derived deterministically: `height = Math.round(width * 0.65)` to approximate typical aspect ratios (`375×244` ≈ phone portrait, `768×499` ≈ tablet, `1280×832` ≈ laptop). Never user-configurable; document the formula in code comments.

### 3.1 Zod additions in `config.ts`

```ts
viewports: z.array(z.number().int().min(320).max(2560)).max(6).default([375, 768, 1280]),
```

### 3.2 BugDetection field extension

Add to `visualContext` (existing v0.4 field — extend, don't duplicate):

```ts
visualContext?: {
  // ... existing ...
  viewportPx?: number;   // 375 | 768 | 1280 | etc. — populated for v0.17 multi-viewport findings
};
```

If `visualContext` doesn't exist (check current types.ts post-v0.15), add it with a single `viewportPx` field. Future v0.18+ extensions land on the same object.

---

## 4. Module surface

### 4.1 BrowserMcpAdapter additions

Verify `setViewport(width: number, height: number)` exists. If not, add to the interface AND implementation:

```ts
export interface BrowserMcpAdapter {
  // ... existing ...
  setViewport(width: number, height: number): Promise<void>;
}
```

Implementation calls camofox-mcp's `set_viewport` tool (or whatever it's called — verify by reading `/root/camofox-mcp/src/core/tools.ts`). If camofox doesn't expose viewport setting, fall back to `evaluate(\`window.resizeTo(\${width}, \${height})\`)` and warn that real-DPI simulation requires camofox upgrade. Document the fallback's limitation.

### 4.2 Discover-phase wiring

`runVisualBaseline` in `phases/discover.ts`. Today's loop (post-v0.13):

```ts
for (const page of pages) {
  await navigateForScreenshot(page, ...);
  const screenshot = await scope.screenshot(...);
  if (visionBudget.tryConsumeHash(hash)) { ... screenshotEntries.push(...) }
}
```

v0.17 wraps:

```ts
const viewports = visionConfig.viewports ?? [375, 768, 1280];
for (const page of pages) {
  await navigateForScreenshot(page, ...);
  for (const viewportPx of [...viewports].sort((a, b) => a - b)) {
    const heightPx = Math.round(viewportPx * 0.65);
    await browser.setViewport(viewportPx, heightPx);
    await new Promise(r => setTimeout(r, settleMs));
    const screenshot = await scope.screenshot(...);
    const hash = sha256(screenshot);
    if (!visionBudget.tryConsumeHash(hash)) continue;
    if (!visionBudget.tryConsume()) break;  // budget exhausted
    screenshotEntries.push({ page, screenshotPath, viewportPx });
  }
  // Restore to default desktop viewport so subsequent navigation is desktop-first
  await browser.setViewport(1280, 832);
}
```

Pass `viewportPx` through to `classifyVisualAnomaliesConsistent` so the resulting `BugDetection.visualContext.viewportPx` is populated.

### 4.3 Cluster signature extension

`cluster/signature.ts`:

```ts
case 'visual_anomaly': {
  const cat = detection.visualCategory ?? 'other';
  const descNorm = normalizeVisualDescription(detection.rootCause);
  const vp = detection.visualContext?.viewportPx ?? 'unknown';
  return `${detection.kind}|${cat}|${vp}|${descNorm}`;
}
```

This means a "table clipped" bug at 375 and 1280 produce **two clusters** even if Sonnet describes them identically. Intentional — mobile and desktop layout-clip bugs typically have different root causes (mobile is responsive-CSS oversight; desktop is fixed-width-overflow).

### 4.4 Telemetry

```ts
vision: {
  // ... existing ...
  byViewport?: Record<number, {
    uniqueScreenshots: number;
    anomaliesFound: number;
    deduped: number;
  }>;
};
```

Per-viewport breakdown lets operators see "the 375px pass found 8 bugs, the 1280px pass found 1 bug" — that's a clear product signal.

---

## 5. Edge cases

### EC-1. SPA doesn't respond to viewport change (uses `useEffect(() => onResize)` etc.)
Some SPAs cache layout on first render and don't re-measure on programmatic resize. Mitigation: dispatch `window.dispatchEvent(new Event('resize'))` after `setViewport` to nudge the SPA. Add to the helper.

### EC-2. Camofox doesn't expose viewport tool
Per §4.1, fall back to `evaluate(window.resizeTo(...))`. Real DPI simulation (mobile vs desktop pixel-ratio) would need a true device emulation. Document; v0.18 considers a camofox-mcp upgrade.

### EC-3. Page renders identically at all three viewports (e.g., a centered login form)
Hash dedup catches all but one. Vision called once. Telemetry shows 1 unique, 2 deduped at each viewport beyond the first. This is correct behavior; document so operators don't think it's broken.

### EC-4. State pages (page.kind === 'state')
The trigger-click happens at viewport[0] (375). Subsequent viewport-resizes within the same page work because the state-trigger click already fired. No re-click needed.

### EC-5. Viewport change triggers data refetch (e.g., `useMediaQuery`-gated useQuery)
Settle delay accounts for this (default 2500ms). If the page consistently fails to settle within 2500ms at a particular viewport, log a warning AND still capture the screenshot. Sonnet's prompt already says "do not flag loading spinners," so a partially-loaded screenshot won't false-positive.

### EC-6. Budget exhausts mid-page (e.g., 2-of-3 viewports captured)
Aggregate over what we got. Telemetry's `byViewport` only contains entries for captured viewports. Do not retry on next page.

### EC-7. Auth-survival probe fails after a viewport change
The auth-health probe (v0.13) runs ONCE before the viewport loop. If a viewport change somehow logs out the user (extremely unlikely), the next page's `navigateForScreenshot` will see a redirect to login and emit `auth_lost_mid_loop`. v0.13 handles this; no changes needed.

### EC-8. User passes `viewports: [1280]`
Single-viewport mode. `byViewport: { 1280: {...} }`. Effectively the v0.13 baseline behavior. Document this as the way to disable v0.17 without removing the config block.

### EC-9. Two viewports differ by < 10% (e.g., `[768, 800]`)
Hash dedup likely catches that — settle is the same, content is the same. If user really wants it, the budget check kicks in. No special handling.

### EC-10. Setviewport throws mid-loop
Catch + log + skip the remaining viewports for that page. Move to next page. Do not abort the run.

---

## 6. Test plan

### 6.1 Unit tests

- `getViewportHeight(width)` returns `Math.round(width * 0.65)` for representative widths.
- `runVisualBaselineMultiViewport` with mocked browser:
  - 3 viewports × 2 pages = 6 captures, all unique hashes → 6 classify calls
  - 3 viewports × 2 pages, all same hash (login-redirect) → 1 classify call
  - 3 viewports × 2 pages, budget = 4 → 4 classify calls, byViewport telemetry shows partial
- Cluster signature with `viewportPx` produces distinct keys for same-description findings at different viewports.
- `setViewport` fallback: when camofox tool not available, use `evaluate(window.resizeTo(...))` and dispatch resize event.

### 6.2 Integration smoke (manual on Aspectv3)

```bash
# Update .bughunter/config.json
"vision": {
  "enabled": true,
  "model": "claude-sonnet-4-6",
  "consistencyRuns": 2,
  "agreementMode": "strict",
  "viewports": [375, 768, 1280],
  "maxCalls": 200,
  "costCapUsd": 5.0
}

# Run smoke
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local \
  ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run \
    --max-bugs 150 --budget 2400000 --a11y --a11y-strict --seo
```

Acceptance:
- `summary.json.vision.byViewport` has all 3 viewport keys populated.
- ≥1 `visual_anomaly` finding has `visualContext.viewportPx: 375` AND no equivalent at 1280.
- Total `vision.costUsd` ≤ $1.00.
- Same regression criterion as v0.13: 65 cluster baseline preserved (no test-surface regression from the viewport loop).

---

## 7. Negative requirements

- Do **not** add new BugKinds.
- Do **not** open new tabs per viewport.
- Do **not** parallelize viewports.
- Do **not** override the per-viewport hash dedup.
- Do **not** add device-pixel-ratio or touch simulation.
- Do **not** change cluster signatures for anything except `visual_anomaly`.
- Do **not** require a camofox-mcp upgrade — fallback to `evaluate(resizeTo)` is mandatory.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add `viewports` to `VisionConfig` types + Zod | `types.ts`, `config.ts` | none |
| 2 | Add `viewportPx?: number` to `BugDetection.visualContext` | `types.ts` | 1 |
| 3 | Verify camofox-mcp viewport tool exists; add `BrowserMcpAdapter.setViewport` (with `evaluate(resizeTo)` fallback) | `adapters/browser-mcp.ts`, `adapters/camofox-mcp-client.ts` | 1 |
| 4 | Wrap `runVisualBaseline`'s screenshot loop with the viewport iterator | `phases/discover.ts` | 3 |
| 5 | Thread `viewportPx` through `classifyVisualAnomaliesConsistent` so it lands on `BugDetection.visualContext.viewportPx` | `classify/vision.ts`, `phases/discover.ts` | 4 |
| 6 | Extend `visual_anomaly` cluster signature with `viewportPx` | `cluster/signature.ts` | 2 |
| 7 | Add `vision.byViewport` aggregation to summary | `phases/emit.ts`, `types.ts` | 5 |
| 8 | Unit tests (per §6.1) | `phases/discover.test.ts`, `cluster/signature.test.ts` | 4-7 |
| 9 | Manual smoke against Aspectv3 verifying ≥1 mobile-only finding | (manual) | 4-7 |

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All unit tests pass | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Aspectv3 smoke produces `summary.json.vision.byViewport` with all 3 keys | `jq` |
| At least 1 `visual_anomaly` cluster has `viewportPx: 375` AND a different cluster id than any 1280 finding for the same page | `jq` |
| Total vision cost ≤ $1.00 | `jq '.vision.costUsd'` |
| 65-cluster baseline preserved (no regression from loop) | manual diff |
| Single-viewport mode (`viewports: [1280]`) preserves prior behavior exactly | regression test |

---

## 10. Risks + escape hatches

- **Risk: 3× vision cost.** Mitigation: default `maxCalls: 200`, cost cap remains $20. Empirically on Aspectv3 (32 routes × 3 viewports × 2 consistency runs = 192 calls × $0.005 = $0.96).
- **Risk: setViewport doesn't actually resize on camofox.** Mitigation: fallback to `evaluate(window.resizeTo)`. Document that real device-pixel-ratio simulation requires a separate camofox upgrade.
- **Risk: SPA doesn't react to programmatic resize.** Mitigation: dispatch `resize` event after setViewport. Settle delay before screenshot.
- **Risk: per-viewport cluster split inflates cluster count.** That's correct behavior — mobile and desktop bugs are usually distinct. Operators can grep `byKind.visual_anomaly` to see the total.
- **Escape hatch:** `viewports: [1280]` reverts to v0.13 behavior.

---

## 11. Killer-demo runbook (Aspectv3)

```bash
# Update Aspectv3 config to enable v0.17
cat > /tmp/v17-vision-config.json <<'EOF'
{
  "viewports": [375, 768, 1280],
  "consistencyRuns": 2,
  "agreementMode": "strict",
  "maxCalls": 200,
  "costCapUsd": 5.0
}
EOF
# (merge into /root/Aspectv3/.bughunter/config.json's "vision" block)

# Run smoke
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 150 --budget 2400000 --a11y --a11y-strict --seo

# Inspect mobile-only findings
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.byKind.visual_anomaly' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
jq '.vision.byViewport' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
jq '[.[] | select(.kind == "visual_anomaly" and .occurrences[0].action.viewportPx == 375)] | length' \
  /root/Aspectv3/.bughunter/runs/$RUN/bugs.jsonl
```

Expected: a count of mobile-only findings ≥ 1. Likely candidates: dashboard's right-column cards already clip at desktop; at 375px they probably collapse into a column with new clipping issues; tables (`/users`, `/results`, `/samples`) almost certainly fail to provide horizontal scroll on mobile.

---

## 12. Open questions

1. **Should we tag `auth_lost_mid_loop` with the viewport at which it occurred?** Spec says no — auth survival is per-page, not per-viewport. The probe runs once before the loop.
2. **Should viewport order be configurable?** Spec says no — smallest-to-largest is the only sensible order to expose responsive bugs first.
3. **Should `viewports: []` be valid?** Spec says no — Zod schema requires at least 1 entry. An empty array would silently disable vision; better to fail fast.
