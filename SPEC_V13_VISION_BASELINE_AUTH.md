# SPEC — v0.13 "Vision baseline: auth survival across screenshots"

**Status:** Draft 1 — ready for `@coder` after review · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Sibling specs:** `SPEC_VISION_DETECTION.md`, `SPEC_VISION_STATE_REOPEN.md` · **Predecessor:** v0.12 click accessible-name · **Successor:** v0.14 vision-result-driven crawl steering (separate spec).

This spec is the **implementation contract** for the auth-state-survival fix in the vision baseline pass. The smoke against an authenticated SaaS SPA (Aspectv3) reproduced **1 unique vision call across 32 routes** when the expectation is ≥10. This spec eliminates the auth-state gap so Sonnet 4.6 sees real authenticated content on every distinct route.

---

## 0. Reading guide

| Section | Audience | When to read |
|---|---|---|
| §1 Objective + boundaries | everyone | first |
| §2 Existing code map | `@coder` | before any keyboard touch |
| §3 Investigation findings | `@architect` reviewer + `@coder` | before §4 |
| §4 Design choice | everyone | before any implementation |
| §5 Edge cases | `@coder` per case | per task |
| §6 Test plan | `@qa` + `@coder` | per task |
| §7 Negative requirements | everyone | before commit |
| §8 Task breakdown | `@architect` (assigning) + assignee | per task |
| §9 Acceptance | `@qa` + `@architect` | end of phase |
| §10 Risks | everyone | before commit |
| §11 Killer-demo runbook + cost | everyone | end-of-phase verification |

---

## 1. Objective

Preserve authenticated state across every vision-baseline screenshot so that Sonnet 4.6 evaluates **rendered, post-login** UI on every distinct route — not the same redirect-to-login splash 32 times. The fix must be deterministic (no race-prone localStorage injection) and must not regress the existing screenshot-hash dedup or the per-run vision budget.

### Boundaries

**In scope:**
- Auth-state survival between the login step and the per-route screenshots in `runVisualBaseline` (`packages/cli/src/phases/discover.ts`).
- Same survival for the `state`-kind page variant (`page.kind === 'state'` with `stateContext`).
- Sequencing changes inside `runVisualBaseline`'s screenshot phase.
- Settle-delay tuning so first-paint completes before screenshot.

**Explicitly out of scope:**
- Changes to the screenshot-hash dedup logic (`visionBudget.tryConsumeHash`) — already correct.
- Changes to the per-run budget (`maxCalls`, `maxCostUsd`) — already correct.
- Changes to the login flow itself (`discovery/browser-login.ts`) — already proven on the smoke run.
- Changes to camofox-mcp or camofox-browser — verified unnecessary in §3.
- Vision-driven crawl steering (using vision output to enqueue follow-up routes) — separate v0.14 spec.
- Changes to the classification phase (`classifyVisualAnomalies`) — concurrency, prompt, parsing all unchanged.
- New BugKinds — none added; this spec only changes the *feed* into the existing classifier.

### External dependencies (unchanged)

- camofox-mcp-http on port 3104 (unchanged).
- camofox-browser server on port 9377 (unchanged).
- Anthropic Sonnet 4.6 via `claudeCli` or `apiKey` (unchanged).

---

## 2. Existing code map

### Files you MUST read before writing any code

- `packages/cli/src/phases/discover.ts` — the only file you will modify in CLI logic. `runVisualBaseline` lines 247–346 is the rewrite target. `runDiscover` calls it at line 232.
- `packages/cli/src/adapters/browser-mcp.ts` — `BrowserMcpAdapter` and `CamofoxBrowserMcpAdapter`. **Do not change the public interface.** You will use the singleton-tab methods (`browser.navigate`, `browser.screenshot`, `browser.evaluate`, `browser.clickByHint`) instead of `browser.withTab(...)`. The `withTab` method stays in place for other callers (execute phase, replay).
- `packages/cli/src/discovery/browser-login.ts` — read top-to-bottom. The login flow leaves the singleton tab on the post-login URL with the JWT in localStorage and any auth cookies in the shared BrowserContext. **Do not modify.** This is the proof that the singleton tab is authenticated when `runVisualBaseline` runs.
- `packages/cli/src/discovery/dom-walker.ts` — `walkDom` already navigates the singleton tab to every route successfully. The vision pass should mirror that pattern.
- `packages/cli/src/types.ts` — `DiscoveredPage`, `VisualBaselineEntry`, `VisionConfig`. **Do not modify** unless adding the new optional `vision.preScreenshotSettleMs` field (Task 5).
- `packages/cli/src/classify/vision.ts` — `classifyVisualAnomalies` signature (caller contract unchanged).
- `packages/cli/src/classify/vision-budget.ts` — `tryConsume`, `tryConsumeHash`, pricing table. **Read for understanding; do not modify.**
- `packages/cli/src/cli/run.ts` lines 196–199 — note that `closeAllExistingTabs(browser)` runs **once at process start**, before login. After that, the singleton tab is the only tab unless `withTab` opens transients.

### Patterns to follow

- **Singleton tab pattern.** `walkDom` (lines 146–163) demonstrates the canonical "navigate the singleton, then probe" pattern. Match it.
- **Per-route try/catch with skip-list emit.** When a single route fails, log a warn and `continue` — do not abort the whole loop. See `runVisualBaseline` lines 288–291 for the existing version.
- **Hash-then-budget consume.** First compute the screenshot hash. Only consume from `visionBudget.tryConsume()` *after* `visionBudget.tryConsumeHash(hash)` returns true. Existing code (lines 294–309) does this correctly — preserve the order.
- **Concurrency-bounded classification pool.** Phase-2 classification (lines 314–343) uses an `inFlight` set with `Promise.race`. Keep this pattern — only the screenshot phase changes.
- **Settle delays use `setTimeout`, not `page.waitForLoadState`.** `VISION_BASELINE_SETTLE_MS` (1500) — keep as the floor. Add a configurable upper bound (Task 5).

### What the camofox stack already gives you (don't rebuild)

Verified by reading `/root/.openclaw/extensions/camofox-browser/server.js` and `/root/camofox-mcp/src/transports/http.ts`:

- All tabs in the camofox session share **one Playwright `BrowserContext`** (`server.js:796` `b.newContext(contextOptions)`; reused via `getSession(userId)`).
- camofox-mcp-http always uses `userId="claude"`, `sessionKey="default"` (env-overridable). One context per BugHunter process, in practice.
- localStorage and cookies set on any tab are visible to all other tabs in the same context.
- `close_tab` calls `safePageClose(page)` only — does not destroy the context.
- The session-reaper destroys the context **only when `tabGroups.size === 0` for ≥60 s** (`server.js:2640`). Keeping at least one tab open the entire run keeps the context alive.

### DO NOT

- Do **not** create a new file in `packages/cli/src/phases/`. Modify `discover.ts` only.
- Do **not** add a new method to `BrowserMcpAdapter`. The singleton-tab API surface (`navigate`, `screenshot`, `evaluate`, `clickByHint`) is sufficient.
- Do **not** call `browser.withTab(...)` inside the new `runVisualBaseline`. It is the source of the bug *for this loop's purposes* (see §3, §4) — though it remains correct for the execute phase and is unchanged.
- Do **not** add cookie / localStorage capture-and-replay helpers. They are unnecessary under Design C.
- Do **not** patch camofox or camofox-mcp. Verified unnecessary (§3 Q4).
- Do **not** parallelize the screenshot loop. The singleton tab is, by definition, one-at-a-time.
- Do **not** add new BugKinds, new vision prompts, or change `classifyVisualAnomalies`. Out of scope.
- Do **not** touch tests for `withTab` (`browser-mcp.test.ts`). The method's contract is unchanged.

---

## 3. Investigation findings

The five questions posed by the dispatcher, with verified answers from source.

### Q1. Does the camofox HTTP API expose a way to share a persistent context across tabs?

**Answer: yes, by default.** Verified at `/root/.openclaw/extensions/camofox-browser/server.js:747-812` (`getSession`) and `:1551-1601` (`POST /tabs`). All tabs created for a given `userId` share a single `BrowserContext` returned by `b.newContext(contextOptions)` — created once per session, reused across `session.context.newPage()` calls. There is no per-tab isolation at the BrowserContext level.

The shared context is destroyed only when:
- `closeSession` is called explicitly (admin path or proxy rotation).
- The session-reaper finds `tabGroups.size === 0` for one tick (60 s interval).
- The context's `pages()` probe throws (`server.js:759-763` — "session context dead, recreating").

### Q2. How does camofox spawn tabs? `BrowserContext.newContext` per tab, or `newPage` on a shared context?

**Answer: `newPage` on a shared context.** `server.js:1576` `const page = await session.context.newPage();` for `POST /tabs`. Same pattern at `:1630` for navigate-creates-tab and `:1018` for the Google rotation path. **No per-tab `newContext` exists in the live tab path.** The only `newContext` calls are in `getSession` (initial) and the smoke-test bootstrap at `:3152`.

### Q3. After login completes, where does the auth token live?

**Answer: localStorage at key `aspect-auth`** (Aspectv3). Verified at `/root/Aspectv3/apps/web/src/stores/auth.store.ts:18-66`:

```ts
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({ user: null, token: null, refreshToken: null, login, logout }),
    { name: "aspect-auth", partialize: (state) => ({ user, token, refreshToken }) }
  )
);
```

Default Zustand `persist` middleware uses synchronous `localStorage`. Hydration happens at module-import time, before any React render. The `AuthGate` at `/root/Aspectv3/apps/web/src/app.tsx:16-29` reads `token` synchronously and either redirects to `/login` (no token) or renders `<Outlet />` (token present).

There is **no** server-fetch in the AuthGate path — purely client-side token presence check. Therefore: if `localStorage["aspect-auth"]` contains a token at first render, the SPA boots into authenticated mode without any extra network round-trip.

For other apps (TraiderJo, Spoonworks): assume the same Zustand-persist + cookies pattern. Generic enough that the design must not hardcode `aspect-auth`.

### Q4. Does camofox expose `setLocalStorage`, `addCookies`, `getStorageState`?

**Answer: not via the MCP tool surface.** `/root/camofox-mcp/src/core/tools.ts` lines 23–186 register the tool list: `navigate`, `snapshot`, `click`, `type`, `scroll`, `screenshot`, `evaluate`, `list_tabs`, `close_tab`, `cookies` (read-only). There is no `set_cookie`, `set_local_storage`, or `storage_state` tool.

The `cookies` HTTP endpoint is read-only (`server.js:2473-2480` registers a GET handler returning Playwright-shaped cookies; there is no POST/PUT pair). Setting localStorage from outside the page context is possible via `page.evaluate('localStorage.setItem(...)')` — but **only after** a same-origin navigation has loaded the page. You cannot pre-seed localStorage before the first `goto`.

This is the constraint that rules out **Design B** for the simple case (§4): there is no way to pre-load localStorage on a fresh tab *before* the SPA's first paint runs.

### Q5. Is the Aspectv3 auth store keyed under `auth-storage` or `aspect-auth`?

**Answer: `aspect-auth`.** Confirmed in `/root/Aspectv3/apps/web/src/stores/auth.store.ts:58`. The `auth-storage` convention you cited is from other Zustand templates; this app uses the kebab-case `aspect-auth`. The chosen design (Design C) does **not** depend on this key — but it's logged here so future maintainers don't grep for the wrong string.

### Verified root cause (one paragraph)

The 1-vision-call symptom on a 32-route smoke is caused by `runVisualBaseline` opening a **fresh new tab** via `browser.withTab(url, ...)` for every page. While the underlying camofox `BrowserContext` *is* shared (so localStorage *should* survive), the new tab navigates directly to the protected route on a Vite dev server. In dev mode, Vite must compile the route module on the first request to that path — the resulting first paint can land before the Zustand `persist` middleware has finished reading `aspect-auth` from localStorage on this brand-new V8 context, **and** before the bundle's auth-store module has even been evaluated. The hard-coded 1500 ms `VISION_BASELINE_SETTLE_MS` is below the cold-start budget on a Vite dev SPA with this many lazy chunks. The result: `AuthGate` reads `token === null`, redirects to `/login`, and the screenshot captures the byte-identical login page. Across 32 routes, all 32 screenshots collapse to one hash via `tryConsumeHash`, leading to a single API call. The fix is to **stop opening fresh tabs in this loop**: the singleton tab from the login flow is already authenticated and already known-good (DOM walk has navigated it to every route in this very same run); we screenshot from there.

---

## 4. Design choice

### Candidate designs (full trade-off table)

| ID | Design | Pros | Cons | Verdict |
|---|---|---|---|---|
| A | Single shared persistent context for the vision loop | Already true at the camofox layer | Doesn't change observable behavior — the bug isn't context isolation | **Reject:** misdiagnoses the cause |
| B | Capture localStorage + cookies after login; inject before each `withTab` via `evaluate` then `location.replace` | Most general; works for any auth scheme | Race-prone (SPA boots before injection on a fresh tab); requires a same-origin "safe" landing route; doubles navigations per page; adds 60+ lines for a corner-case rescue | **Reject:** the simpler Design C subsumes the use case |
| C | Drop `withTab`; use the singleton tab for sequential `navigate → settle → screenshot` per route | Singleton is already authenticated; no race; no new APIs; mirrors `walkDom`'s proven loop; ~25-line diff | Errors on one route taint subsequent routes — mitigated by per-route try/catch and an explicit health-check; loses parallelism (acceptable: vision-call concurrency is preserved at the classifier stage) | **Accept** |
| D | Drive the SPA's sidebar UI to navigate between routes | No URL parsing | Fragile (depends on stable nav selectors); breaks for routes with no sidebar entry; doesn't fix anything that C doesn't | **Reject:** brittle |
| E | Increase per-run vision budget; accept the dedup collapse | Zero code change | Doesn't fix the auth-bleed; just costs more for the same 1 unique screenshot | **Reject:** doesn't solve the problem |

### Chosen design: C — singleton-tab sequential screenshots

**Rationale (one paragraph).** The DOM-walk loop earlier in `runDiscover` already proves the singleton tab is authenticated and can navigate to every route via `browser.navigate(url, headers)`. After that loop, the singleton tab is sitting on the last walked route, fully authed. `runVisualBaseline` previously discarded that proven path by calling `browser.withTab(url, ...)` per page, opening a fresh tab whose first-paint timing on a Vite dev SPA is unreliable. Switching to the singleton tab eliminates the cold-start race entirely (the bundle is hot, the auth store is hydrated, the user is logged in) and reduces the implementation surface to a per-route `navigate → wait settle → screenshot` triplet. The only new logic needed is (a) a one-time auth-health probe before the loop starts (so we fail loudly if login somehow degraded between phases), and (b) a per-route timing-safe settle that exceeds the worst-case Vite cold-route compile (default 2500 ms, configurable via `vision.preScreenshotSettleMs`). For `state`-kind pages, we navigate the singleton to the base route, click the trigger via `clickByHint`, settle, then screenshot — same triplet, one extra step. The `withTab` API stays in place for the execute phase and replay, where independent tabs are still desirable.

### Implementation sequence (per route)

```
for each page in pages:
  if page.kind === 'state':
    browser.navigate(baseRoute, runHeaders)        # singleton tab
    await sleep(stateSettleMs ?? 250)
    browser.clickByHint(triggerHint)               # opens modal/drawer
    await sleep(preScreenshotSettleMs ?? 2500)
  else:
    browser.navigate(page.route, runHeaders)       # singleton tab
    await sleep(preScreenshotSettleMs ?? 2500)

  screenshot = browser.screenshot(tmpPath)         # singleton tab
  hash = sha256(screenshot bytes)
  if not visionBudget.tryConsumeHash(hash): continue
  if not visionBudget.tryConsume(): break
  push { page, screenshotPath } to screenshotEntries
```

Phase-2 classification loop (lines 314–343 of the existing file) is unchanged.

### One-time auth-health probe (before the loop)

After the DOM walk completes and before the per-page screenshot loop starts, run:

```ts
// Singleton tab has been navigated 32 times by walkDom; assume current URL
// is one of the protected routes.
const isAuthed = await probeAuthHealth(browser, config);
if (!isAuthed) {
  log.warn('vision baseline: singleton tab not authenticated; skipping vision pass entirely');
  return [];
}
```

The probe (single `browser.evaluate(...)`):
- Returns `true` if `location.pathname` does NOT match `/login`, `/auth/login`, or any configured `loginRedirectGlob`.
- Returns `true` if any of the configured `successCheck` cookie names are present (read via `browser.cookies([baseUrl])`).
- Otherwise returns `false`.

Failure is informational — we skip vision rather than emitting a bug detection. (If login truly failed, that surfaces via the existing `browser_login_*` skip entries from `runDiscover`.)

### Why we keep `withTab` in the codebase

- The execute phase (`phases/execute.ts`) uses `withTab` per test case for **isolation** between mutations (writes by one test must not pollute another). That is correct and unchanged.
- Replay (`cli/replay.ts`) uses `withTab` for the same reason.
- `runVisualBaseline` is read-only and benefits from the *opposite* property: persistent state across pages. Switching only this caller.

---

## 5. Edge cases

Enumerate every non-happy-path scenario. If any of these surface during implementation in a way not covered here, **stop and ask**.

### EC-1. Auth degrades mid-loop (token expires, server invalidates session)

The singleton tab loses auth between pages 5 and 6. Pages 6–32 screenshot the login redirect.

**Handling:** Run the auth-health probe **before each navigation** is overkill; but we *do* re-check the post-navigate URL. If `location.pathname` matches the login glob *and* the requested route did not, log `vision_baseline_auth_lost_mid_loop` and skip the rest of the loop. Add this telemetry to `discovery.visionBaselineTelemetry`.

### EC-2. Route legitimately redirects to login (e.g., owner-only route accessed by non-owner role)

The first crawl already filtered to routes the role can reach (`crawlFromSeeds` walks links visible to the logged-in user). For the rare static-source route that role cannot reach: post-navigate pathname matches login glob *and* requested route does not. Treat identically to EC-1 (log + skip *that route*; do **not** abort the whole loop). The dedup hash will catch repeated identical-redirect screenshots anyway.

### EC-3. Per-route loading state taints the screenshot

A dashboard with skeleton loaders showing for 800 ms, then real content at 1800 ms. With the new floor of 2500 ms, the skeleton is gone. If a specific app shows skeletons for >2500 ms, the user sets `vision.preScreenshotSettleMs` higher in `bughunter.json`. Document this in §11.

### EC-4. Toast/banner from a previous route persists into the next screenshot

The DOM walk loop has already navigated the singleton through 32 routes in succession; any per-route toast would have settled or been replaced. The screenshot pass walks the same routes a second time — same risk profile. **No special handling.** If toast bleed is observed in the killer-demo run (§11), add a `dispatchEvent('keydown', { key: 'Escape' })` between navigation and screenshot in a follow-up spec — but only if observed, not preemptively.

### EC-5. Route navigation throws

Already handled by the existing `try/catch` (lines 288–291). Preserve: log `vision baseline: failed to open/screenshot page ${route}`, push to skip list, `continue`.

### EC-6. Screenshot returns empty / 0-byte

Hash is computed on empty buffer (deterministic). It dedups on first occurrence. Subsequent empties are skipped. No bug detection emitted for an empty screenshot. Add a `screenshot.length < 1024` early-skip with a `screenshot_too_small` log entry — empty PNGs waste a `tryConsumeHash` slot.

### EC-7. `state`-kind page's trigger fails to click on the singleton tab

`clickByHint` returns `{ clicked: false, reason }`. Currently (line 277-278) this throws inside the `withTab` callback; in Design C we handle it directly: log `vision baseline: state trigger failed for ${route} (${reason})`, push to skip list, `continue`.

### EC-8. Singleton tab is closed unexpectedly (camofox restart, OOM kill)

`browser.navigate(url)` will throw `BrowserMcpError('no_tab', ...)` or transport error. Existing per-route `try/catch` catches it. Loop continues; subsequent navigates re-acquire a tab via the camofox auto-creation path (`server.js:1618-1637`). The auto-created tab will **not** be authenticated. The next post-navigate URL will match the login glob and EC-1 fires — vision pass aborts cleanly. Acceptable.

### EC-9. Screenshot taken before route's data fetch resolves

The route renders, then triggers a TanStack Query / SWR fetch. Default 2500 ms covers the common case (sub-second API on a localhost). For slow APIs, user raises `preScreenshotSettleMs`. Do **not** add a smarter wait (`networkidle` is unreliable on apps with polling).

### EC-10. Vite HMR causes a layout shift mid-screenshot

The screenshot is a single point-in-time PNG; HMR-triggered re-renders during the screenshot byte capture would manifest as torn frames. Camofox uses Playwright's `page.screenshot`, which is atomic at the rendering-engine level. Not a real risk.

### EC-11. Cost-cap exhausted mid-loop

Existing behavior: `tryConsume` returns false → `break` out of the screenshot phase. Preserve. Phase-2 classification still runs on already-collected entries.

### EC-12. visionBudget is undefined (vision disabled at run start)

Existing guard at line 255 returns `[]` immediately. Preserve.

---

## 6. Test plan

### Unit tests

Add to `packages/cli/src/phases/discover.test.ts` (file does not currently exist for discover; create only this one new test file). **Allowed new file** — listed here per §7 negative requirements.

Mock `BrowserMcpAdapter` as a stub (no real camofox). Each test case asserts the singleton-tab call sequence:

- **T1.** `runVisualBaseline` on 3 url-kind pages issues exactly 3 `browser.navigate` + 3 `browser.screenshot` calls; **zero** `browser.withTab` calls.
- **T2.** `runVisualBaseline` on 1 state-kind page issues 1 `browser.navigate` (base route) + 1 `browser.clickByHint` (trigger) + 1 `browser.screenshot`.
- **T3.** Hash dedup: 3 url-pages, all returning identical screenshot bytes → 1 `tryConsumeHash` accept + 2 rejects, `tryConsume` called exactly once.
- **T4.** Auth-health probe negative: stub `evaluate('location.pathname')` returns `'/auth/login'` → `runVisualBaseline` returns `[]` and emits `auth_lost_pre_loop` telemetry.
- **T5.** EC-1: navigate to `/dashboard` succeeds; post-navigate `evaluate('location.pathname')` returns `/auth/login` → log `vision_baseline_auth_lost_mid_loop`, skip current route, abort remaining routes.
- **T6.** EC-7: state-kind page where `clickByHint` returns `{clicked: false, reason: 'not_found'}` → that route is skipped, loop continues to next route.
- **T7.** EC-11: budget caps at 2 calls, third route's `tryConsume` returns false → loop breaks; `screenshotEntries.length === 2`.
- **T8.** EC-6: screenshot returns 512-byte buffer → skipped without consuming budget; counter `screenshot_too_small` increments.

### Integration test (camofox required)

`packages/cli/src/phases/discover.integration.test.ts` (existing if present; otherwise add). Skip when `process.env.CAMOFOX_INTEGRATION !== '1'`.

- **I1.** Spin up a tiny Vite SPA fixture (`fixtures/vision-auth-spa/`) with: `/login`, `/dashboard`, `/users`, `/settings` — all gated behind a Zustand-persist token check. Run BugHunter discover with login configured. Assert `discovery.visualBaselineDetections` corresponds to ≥3 unique vision calls (one per protected route).
- **I2.** Same fixture but with login intentionally disabled (`browserLogin.enabled: false`). Assert `runVisualBaseline` returns `[]` and emits `auth_lost_pre_loop`.

### Manual smoke (killer demo — §11)

Run against Aspectv3 with the configured owner credentials. Assert ≥10 unique vision calls on the 32-route SPA; assert per-call cost ≤ $0.0025; assert total run cost ≤ $0.05.

### Existing tests that must keep passing

Run the full suite:
```bash
cd /root/BugHunter && pnpm -w test
cd /root/BugHunter && pnpm -w typecheck
cd /root/BugHunter && pnpm -w lint
cd /root/BugHunter && pnpm -w build
```

Specifically verify these untouched test files do not regress:
- `adapters/browser-mcp.test.ts` — `withTab` contract unchanged.
- `discovery/browser-login.test.ts` — login flow unchanged.
- `phases/execute.test.ts` — `withTab` still used here.
- `cli/replay.test.ts` — `withTab` still used here.

---

## 7. Negative requirements

Explicit prohibitions. Violations are spec drift; the architect will reject the PR.

- **No new files** outside the one allowed test file (`packages/cli/src/phases/discover.test.ts`). The implementation lives entirely in `phases/discover.ts`. If you find yourself reaching for a helper file, extract a top-level function inside `discover.ts` instead — it's already 374 lines, under the 500-line guidance limit, and adding 50 lines keeps it cohesive.
- **No `as any`** anywhere. If TypeScript demands a cast, narrow with `unknown` + a typed predicate.
- **No new public methods on `BrowserMcpAdapter` or `TabScope`.** The singleton-tab API is sufficient.
- **No changes to `withTab`** or its tests. It remains correct for execute/replay.
- **No changes to `classifyVisualAnomalies`, `vision-budget`, or vision prompt.** They are all correct.
- **No copy-paste of the `walkDom` body into `runVisualBaseline`.** Call `browser.navigate` directly; do NOT invoke `walkDom` (it does extra scrolling + DOM evaluation we don't need for a screenshot).
- **No silent error swallowing.** Every `catch` either logs + continues or logs + aborts. Empty `catch {}` is rejected.
- **No hardcoded auth-storage keys.** The auth-health probe uses URL-pathname matching + cookie presence — never reads `localStorage["aspect-auth"]` by name.
- **No parallelism in the screenshot phase.** Singleton tab is sequential by definition.
- **Max 40 lines per function.** If `runVisualBaseline` exceeds 40 lines after refactor, split out `screenshotPhase`, `classifyPhase`, `probeAuthHealth` as helpers — but keep them in the same file.
- **No changes to `bughunter.json` schema beyond one optional field** (`vision.preScreenshotSettleMs`). Default 2500. If you find yourself adding a second config knob, stop and ask.
- **No new BugKinds, no new VisualBaselineEntry shape.** The output type is unchanged.

---

## 8. Task breakdown

Each task: ≤30 minutes human-equivalent. Independently testable. One concern per task.

### Task 1 — Add `vision.preScreenshotSettleMs` config field

**Assignee:** `@coder`
**Depends on:** none
**Files to modify:** `packages/cli/src/types.ts` (`VisionConfig` type), `packages/cli/src/config.ts` (Zod schema), `packages/cli/src/classify/vision.ts` (`resolveVisionConfig` returns the resolved value).
**Files to create:** none
**Test:** `pnpm -w test -- config.test.ts` (extend existing config test with one case asserting the new field round-trips through `resolveVisionConfig`).
**Done when:** `resolveVisionConfig({ preScreenshotSettleMs: 4000 })` returns `{ preScreenshotSettleMs: 4000, ... }`; missing field defaults to 2500; the field is rejected with a Zod parse error if not a positive integer.
**DO NOT:** rename `VISION_BASELINE_SETTLE_MS` (keep the constant; it becomes the floor); change unrelated config fields; add CLI-flag wiring (config-file only).

### Task 2 — Extract `probeAuthHealth(browser, config)` helper inside `discover.ts`

**Assignee:** `@coder`
**Depends on:** none
**Files to modify:** `packages/cli/src/phases/discover.ts` (add a new top-level function — same file, no new file).
**Files to create:** none
**Test:** unit-test stub `BrowserMcpAdapter`; assert helper returns `true` when `evaluate('location.pathname')` returns `'/dashboard'` and false when it returns `'/login'`.
**Done when:** function signature `async function probeAuthHealth(browser: BrowserMcpAdapter, baseUrl: string, loginGlobs: string[]): Promise<boolean>` exists; ≤30 lines; uses single `browser.evaluate('location.pathname')` call (no `cookies` call yet — keep simple). Returns false on any thrown error.
**DO NOT:** add cookie checking (defer to a follow-up if needed); export the function (file-local); call it from outside `runVisualBaseline`.

### Task 3 — Rewrite `runVisualBaseline` Phase-1 (screenshot loop) to use singleton tab

**Assignee:** `@coder`
**Depends on:** Task 1, Task 2
**Files to modify:** `packages/cli/src/phases/discover.ts` (lines 247–312 — Phase-1 only).
**Files to create:** none
**Test:** Tests T1, T2, T3, T6, T7, T8 from §6. Run `pnpm -w test -- discover.test.ts`.
**Done when:**
- Phase-1 issues `browser.navigate(url, headers)` then `browser.screenshot(tmpPath)` per page (no `browser.withTab`).
- For `state`-kind: `browser.navigate(baseRoute)` + `browser.clickByHint(triggerHint)` + settle + `browser.screenshot`.
- Hash dedup happens before `tryConsume` (preserve existing order from lines 294–309).
- Probe-auth-health is called once before the first navigate; if false, return `[]` early.
- Per-route try/catch preserves existing `vision baseline: failed to open/screenshot page` warn.
- Screenshot < 1024 bytes is dropped with a `screenshot_too_small` log entry, no budget consumed (EC-6).
- The whole `runVisualBaseline` function is ≤40 lines; helpers (`probeAuthHealth`, `screenshotPhase`, `classifyPhase`) absorb the rest.

**DO NOT:** modify Phase-2 (concurrent classification — lines 314–343); change the `VisualBaselineEntry` shape; remove the `VISION_BASELINE_SETTLE_MS` constant (becomes the floor when `preScreenshotSettleMs` is unset).

### Task 4 — Add post-navigate auth-loss detection (EC-1)

**Assignee:** `@coder`
**Depends on:** Task 3
**Files to modify:** `packages/cli/src/phases/discover.ts` (within the new screenshot loop).
**Files to create:** none
**Test:** Test T5 from §6.
**Done when:** after each `browser.navigate(targetRoute)`, a `browser.evaluate('location.pathname')` is run. If the result matches a login glob *and* `targetRoute` does not, log `vision_baseline_auth_lost_mid_loop` with the index/route, push a skip-list entry `vision_baseline_auth_lost`, and `break` out of the loop.
**DO NOT:** make the post-navigate evaluate gate every screenshot when running against an unauthenticated app (config flag `browserLogin.enabled === false` should skip the probe entirely — the loop still runs, just without auth-loss detection); add a retry-login fallback (out of scope).

### Task 5 — Telemetry: count unique-vision-calls and emit on run summary

**Assignee:** `@coder`
**Depends on:** Task 3
**Files to modify:** `packages/cli/src/phases/discover.ts` (collect counters); `packages/cli/src/types.ts` (extend `DiscoveryOutput` with optional `visionBaselineTelemetry?: { uniqueScreenshots: number; dedupedScreenshots: number; authLostMidLoop: boolean; screenshotsTooSmall: number }`).
**Files to create:** none
**Test:** unit test asserts the counters reflect a 3-page mocked run (2 unique, 1 dup → `uniqueScreenshots: 2, dedupedScreenshots: 1`).
**Done when:** the counters appear in `state.json` under `discovery.visionBaselineTelemetry`.
**DO NOT:** print to stdout in JSON mode (the existing log abstraction handles this); add a separate file in `runDir/`.

### Task 6 — Update `SPEC_VISION_DETECTION.md` cross-reference

**Assignee:** `@coder`
**Depends on:** Task 3
**Files to modify:** `SPEC_VISION_DETECTION.md` (one paragraph addendum noting that v0.13 changed Phase-1 to singleton-tab; cite this spec).
**Files to create:** none
**Test:** none — documentation only.
**Done when:** the addendum links to `SPEC_V13_VISION_BASELINE_AUTH.md` and notes the unchanged classifier contract.
**DO NOT:** rewrite existing sections; remove any prior content.

### Task 7 — Smoke verification on Aspectv3 (killer demo)

**Assignee:** `@qa`
**Depends on:** Tasks 1–5
**Files to modify:** none
**Files to create:** none (smoke artifacts go to `~/.bughunter/runs/<runId>/` per usual)
**Test:** see §11 runbook.
**Done when:** ≥10 unique vision calls on the 32-route Aspectv3 smoke; total cost ≤ $0.05; no `auth_lost_pre_loop` or `vision_baseline_auth_lost_mid_loop` telemetry. **If the run produces <10 unique calls, file a follow-up issue rather than relaxing the acceptance bar.**
**DO NOT:** modify config to inflate the call count (e.g., disabling dedup).

### Task summary

| # | Task | Files modified | Files created | Test command | Lines (est.) |
|---|---|---|---|---|---|
| 1 | Add `preScreenshotSettleMs` config | types.ts, config.ts, vision.ts | 0 | `test -- config.test.ts` | ~15 |
| 2 | `probeAuthHealth` helper | discover.ts | 0 | `test -- discover.test.ts` | ~25 |
| 3 | Singleton-tab Phase-1 rewrite | discover.ts | 1 (test only) | `test -- discover.test.ts` | ~70 |
| 4 | EC-1 auth-loss detection | discover.ts | 0 | `test -- discover.test.ts` | ~15 |
| 5 | Telemetry counters | discover.ts, types.ts | 0 | `test -- discover.test.ts` | ~20 |
| 6 | Spec cross-reference | SPEC_VISION_DETECTION.md | 0 | none | ~10 |
| 7 | Smoke verification | none | 0 | manual | 0 |

**Total: 7 tasks, 1 new file (test only), ~155 net lines of implementation.**

---

## 9. Acceptance

The phase is complete when **all** of these hold:

| # | Criterion | Verification |
|---|---|---|
| A1 | TraiderJo smoke produces ≥10 unique vision calls on a ≥30-route SPA | `state.json.discovery.visualBaselineDetections.length` (or telemetry `uniqueScreenshots`) ≥ 10 |
| A2 | Aspectv3 smoke produces ≥10 unique vision calls on the 32-route SPA | same metric |
| A3 | Per-call cost ≤ $0.0025 | sum of `record.usage` / `state.json.visionBudget.consumed` |
| A4 | Total smoke cost ≤ $0.05 | `state.json.visionBudget.costUsd` |
| A5 | No `auth_lost_pre_loop` telemetry on a smoke with login configured | `state.json.discovery.visionBaselineTelemetry.authLostMidLoop === false` |
| A6 | All existing tests pass | `pnpm -w test && pnpm -w typecheck && pnpm -w lint && pnpm -w build` |
| A7 | New `discover.test.ts` covers T1–T8 | test file exists, all 8 cases pass |
| A8 | The `withTab` API is unchanged | `git diff packages/cli/src/adapters/browser-mcp.ts` shows zero diff |
| A9 | No new file outside `packages/cli/src/phases/discover.test.ts` | `git status --short` shows only modified files + that one new test |

**Non-criteria** (intentionally not gated):
- The vision classifier emitting non-zero anomalies. Empty anomaly lists from Sonnet on a clean SPA are valid output and prove the auth-survival fix works (because the classifier is *evaluating real content*, not a login page).
- Coverage of routes that genuinely don't render (404 pages, role-restricted) — those should be filtered earlier in discovery.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Singleton-tab navigation between two routes leaks DOM state (modal open from previous route remains) | Low | Medium (one route's screenshot polluted) | DOM walk loop already navigates the singleton through the same routes earlier; if state-bleed were happening, walkDom's evaluate would have caught it. If observed in killer demo, add `dispatchEvent('keydown', { key: 'Escape' })` between navigates as a follow-up. |
| R2 | `preScreenshotSettleMs` default of 2500 ms slows the run by ~80 s on a 32-route SPA vs. the old 1500 ms | Certain | Low (vision pass is dwarfed by execute phase) | Document the trade-off in §11; users can lower the value at their own risk. |
| R3 | A future code change reintroduces `withTab` in `runVisualBaseline` | Medium | High (regresses the bug) | Add a lint rule via a comment-anchored grep (`// V13_INVARIANT: do not call browser.withTab in runVisualBaseline`) — actual enforcement is via PR review. |
| R4 | The auth-health probe URL-pathname check has false positives on apps that use `/login` as a non-auth route name | Very low | Medium (skips vision pass entirely) | Make the login-glob list configurable in `bughunter.json` (`browserLogin.loginRedirectGlobs`, default `['/login', '/auth/login', '/signin']`). |
| R5 | The singleton tab is killed by the camofox session reaper between DOM walk and vision pass (60 s tick) | Very low (runs are typically under 60 s combined; tab-reaper requires `tabGroups.size === 0`) | High (vision pass aborts) | The DOM walk keeps the singleton open continuously; tab-reaper cannot fire while a tab is open. If ever observed, BugHunter should re-issue `loginInBrowser` — but that's a separate spec (v0.14 robustness). |
| R6 | Cost overrun if a future increase to `maxCalls` couples with this change to actually *use* the budget | Medium | Low ($0.0018 × 100 = $0.18 max) | Existing `maxCostUsd` cap (default $20) is the real backstop. |

---

## 11. Killer-demo runbook + cost projection

### Runbook (Aspectv3)

```bash
# 1. Confirm pm2 services are healthy
pm2 status | grep -E 'camofox|surfacemcp|aspect-ml'

# 2. Confirm Aspectv3 web is up on the configured port
curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/ || echo 'web not up'

# 3. Confirm BugHunter is on master with the v13 PR merged
cd /root/BugHunter && git log --oneline -3

# 4. Run the smoke
cd /root/Aspectv3 && \
  npx -y @bughunter/cli run \
    --project-dir . \
    --role owner \
    --vision-enabled \
    --json | tee /tmp/v13-smoke.json

# 5. Inspect the result
jq '.discovery.visualBaselineDetections | length' < ~/.bughunter/runs/$(jq -r .runId /tmp/v13-smoke.json)/state.json
jq '.visionBudget.consumed, .visionBudget.costUsd' < ~/.bughunter/runs/$(jq -r .runId /tmp/v13-smoke.json)/state.json
jq '.discovery.visionBaselineTelemetry' < ~/.bughunter/runs/$(jq -r .runId /tmp/v13-smoke.json)/state.json

# Expected:
# - visualBaselineDetections: 0 to ~5 (Sonnet won't always find anomalies — that's fine; we're proving auth survival, not anomaly count)
# - visionBudget.consumed: 10–32 (one per unique screenshot; 32 is the upper bound at one per route)
# - visionBudget.costUsd: 0.018–0.058
# - visionBaselineTelemetry: { uniqueScreenshots: 10+, dedupedScreenshots: 0–22, authLostMidLoop: false, screenshotsTooSmall: 0 }
```

### Cost projection (concrete)

Pricing (per `vision-budget.ts:9`): `claude-sonnet-4-6` = $3 input / $15 output per Mtok.

Per call against a typical screenshot (≈1500 input tokens, ≈100 output tokens):
- Input cost: 1500 × $3 / 1e6 = **$0.0045**
- Output cost: 100 × $15 / 1e6 = **$0.0015**
- **Per-call total: ~$0.0060** (more conservative than the $0.0018 dispatcher quote — assumes higher input due to image tokens for a 1280×720 screenshot)

Worst case for v0.13 acceptance (32 unique screenshots from a 32-route SPA): **32 × $0.006 = $0.192**.
Default `maxCostUsd = 20` → 100× headroom.
Default `maxCalls = 100` → 3× headroom on call count.

If a user opts into a 200-route SPA (e.g., admin console), the cost cap activates first at $20 / $0.006 ≈ 3300 calls. The call cap (100) is the binding constraint by default.

### Cost reporting in the run summary

The existing `state.json.visionBudget.{consumed, costUsd}` already exposes this. No new reporting needed.

---

## 12. Open questions (none for the implementer; flagged for `@architect` review)

1. **Should the post-navigate auth-loss check (Task 4) skip the *current* route too, or only abort future routes?** Spec'd as "skip current + abort future" because the screenshot of the auth redirect is exactly the byte-identical noise we're trying to eliminate. If reviewer disagrees, change to "screenshot anyway, then abort future routes" — either works for acceptance.
2. **Does `vision.preScreenshotSettleMs` belong under `vision` or `crawl`?** Spec'd under `vision` because it gates the vision pass specifically. If a future v0.14 wants the same delay before its own actions, lift it.
3. **Is there a case for keeping `withTab` parallelism in vision Phase-1 by opening multiple authenticated tabs?** Out of scope for v0.13; would require a `setStorageState`-style API in camofox. File a separate spec only if v0.13 acceptance is met but the wall-clock cost is unacceptable.
