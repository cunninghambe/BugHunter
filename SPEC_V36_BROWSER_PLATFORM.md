# SPEC — v0.36 "Browser-platform surface detection"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.6 a11y baseline (axe injection harness), v0.19 race-conditions (`routeFulfill` adapter primitive), v0.18 JWT login verify (sessionful `evaluate` after auth) · **Sibling specs:** v0.20 i18n stress (Phase E.2), v0.21 form-edge palette (Phase E.3) · **Roadmap slot:** SPEC_PATH_TO_EXHAUSTIVE.md §3.1 + §9 Phase E.

This spec adds nine new `BugKind`s for the **browser-platform surface** — the bugs that only appear when an app touches Service Workers, Web Workers, iframes, Shadow DOM, the Permissions API, WebRTC, Subresource Integrity, COOP/COEP isolation, or Trusted Types. Today's discovery walks the light DOM, observes console + network, and ignores everything that lives behind `shadowRoot`, in a Worker scope, in an iframe, or in browser-platform error events that never reach `window.onerror`. Every modern app — PWAs, design-system component libraries, OAuth-popup flows, WebRTC video apps, file-editor SPAs — exhibits at least one of these. v0.36 wires a single new module (`browser-platform-probe.ts`) that piggybacks on the existing per-page baseline pass (next to axe injection in `phases/execute.ts:onPageBaseline`), extends `walkDom` to descend `shadowRoot`, and adds an init-script-style probe injected at navigation time via the existing camofox `evaluate` primitive. No new browser-MCP tool is required for v0.36; one optional capability (`addInitScript`) is documented as a follow-up that would tighten timing on `service_worker_stale` and `web_worker_error`.

---

## 1. Objective

Add a passive-observation browser-platform probe that runs once per unique pageRoute (same hook as the v0.6 baseline) and emits `BugDetection`s for nine browser-platform pathologies. Detection is **read-only** — no app code is patched, no real microphone/geolocation is requested, no test harness re-renders the page. The probe consumes browser state that already exists by the time the page has loaded (`navigator.serviceWorker.getRegistrations()`, `document.querySelectorAll('script[integrity]')`, `crossOriginIsolated`, `trustedTypes`), plus a small injected bootstrap (`window.__BH_PLATFORM_PROBE`) installed at the top of the first `evaluate` call after navigate. Worker error capture is achieved by a same-call `console.error` mirror that wraps `Worker` and `SharedWorker` constructors as they are first referenced.

| BugKind | Detection signal |
|---|---|
| `service_worker_stale` | A registered SW whose `installing`/`waiting` worker has been waiting > `swStaleThresholdMs` (default 60s) AND no client has received `controllerchange`. Implies the app shipped an SW update but never called `skipWaiting()` / `clients.claim()`. |
| `web_worker_error` | A `Worker` or `SharedWorker` instance fired `'error'` or `'messageerror'` while we observed; captured via the constructor wrapper installed in the bootstrap. |
| `iframe_postmessage_unguarded` | At least one `addEventListener('message', ...)` listener was registered AND `MessageEvent` payloads dispatched during the probe window (or during a synthetic poke from the parent) trigger handler code paths whose source-text fails the `event.origin ===` / `allowedOrigins.includes(event.origin)` lint. Static + dynamic. |
| `shadow_dom_a11y_violation` | The DOM walker descended a `shadowRoot` and axe-core run inside that root reported ≥1 critical/serious violation that is NOT already a duplicate of a light-DOM violation on the same page. |
| `permission_denied_unhandled` | A call to `navigator.geolocation.getCurrentPosition` / `navigator.clipboard.readText` / `Notification.requestPermission` triggered a denial path (we force-deny via the probe) AND the app emitted an `unhandled_exception` / `console_error` in the same tick, OR the visible UI shows no error/empty state at +500ms (a `dom_error_text` companion is absent). |
| `webrtc_ice_failure` | An `RTCPeerConnection` instance reached `iceConnectionState === 'failed'` during the probe window AND no `iceconnectionstatechange` listener was registered (handler-absence proxy). |
| `subresource_integrity_violation` | A `<script>` / `<link>` with `integrity=` was blocked from loading (`SecurityPolicyViolationEvent` of type `'sri-violation'`, observed by the bootstrap), AND the page subsequently shows no error UI for the missing resource. |
| `coop_coep_violation` | `window.crossOriginIsolated === false` BUT the app uses `SharedArrayBuffer` (presence of `'SharedArrayBuffer' in window` reference in any loaded script source, OR an actual instantiation observed by the bootstrap proxy). Headers are present but mis-configured. |
| `trusted_types_violation` | CSP includes `require-trusted-types-for 'script'` AND a `securitypolicyviolation` event of `effectiveDirective === 'require-trusted-types-for'` fired during the probe (real DOM-XSS prevention misfire), OR static scan finds a raw `innerHTML =` assignment in a loaded inline script. |

**Not goals:**
- Real device-permission grants. We force-DENY; we never silently grant.
- File System Access API / WebBluetooth / WebUSB / WebHID detection — too small a surface in the wild today; defer to v0.37.
- Web Push / push-subscription expiry — requires a backend; v0.37.
- Hash-routing back-button bugs — covered by the v0.13 vision baseline + v0.9 form-state-nav, not platform-API related.
- HTTP/2 push and HTTP/3 stream-cancel detection — kernel-level; out of scope forever.
- Extending the camofox MCP server with `addInitScript` / route interception for SW headers — documented as a follow-up; the v0.36 implementation works against camofox v0.1 with `evaluate` only.

**In scope:**
- One new module `packages/cli/src/discovery/browser-platform-probe.ts` (~280 LoC).
- Extension to `walkDom` and `collectDomOnly` so element collection descends `shadowRoot` (closed shadow trees are ignored — they're a developer-deliberate boundary).
- Nine new `BugKind`s in `packages/cli/src/types.ts`.
- Nine new cases in `cluster/signature.ts`.
- Nine entries in `KIND_PRIORITY` in `phases/classify.ts`.
- New `BrowserPlatformContext` payload on `BugDetection` (mirrors `headerContext` / `raceContext` shape).
- One new config block `browserPlatform: { enabled, swStaleThresholdMs, permissions, ... }`.
- One new CLI flag `--browser-platform` / `--no-browser-platform`.
- Synthetic fixture `fixtures/browser-platform-bad/` with one route per BugKind.
- Telemetry on `summary.json.browserPlatform`.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `/root/BugHunter/SPEC_PATH_TO_EXHAUSTIVE.md` § 3.1 + § 9 Phase E | Roadmap rationale; the bug-class table that justifies every kind we add. |
| `/root/BugHunter/SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format reference; mirror its sectioning, "files you MUST read" table, and acceptance matrix shape. |
| `/root/BugHunter/SPEC_V19_RACE_CONDITIONS.md` § 3-5 | Pattern for a new BugKind family + cluster signatures + priority slotting + new config block. v0.36 mirrors the architecture. |
| `packages/cli/src/discovery/dom-walker.ts` | `COLLECT_ELEMENTS_SCRIPT` + `walkDom`. v0.36 extends the injected script to descend `shadowRoot`s and adds a parallel `BROWSER_PLATFORM_PROBE_SCRIPT`. **Do NOT rewrite the script** — append. |
| `packages/cli/src/adapters/browser-mcp.ts` | Adapter surface. v0.36 uses `browser.evaluate`, `browser.scroll`, and `browser.cookies` only — nothing new is required from the adapter for the MVP. The optional `addInitScript` capability is documented in § 11 as deferred. |
| `/root/.openclaw/extensions/camofox-browser/server.js` | Inventory of available primitives. Confirms: no `addInitScript` route exists today (`grep -n 'addInitScript' server.js` → 0 hits); `evaluate` is the only injection path. |
| `packages/cli/src/phases/execute.ts:onPageBaseline` (line ~135-180) | Hook point. The browser-platform probe slots in **after** the axe injection, **before** the SEO block, gated on `enableBrowserPlatform`. Same once-per-pageRoute semantics. |
| `packages/cli/src/types.ts` | Add new `BugKind`s, `BrowserPlatformContext` shape, `BrowserPlatformConfig`, `BrowserPlatformTelemetry`. |
| `packages/cli/src/phases/classify.ts` `KIND_PRIORITY` | Insert new kinds after `network_4xx_unexpected` and before the SEO/perf cluster (rationale § 4.2). |
| `packages/cli/src/cluster/signature.ts` | Add nine new `case` arms. Mirror the v0.5 / v0.19 idiom: `kind|pageRoute|distinguishingField`. |
| `packages/cli/src/config.ts` | Add `browserPlatform` block to the Zod schema with sane defaults. |
| `packages/cli/src/cli/run.ts` | Add `--browser-platform` / `--no-browser-platform` flags. |
| `packages/cli/src/phases/emit.ts` | Populate `summary.browserPlatform` telemetry. |
| `packages/cli/src/security/header-probe.ts` | **Pattern only** — header-probe is the cleanest precedent for "one async function per origin, returns shaped Detections, called from a single hook in `execute.ts`." Mirror it. |

### 2.2 Patterns to follow

- **Discriminated `BrowserPlatformContext`.** One field `kind: 'sw' | 'worker' | 'iframe' | 'shadow_a11y' | 'permission' | 'webrtc' | 'sri' | 'coop_coep' | 'trusted_types'` plus per-kind payload. Mirrors `raceContext` / `headerContext` shape.
- **One detection per BugKind per (pageRoute, distinguishing-attr).** SW staleness is per-(pageRoute, scope); worker error is per-(pageRoute, workerScriptUrl); iframe-postmessage is per-(pageRoute, listenerSourceFp); shadow a11y is per-(pageRoute, hostSelector + axeRuleId); etc. Cluster-signature § 4.3 codifies this.
- **Probe runs once per unique `pageRoute`.** Same `baselinedRoutes` Set used by axe + SEO. No re-probing on revisit. No probing during race-test re-runs.
- **Single `evaluate` round-trip per probe.** All nine probes are bundled into one `BROWSER_PLATFORM_PROBE_SCRIPT` that returns a single JSON envelope. The TypeScript side classifies the envelope into Detections.
- **Bootstrap is idempotent.** The bootstrap installs `window.__BH_PLATFORM_PROBE` if not already installed. Re-running on the same tab (e.g. after action) is safe and replays buffered observations.
- **Observation window.** The bootstrap buffers events for a fixed `observationWindowMs` (default 1500ms — covers SW activation + WebRTC ICE handshake without blowing the budget). Probe collection happens at the END of the window.
- **No app-code patching.** Constructor wrapping (`Worker`, `SharedWorker`, `RTCPeerConnection`, `SharedArrayBuffer`) is performed on the global namespace, not by patching app code. Wrappers are installed BEFORE the app's first reference if possible — here it's not possible (we run after navigate completes), so we wrap any **future** instantiations and observe **already-existing** instances via `performance.getEntriesByType('resource')` heuristics where applicable.
- **Discriminated-union returns.** `runBrowserPlatformProbe(scope, pageRoute, opts): Promise<{ ok: true; detections: BugDetection[] } | { ok: false; reason: string }>`.

### 2.3 DO NOT

- Do **not** request real permissions. Use `navigator.permissions.query({name})` for state inspection; force a denial only via the probe (see § 3.5 EC). Never call `getUserMedia`, `getCurrentPosition`, `requestPermission` for real.
- Do **not** crawl into closed shadow roots. `host.shadowRoot === null` for closed mode; the developer chose privacy. Skip silently.
- Do **not** crawl into cross-origin iframes. `iframe.contentDocument` will throw a SecurityError; catch and skip.
- Do **not** load axe-core a second time inside a shadow tree. axe-core's `run({ context })` already accepts a shadow root selector — re-use the loaded `window.axe`.
- Do **not** fire any user-perceived UI in service of the probe (no toast, no console.log of secrets, no DOM mutation). The bootstrap is invisible.
- Do **not** wrap `fetch`, `XMLHttpRequest`, or `Promise`. Network observation belongs to the existing console/network capture path; v0.36 only wraps platform-API constructors.
- Do **not** instantiate a real `RTCPeerConnection` or `Worker` to "probe" capability. Capability is inferred from page state.
- Do **not** treat absence of a kind as a failure. If the page never registers a SW, there is no `service_worker_stale` finding — it's not "skipped," there's just no signal.
- Do **not** bypass the cluster cap. v0.36 findings count against `--max-bugs` like any other.
- Do **not** auto-fix any of these — v0.36 is detection only. Fix-hint guidance ships in v0.37.
- Do **not** re-run on every action. The probe is per-pageRoute, baseline-tier — not per-test.

---

## 3. Architecture decisions

### 3.1 Probe module (`packages/cli/src/discovery/browser-platform-probe.ts`, new)

```ts
export type BrowserPlatformProbeOpts = {
  pageRoute: string;
  swStaleThresholdMs: number;       // default 60_000
  observationWindowMs: number;      // default 1500
  permissions: ReadonlyArray<'geolocation' | 'clipboard-read' | 'notifications'>; // default: all three
  enableShadowA11y: boolean;        // gated by enableA11y/a11yStrict + this flag
  enableForcedPermissionDeny: boolean; // default false; opt-in (see EC-3)
};

export type BrowserPlatformProbeResult =
  | { ok: true; detections: BugDetection[]; telemetry: BrowserPlatformTelemetry }
  | { ok: false; reason: 'evaluate_failed' | 'bootstrap_install_failed' | 'observation_window_aborted' };

export async function runBrowserPlatformProbe(
  scope: TabScope,
  opts: BrowserPlatformProbeOpts,
): Promise<BrowserPlatformProbeResult>;
```

The function:
1. Calls `scope.evaluate(BOOTSTRAP_INSTALL_SCRIPT)` — installs `window.__BH_PLATFORM_PROBE` (constructor wrappers, event listeners for `securitypolicyviolation` and `error`, SW state poller).
2. Awaits `observationWindowMs`.
3. Calls `scope.evaluate(BOOTSTRAP_HARVEST_SCRIPT)` — returns the buffered envelope.
4. (Optionally, gated on `enableShadowA11y`) calls `scope.evaluate(SHADOW_A11Y_SCRIPT)` — runs axe-core inside discovered shadow roots.
5. (Optionally, gated on `enableForcedPermissionDeny`) calls a permission-deny micro-probe per requested permission.
6. Maps the envelope to `BugDetection[]` via `classifyBrowserPlatform(envelope, opts)` (pure function).

### 3.2 DOM walker extension (`packages/cli/src/discovery/dom-walker.ts`)

Today `walkDom` collects elements via `document.querySelectorAll(selectors)` only — shadow trees are invisible. The collection script gains a recursive `walkRoots` helper:

```js
function walkRoots(root, fn) {
  fn(root);
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot && host.shadowRoot.mode === 'open') walkRoots(host.shadowRoot, fn);
  }
}
```

The element collection loop becomes:

```js
const els = [];
walkRoots(document, (root) => {
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach(el => {
      els.push({ /* ...same shape as before... */
        shadowHost: el.getRootNode() instanceof ShadowRoot
          ? bestSelector(el.getRootNode().host)
          : undefined,
      });
    });
  }
});
```

The `bestSelector` function ALSO needs to descend: if `el.getRootNode()` is a `ShadowRoot`, the returned selector is the host's selector with a `>>>` shadow-piercing marker (camofox supports Playwright-style `css=host >> css=descendant` syntax via the existing snapshot resolver — confirm before shipping; if not, the selector falls back to `[data-testid]` only inside shadow trees, which is the realistic case for component libraries).

`Element.shadowHost` is a new optional field on the `Element` type. Light-DOM elements leave it undefined; shadow-tree elements carry the host selector. Downstream consumers (`execute.ts`, `clickByHint`) ignore it for v0.36; v0.37 will route shadow clicks via host-piercing.

### 3.3 Bootstrap install script (one-shot, idempotent)

```js
(function() {
  if (window.__BH_PLATFORM_PROBE) return { installed: false, alreadyPresent: true };
  const buf = {
    workerErrors: [],            // {scriptUrl, errorMsg, kind: 'error' | 'messageerror', ts}
    cspViolations: [],           // {effectiveDirective, blockedURI, sample, ts}
    sriBlocked: [],              // {url, integrity, ts}
    rtcStates: [],               // {connectionId, state, ts, hadHandler}
    sabUsage: [],                // {ts, stackHint}
    permissionStates: {},        // {geolocation:'granted'|'denied'|'prompt', clipboard-read:..., notifications:...}
    listenersOnMessage: 0,       // count of addEventListener('message', ...) calls
    sw: null,                    // {hasRegistration, hasInstalling, hasWaiting, controllerScriptUrl, registeredAt}
    bootInstalledAt: Date.now(),
  };

  // 1. Worker constructor wrapping
  ['Worker', 'SharedWorker'].forEach(name => {
    const Orig = window[name];
    if (!Orig) return;
    window[name] = new Proxy(Orig, {
      construct(t, args) {
        const w = new t(...args);
        const scriptUrl = String(args[0] ?? '');
        w.addEventListener('error', e => buf.workerErrors.push({scriptUrl, kind:'error', errorMsg:String(e.message||e), ts:Date.now()}));
        w.addEventListener('messageerror', e => buf.workerErrors.push({scriptUrl, kind:'messageerror', errorMsg:String(e.data||''), ts:Date.now()}));
        return w;
      },
    });
  });

  // 2. CSP violation listener (Trusted Types + general CSP)
  document.addEventListener('securitypolicyviolation', e => {
    buf.cspViolations.push({
      effectiveDirective: e.effectiveDirective,
      blockedURI: e.blockedURI,
      sample: (e.sample || '').slice(0, 200),
      ts: Date.now(),
    });
    // SRI violations surface as effectiveDirective='require-sri-for' OR blockedURI starts with 'eval'/'inline' depending on browser; conservative match below
    if (/sri/i.test(e.effectiveDirective || '') || /integrity/i.test(e.violatedDirective || '')) {
      buf.sriBlocked.push({ url: e.blockedURI, integrity: 'unknown', ts: Date.now() });
    }
  });

  // 3. RTCPeerConnection wrapping
  if (window.RTCPeerConnection) {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Orig, {
      construct(t, args) {
        const pc = new t(...args);
        const id = String(buf.rtcStates.length);
        let hadHandler = false;
        const origAdd = pc.addEventListener.bind(pc);
        pc.addEventListener = function(type, fn, opts) {
          if (type === 'iceconnectionstatechange') hadHandler = true;
          return origAdd(type, fn, opts);
        };
        pc.addEventListener('iceconnectionstatechange', () => {
          buf.rtcStates.push({connectionId:id, state:pc.iceConnectionState, ts:Date.now(), hadHandler});
        });
        return pc;
      },
    });
  }

  // 4. SharedArrayBuffer use heuristic
  if ('SharedArrayBuffer' in window) {
    const Orig = window.SharedArrayBuffer;
    window.SharedArrayBuffer = new Proxy(Orig, {
      construct(t, args) {
        buf.sabUsage.push({ts:Date.now(), stackHint:(new Error()).stack?.split('\n').slice(1,3).join('|')||''});
        return new t(...args);
      },
    });
  }

  // 5. addEventListener('message') counter (postMessage-handler presence)
  const origAdd = window.addEventListener.bind(window);
  window.addEventListener = function(type, fn, opts) {
    if (type === 'message') {
      buf.listenersOnMessage++;
      // Wrap fn to capture handler source for static lint
      buf.messageHandlerSources = buf.messageHandlerSources || [];
      buf.messageHandlerSources.push(String(fn).slice(0, 600));
    }
    return origAdd(type, fn, opts);
  };

  window.__BH_PLATFORM_PROBE = buf;
  return { installed: true };
})()
```

The install script is approximately 2KB minified. The harvest script reads `window.__BH_PLATFORM_PROBE` plus computed-once snapshots (SW state, permissions, scripts-with-integrity), serialises, returns.

### 3.4 Harvest envelope shape

```ts
type ProbeEnvelope = {
  pageRoute: string;
  bootInstalledAt: number;
  harvestedAt: number;
  sw: {
    registrations: Array<{ scope: string; state: 'installing' | 'waiting' | 'active' | null; controllerUrl: string | null; ageMs: number }>;
    controllerChangedDuringWindow: boolean;
  };
  workers: { errors: Array<{ scriptUrl: string; errorMsg: string; kind: 'error' | 'messageerror' }> };
  postmessage: { listenerCount: number; handlerSources: string[] };  // truncated source for static lint
  shadowHosts: Array<{ selector: string; mode: 'open' }>; // closed mode never reaches us
  permissions: Record<string, 'granted' | 'denied' | 'prompt' | 'unknown'>;
  forcedDeny?: Array<{ permission: string; threwUnhandled: boolean; consoleErrorCount: number; uiErrorVisible: boolean }>;
  webrtc: { connections: Array<{ connectionId: string; finalState: string | null; hadHandler: boolean }> };
  sri: { scriptsWithIntegrity: number; blocked: Array<{ url: string }>; uiErrorVisible: boolean };
  isolation: { crossOriginIsolated: boolean; sabReferenced: boolean; sabInstantiated: boolean };
  trustedTypes: { policyRequired: boolean; violations: Array<{ effectiveDirective: string; sample: string; blockedURI: string }> };
};
```

`classifyBrowserPlatform(envelope, opts): BugDetection[]` is a pure function that walks the envelope and emits one `BugDetection` per pathology.

### 3.5 Per-BugKind detector wiring

#### 3.5.1 `service_worker_stale`

- **Detector signature:** `detectServiceWorkerStale(envelope, opts): BugDetection | null`
- **Input source:** `envelope.sw.registrations` (from `navigator.serviceWorker.getRegistrations()` snapshot at install + at harvest), `envelope.sw.controllerChangedDuringWindow` (from a `navigator.serviceWorker.addEventListener('controllerchange', ...)` set in the bootstrap).
- **Fires when:** `registrations.some(r => r.state === 'installing' || r.state === 'waiting')` AND `(harvestedAt - r.registeredAt) > swStaleThresholdMs` AND `controllerChangedDuringWindow === false`.
- **Integration point:** Bootstrap installs the SW state poller; harvest snapshots registrations again. The 60s threshold is too long for a single observation window (1.5s) — so the bootstrap reads `localStorage[`__bh_sw_${scope}__`]` for a previously-stamped install time across pageRoutes; if absent, the install stamps it, and on next visit the threshold is checked. **First-visit caveat:** SW staleness can only be detected on **second visit** to a given scope within a run. v0.36 documents this and emits the finding only on revisit; a first-visit "newly installed" SW is not stale. (See EC-1.)
- **Edge cases:** EC-1 (first visit), EC-2 (legitimate slow install), EC-7 (cross-origin SW scope).
- **`BrowserPlatformContext`:** `{ kind: 'sw', scope, ageMs, hasInstalling, hasWaiting }`.

#### 3.5.2 `web_worker_error`

- **Detector signature:** `detectWebWorkerError(envelope, opts): BugDetection[]` (one per distinct `(scriptUrl, kind)`).
- **Input source:** `envelope.workers.errors` (from constructor-wrapped `Worker` / `SharedWorker` `'error'` / `'messageerror'` listeners).
- **Fires when:** `workers.errors.length > 0`. Each unique `(scriptUrl, kind)` becomes its own finding.
- **Integration point:** Bootstrap wraps `window.Worker` and `window.SharedWorker` constructors. Existing workers instantiated **before** the bootstrap are missed — documented limitation, mitigated by per-pageRoute install (the workers usually instantiate after navigate completes, AFTER the bootstrap).
- **Edge cases:** EC-4 (worker spawned by inline `<script>` running pre-bootstrap), EC-5 (a `messageerror` from a structured-clone failure is real-bug-class but distinct from a JS exception).
- **Context:** `{ kind: 'worker', scriptUrl, eventKind: 'error' | 'messageerror', errorMsg }`.

#### 3.5.3 `iframe_postmessage_unguarded`

- **Detector signature:** `detectPostmessageUnguarded(envelope, opts): BugDetection[]`.
- **Input source:** `envelope.postmessage.handlerSources` — truncated `Function.prototype.toString` of each `addEventListener('message', fn)` callback registered during the window. Static-lint regex: `/event\.origin\s*[!=]==/` OR `/allowedOrigins\.|originAllowlist\.|origins\.includes/` to confirm a guard. Absence of all guards → unguarded.
- **Fires when:** `listenerCount > 0` AND **none** of the `handlerSources` show an origin guard. One finding per page (not per listener — typically one app has one cross-cutting bus).
- **Integration point:** Bootstrap monkey-patches `window.addEventListener` to count + capture sources for `'message'` type only.
- **Edge cases:** EC-6 (handler source is minified to single chars — false negative), EC-8 (handler is registered by a framework that performs origin checks elsewhere). Confidence score `'low'` when the handler is < 80 chars (likely a bare delegate to an external function we can't see).
- **Context:** `{ kind: 'iframe', listenerCount, handlerFingerprints: string[] }` (sha1 of normalised source, first 16 hex).

#### 3.5.4 `shadow_dom_a11y_violation`

- **Detector signature:** `detectShadowA11y(envelope, opts): BugDetection[]`.
- **Input source:** A second `evaluate` call that re-uses the already-loaded `window.axe` (injected by the v0.6 baseline) and runs `axe.run({ include: shadowHostSelector + ' >>> *' })` per discovered open shadow root. Returns the violations array.
- **Fires when:** ≥ 1 critical/serious axe violation inside a shadow tree AND not a duplicate of a light-DOM violation on the same `(pageRoute, axeRuleId, target)` (de-duped against the `a11yBaselineDetections` already collected).
- **Integration point:** Gated on `enableA11y === true` (axe must already be loaded) AND `browserPlatform.enableShadowA11y === true`. Runs inside `runBrowserPlatformProbe` step 4.
- **Edge cases:** EC-9 (axe-core older versions don't traverse shadow boundaries — verify version pin). EC-10 (Web Components re-render mid-axe-run; tolerate by serial scan, no parallel).
- **Context:** `{ kind: 'shadow_a11y', hostSelector, axeRuleId, severity }`.

#### 3.5.5 `permission_denied_unhandled`

- **Detector signature:** `detectPermissionDeniedUnhandled(envelope, opts): BugDetection[]`.
- **Input source:** Two paths:
  1. **Passive:** `envelope.permissions['geolocation']==='denied'` AND a `console_error` was captured during the observation window mentioning `'geolocation'` / `'permission'` / `'denied'`.
  2. **Forced (opt-in):** `envelope.forcedDeny` — for each permission in `opts.permissions`, the probe calls the permission API directly via `evaluate` (e.g. `navigator.geolocation.getCurrentPosition(s, e => window.__BH_PLATFORM_PROBE.forcedDeny.push(...))`), waits 500ms, observes whether an unhandled exception fires AND whether visible UI shows a meaningful error state (heuristic: any new `[role="alert"]` / `.error` / `.toast--error` element appears between `t=0` and `t=500ms`).
- **Fires when (passive):** denial state + matching console error logged AND no UI error visible.
- **Fires when (forced):** denial path taken AND `(threwUnhandled === true || (uiErrorVisible === false && consoleErrorCount > 0))`.
- **Integration point:** Forced-deny is gated behind `--browser-platform-force-deny` (default off) because it changes app behavior. Passive path is always-on when the probe is enabled.
- **Edge cases:** EC-3 (forced-deny mid-test corrupts the rest of the run — runs only on the per-pageRoute baseline pass, NOT during action execution; permission state is reset after the probe via the bootstrap saving + restoring nothing — the browser persists state per-context, so test-isolation requires `resetPolicy: 'per-test'`). EC-11 (Notifications API on Firefox-in-headless never prompts; treat as `'unknown'`).
- **Context:** `{ kind: 'permission', permission, mode: 'passive' | 'forced', uiErrorVisible, consoleErrorCount }`.

#### 3.5.6 `webrtc_ice_failure`

- **Detector signature:** `detectWebRtcIceFailure(envelope, opts): BugDetection[]`.
- **Input source:** `envelope.webrtc.connections` — for each `RTCPeerConnection` created during the observation window, the wrapper records final `iceConnectionState` and whether the app registered an `iceconnectionstatechange` handler.
- **Fires when:** `connections.some(c => c.finalState === 'failed' && c.hadHandler === false)`. The app reached failure AND has no observer to react to it.
- **Integration point:** Bootstrap wraps `RTCPeerConnection` constructor.
- **Edge cases:** EC-12 (app uses a wrapper SDK like Twilio that registers handlers internally — wrapper observes the SDK's listener, so `hadHandler === true`; correctly suppresses). EC-13 (probe runs on a page that never instantiates RTC — no signal, no finding).
- **Context:** `{ kind: 'webrtc', connectionId, finalState, hadHandler }`.

#### 3.5.7 `subresource_integrity_violation`

- **Detector signature:** `detectSriViolation(envelope, opts): BugDetection[]`.
- **Input source:** `envelope.sri.blocked` (from `securitypolicyviolation` events with `effectiveDirective` matching SRI patterns); `envelope.sri.scriptsWithIntegrity` (from `document.querySelectorAll('script[integrity], link[integrity]').length`); `envelope.sri.uiErrorVisible` (heuristic: same `[role="alert"]` / `.error` scan as permission probe).
- **Fires when:** `blocked.length > 0` AND `uiErrorVisible === false` (the app silently fell back without telling the user).
- **Integration point:** Bootstrap registers `securitypolicyviolation` listener.
- **Edge cases:** EC-14 (SRI block by browser cache eviction races — debounce: only emit if the same `url` is blocked AND the resource is referenced in `<head>` AND the page is interactive at +1s). EC-15 (legitimate SRI fallback — e.g. CDN failover with `<link onerror>` — `uiErrorVisible` will be false but the app is functioning fine; this remains a true positive because the user gets stale/missing content silently).
- **Context:** `{ kind: 'sri', blockedUrl, hasIntegrityAttr: number, uiErrorVisible }`.

#### 3.5.8 `coop_coep_violation`

- **Detector signature:** `detectCoopCoepViolation(envelope, opts): BugDetection | null`.
- **Input source:** `envelope.isolation.crossOriginIsolated` (`window.crossOriginIsolated`), `envelope.isolation.sabReferenced` (`'SharedArrayBuffer' in window` AND any inline-script source contains the literal token), `envelope.isolation.sabInstantiated` (constructor proxy).
- **Fires when:** `crossOriginIsolated === false` AND `(sabReferenced === true || sabInstantiated === true)`. The app needs isolation, the headers don't deliver.
- **Integration point:** Bootstrap proxies `SharedArrayBuffer`; harvest reads the global flag.
- **Edge cases:** EC-16 (some libraries reference `SharedArrayBuffer` but feature-detect with a try/catch and silently fall back — still a real bug because the optimised path is unreachable; flag as severity `medium` instead of `high`).
- **Context:** `{ kind: 'coop_coep', crossOriginIsolated, sabReferenced, sabInstantiated }`.

#### 3.5.9 `trusted_types_violation`

- **Detector signature:** `detectTrustedTypesViolation(envelope, opts): BugDetection[]`.
- **Input source:** `envelope.trustedTypes.violations` — `securitypolicyviolation` events whose `effectiveDirective` is `'require-trusted-types-for'` or `'trusted-types'`. Plus a static scan for raw `innerHTML =` writes inside loaded inline `<script>` tags (best-effort, low confidence).
- **Fires when:** ≥ 1 dynamic CSP violation OR (CSP `require-trusted-types-for 'script'` is present in `<meta>` / response header AND a static `innerHTML =` is found).
- **Integration point:** Bootstrap registers `securitypolicyviolation` listener (already done for SRI — same listener, different filter).
- **Edge cases:** EC-17 (Trusted Types CSP set on an app that doesn't actually use untrusted inputs — violations fire but are ALL real DOM-XSS prevention catches; treat each as a finding because even one violation means a real attack vector exists in code that touches user input).
- **Context:** `{ kind: 'trusted_types', sample, blockedURI, source: 'dynamic' | 'static_innerhtml' }`.

---

## 4. Bug classification additions

### 4.1 New `BugKind` family (`packages/cli/src/types.ts`)

```ts
// v0.36 browser-platform kinds
| 'service_worker_stale'
| 'web_worker_error'
| 'iframe_postmessage_unguarded'
| 'shadow_dom_a11y_violation'
| 'permission_denied_unhandled'
| 'webrtc_ice_failure'
| 'subresource_integrity_violation'
| 'coop_coep_violation'
| 'trusted_types_violation'
```

### 4.2 Priority hierarchy slotting (`packages/cli/src/phases/classify.ts`)

Browser-platform kinds are inserted **between** `network_4xx_unexpected` and the security family. Rationale:

- `trusted_types_violation` is a real attack-surface signal (CSP catching DOM XSS) — slots **above** other security kinds (peer to `xss_dom`).
- `web_worker_error` is an `unhandled_exception` cousin — high but below explicit XSS exec.
- `service_worker_stale` and `iframe_postmessage_unguarded` are correctness/security mid-tier.
- `shadow_dom_a11y_violation` is peer to existing axe critical — same tier as `accessibility_critical`.
- `permission_denied_unhandled`, `webrtc_ice_failure`, `coop_coep_violation`, `subresource_integrity_violation` are correctness mid-tier — above SEO, below network errors.

Insertion order:

```ts
// (existing kinds up through xss_stored)
'race_condition_double_submit',
'race_condition_optimistic_revert',
'race_condition_interleaved_mutations',
'race_condition_cross_tab',
'race_condition_click_navigate',
'trusted_types_violation',          // ← v0.36, above network_5xx (peer-to-xss confidence)
'web_worker_error',                 // ← v0.36
'iframe_postmessage_unguarded',     // ← v0.36
'service_worker_stale',             // ← v0.36
'network_5xx',
// (...existing pen-test + idor + auth kinds...)
'permission_denied_unhandled',      // ← v0.36
'webrtc_ice_failure',                // ← v0.36
'coop_coep_violation',              // ← v0.36
'subresource_integrity_violation',  // ← v0.36
// (...existing dom_error_text, visual_anomaly, etc...)
'shadow_dom_a11y_violation',        // ← v0.36, peer to axe_color_contrast_strong
// (...remaining a11y / SEO / perf ...)
```

### 4.3 Cluster signature additions (`packages/cli/src/cluster/signature.ts`)

```ts
case 'service_worker_stale': {
  const ctx = detection.browserPlatformContext;
  const scope = ctx?.kind === 'sw' ? ctx.scope : '';
  return `service_worker_stale|${detection.pageRoute ?? ''}|${scope}`;
}
case 'web_worker_error': {
  const ctx = detection.browserPlatformContext;
  const scriptUrl = ctx?.kind === 'worker' ? ctx.scriptUrl : '';
  const evt = ctx?.kind === 'worker' ? ctx.eventKind : '';
  return `web_worker_error|${scriptUrl}|${evt}`;
}
case 'iframe_postmessage_unguarded': {
  const ctx = detection.browserPlatformContext;
  const fps = ctx?.kind === 'iframe' ? ctx.handlerFingerprints.slice(0, 1).join(',') : '';
  return `iframe_postmessage_unguarded|${detection.pageRoute ?? ''}|${fps}`;
}
case 'shadow_dom_a11y_violation': {
  const ctx = detection.browserPlatformContext;
  const host = ctx?.kind === 'shadow_a11y' ? ctx.hostSelector : '';
  const rule = ctx?.kind === 'shadow_a11y' ? ctx.axeRuleId : '';
  return `shadow_dom_a11y_violation|${detection.pageRoute ?? ''}|${host}|${rule}`;
}
case 'permission_denied_unhandled': {
  const ctx = detection.browserPlatformContext;
  const perm = ctx?.kind === 'permission' ? ctx.permission : '';
  return `permission_denied_unhandled|${detection.pageRoute ?? ''}|${perm}`;
}
case 'webrtc_ice_failure': {
  return `webrtc_ice_failure|${detection.pageRoute ?? ''}`;
}
case 'subresource_integrity_violation': {
  const ctx = detection.browserPlatformContext;
  const url = ctx?.kind === 'sri' ? ctx.blockedUrl : '';
  return `subresource_integrity_violation|${detection.pageRoute ?? ''}|${url}`;
}
case 'coop_coep_violation': {
  return `coop_coep_violation|${detection.pageRoute ?? ''}`;
}
case 'trusted_types_violation': {
  const ctx = detection.browserPlatformContext;
  const directive = ctx?.kind === 'trusted_types' ? ctx.sample.slice(0, 40) : '';
  return `trusted_types_violation|${detection.pageRoute ?? ''}|${directive}`;
}
```

Cluster-key strategy: per-pageRoute by default (browser-platform kinds are page-bound), with the most-distinguishing inner field on each (worker scriptUrl, host selector + rule, blocked URL) so the same bug across two pages still clusters distinctly when the implementation actually differs, and unifies when it doesn't.

### 4.4 Flakiness handling

Browser-platform findings are mostly deterministic (state inspection). Two are timing-sensitive:
- `service_worker_stale` — depends on having visited the same scope twice in a run; not flaky per se, but absent on first visit.
- `webrtc_ice_failure` — ICE handshake timing varies; the 1.5s observation window is a balance. If the ICE state is `'checking'` or `'connecting'` at harvest, the connection isn't yet failed → no finding (not a false negative either; it just isn't a confirmed failure).

Default `consensusRuns: 1` for all v0.36 kinds (single observation is sufficient for the state-inspection kinds; ICE-failure flakes are filtered by the explicit-state check). Users can override via the global re-run-for-flakes mechanism.

---

## 5. DOM-walker shadow-tree extension

### 5.1 Open shadow only

`element.shadowRoot` returns `null` for `mode: 'closed'`. We never see closed roots; this is a deliberate developer privacy boundary, and the spec respects it. Closed-root host elements still appear in the light-DOM walk; we just don't descend.

### 5.2 Selector format

The collected `Element.selector` for shadow-tree elements uses the format `<hostSelector> >>> <innerSelector>` (Playwright shadow-piercing syntax). This is the format the camofox snapshot resolver already supports for snapshot-based clicks. Elements without a unique attribute inside a shadow root fall back to a shadow-root nth-of-type selector relative to the host.

### 5.3 Performance

The DOM walk currently does one `document.querySelectorAll(sel)` per selector; with shadow-tree descent it does N+1 (one per discovered open shadow root). Empirically, design-system apps (Material Web, Lit-based libraries) have 5-50 shadow hosts per page — overhead < 50ms per page. Acceptable.

### 5.4 axe inside shadow trees

axe-core 4.x descends shadow roots automatically when given a `document` context. The v0.6 baseline already captures shadow violations IF axe is at 4.x — verify the pinned version. If a violation is captured by the light-DOM axe pass AND ALSO by the shadow-DOM-only pass, the shadow finding is suppressed (de-dupe by `(axeRuleId, target)` first-seen-wins).

### 5.5 No descent into iframes

Cross-origin iframes throw `SecurityError` on `contentDocument` access. Same-origin iframes COULD be descended, but v0.36 explicitly does NOT — iframes are a separate test surface (handled by `iframe_postmessage_unguarded`), and in-frame DOM walks would multiply page-walk time. Defer to v0.37 if needed.

---

## 6. Type additions (`packages/cli/src/types.ts`)

```ts
export type BrowserPlatformContext =
  | { kind: 'sw'; scope: string; ageMs: number; hasInstalling: boolean; hasWaiting: boolean }
  | { kind: 'worker'; scriptUrl: string; eventKind: 'error' | 'messageerror'; errorMsg: string }
  | { kind: 'iframe'; listenerCount: number; handlerFingerprints: string[] }
  | { kind: 'shadow_a11y'; hostSelector: string; axeRuleId: string; severity: 'critical' | 'serious' }
  | { kind: 'permission'; permission: string; mode: 'passive' | 'forced'; uiErrorVisible: boolean; consoleErrorCount: number }
  | { kind: 'webrtc'; connectionId: string; finalState: string; hadHandler: boolean }
  | { kind: 'sri'; blockedUrl: string; hasIntegrityAttr: number; uiErrorVisible: boolean }
  | { kind: 'coop_coep'; crossOriginIsolated: boolean; sabReferenced: boolean; sabInstantiated: boolean }
  | { kind: 'trusted_types'; sample: string; blockedURI: string; source: 'dynamic' | 'static_innerhtml' };

// Add to BugDetection
export type BugDetection = { /* ...existing... */
  browserPlatformContext?: BrowserPlatformContext;
};

export type BrowserPlatformConfig = {
  enabled?: boolean;                    // default: true if any other detection is on
  swStaleThresholdMs?: number;          // default: 60_000
  observationWindowMs?: number;         // default: 1500
  permissions?: ReadonlyArray<'geolocation' | 'clipboard-read' | 'notifications'>; // default: all three
  enableShadowA11y?: boolean;           // default: true (gated on enableA11y)
  enableForcedPermissionDeny?: boolean; // default: false
};

export type BrowserPlatformTelemetry = {
  pagesProbed: number;
  detectionsByKind: Record<string, number>;  // 'service_worker_stale': 2, ...
  shadowHostsDiscovered: number;
  workersInstrumented: number;
  rtcConnectionsObserved: number;
  permissionsForceDenied: number;
  bootstrapInstallFailures: number;
};

// Add to BugHunterConfig
export type BugHunterConfig = { /* ...existing... */
  browserPlatform?: BrowserPlatformConfig;
};

// Add to RunSummary
export type RunSummary = { /* ...existing... */
  browserPlatform?: BrowserPlatformTelemetry;
};
```

---

## 7. CLI / config interface

### 7.1 New config block (`packages/cli/src/config.ts`, Zod)

```ts
const BrowserPlatformConfigSchema = z.object({
  enabled: z.boolean().optional(),
  swStaleThresholdMs: z.number().int().positive().optional(),
  observationWindowMs: z.number().int().positive().min(100).max(10_000).optional(),
  permissions: z.array(z.enum(['geolocation', 'clipboard-read', 'notifications'])).optional(),
  enableShadowA11y: z.boolean().optional(),
  enableForcedPermissionDeny: z.boolean().optional(),
}).strict();

// Add to BugHunterConfigSchema
browserPlatform: BrowserPlatformConfigSchema.optional(),
```

### 7.2 CLI flags (`packages/cli/src/cli/run.ts`)

```
--browser-platform                    # enable (overrides config.browserPlatform.enabled = false)
--no-browser-platform                 # disable (overrides config.browserPlatform.enabled = true)
--browser-platform-force-deny         # opt-in to forced-permission-deny path
--browser-platform-sw-stale-ms <ms>   # override threshold
```

Gating order: CLI flag > config > default.

### 7.3 Telemetry block in `summary.json` (`packages/cli/src/phases/emit.ts`)

```json
{
  "browserPlatform": {
    "pagesProbed": 14,
    "detectionsByKind": {
      "shadow_dom_a11y_violation": 3,
      "iframe_postmessage_unguarded": 1
    },
    "shadowHostsDiscovered": 27,
    "workersInstrumented": 2,
    "rtcConnectionsObserved": 0,
    "permissionsForceDenied": 0,
    "bootstrapInstallFailures": 0
  }
}
```

---

## 8. Edge cases (false-positive sources especially)

### EC-1. `service_worker_stale` on first visit
First visit to a SW scope cannot show staleness — the install has just happened. The probe stamps `localStorage[__bh_sw_${scope}__]` with `{ registeredAt: Date.now() }` and checks it on subsequent visits. Within a single BugHunter run, ≥ 2 visits to the same scope is rare but happens (multi-role smoke). On second visit, if `Date.now() - registeredAt > swStaleThresholdMs` AND a waiting/installing worker is still present AND `controllerchange` never fired → finding. Across runs, the `localStorage` stamp persists (camofox profile reuse) and may produce a finding on first visit of a later run — which is correct: the SW WAS stale across run boundaries. Document.

### EC-2. Legitimate slow SW install (large precache)
Workbox apps with large precaches genuinely take 30-60s on slow networks. The default 60s threshold accommodates; users on fast localhost may want `swStaleThresholdMs: 10_000`. Document.

### EC-3. Forced-permission-deny corrupts subsequent test execution
Forcing a denial on `notifications` flips the persistent permission state for the BrowserContext until reset. If `resetPolicy === 'per-run'`, a forced-deny in baseline contaminates every subsequent test. **Guard:** forced-deny is gated behind `--browser-platform-force-deny` AND emits a validate-phase warning when paired with `resetPolicy: 'per-run'`. Recommended pairing: `resetPolicy: 'per-test'` or `'per-page'`.

### EC-4. Worker spawned by inline `<script>` running pre-bootstrap
Bootstrap installs after navigate completes; an inline-script `new Worker('...')` at the very top of the page may run before the bootstrap. Such workers are missed for error capture. Mitigation: documented limitation. Real impact: small — most apps lazy-instantiate workers post-React-hydrate. v0.37 will use `addInitScript` once camofox supports it (§ 11).

### EC-5. `messageerror` from structured-clone failure
A `messageerror` event fires when a posted message can't be deserialised (e.g., SharedArrayBuffer over a non-isolated boundary). This is real-bug-class but distinct from a generic worker exception. Both surface under the same `web_worker_error` BugKind with `eventKind: 'messageerror'` distinguishing.

### EC-6. Postmessage handler is heavily minified
Static lint regex `/event\.origin/` fails when the handler is `function(e){if(e.o!==t)return;...}`. False negative. Confidence score `'low'` on handler sources < 80 chars. Documented; users with strict CI can opt out via `iframe_postmessage_unguarded` suppression.

### EC-7. SW scope is cross-origin
A page may register a SW under `/api` while running at `/`. Both scope and controllerUrl are resource-URL strings; we cluster on scope. Cross-origin SWs (different `origin`) require a separate `navigator.serviceWorker.getRegistrations()` call — but cross-origin SW registration is a security violation and won't fire from our test page. Skip.

### EC-8. Postmessage handler uses CSP frame-ancestors instead of explicit guard
Some apps lock down via `frame-ancestors` CSP and don't add an in-handler origin check. The handler is genuinely safe. False positive. Mitigation: confidence `'low'` AND the cluster-signature de-dupes per page so users see one finding to suppress, not many.

### EC-9. axe-core version doesn't traverse shadow boundaries
Verify `axe-core@4.x` is the pinned version (4.0+ has shadow-tree support). If older, the shadow-DOM probe re-injects axe-core into shadow context separately. Pin in `package.json` and assert at install.

### EC-10. Web Component re-renders mid-axe-run
Lit/Stencil components can re-render on attribute changes; if axe runs against a tree that mutates during the scan, results may be partial. Mitigation: serial axe runs (one per shadow root, awaited), no parallelism.

### EC-11. Notifications API in Firefox-headless
Some browsers don't expose `Notification` in headless mode; treat as `permission === 'unknown'` and skip the forced-deny.

### EC-12. WebRTC SDK wrapper registers handlers internally
Twilio / Daily.co SDK wrappers register `iceconnectionstatechange` inside their own constructor. Our wrapper sees the SDK's `addEventListener` call → `hadHandler = true` → suppresses the finding correctly even though the app code doesn't directly subscribe.

### EC-13. Page never instantiates RTC
No connections in `envelope.webrtc.connections` → no findings. Not a skip — there's just no signal. Correct silence.

### EC-14. SRI block by browser cache eviction race
Rare. Debounce: only emit if the same `url` is blocked AND referenced in the page's `<head>` AND the page is interactive at +1s. Cuts false positives on transient cache misses.

### EC-15. SRI fallback intentional (`<link onerror>` → CDN swap)
The app is functioning, but the user gets the fallback resource silently. We emit because "no UI error" combined with a blocked primary resource is still a bug — the user can't tell what they got. Severity `'medium'`.

### EC-16. SAB referenced behind feature-detect try/catch
Library probes `'SharedArrayBuffer' in window` but never instantiates because `crossOriginIsolated === false`. The optimised code path is unreachable. Real bug, but lower severity (`'medium'`) since the library has a fallback.

### EC-17. Trusted Types violation IS the prevention working
Every `securitypolicyviolation` of `effectiveDirective === 'require-trusted-types-for'` is a real DOM-XSS attempt being blocked. Even one violation means there's app code that touches user input without going through a Trusted Types policy — that's a bug to fix, even if the violation prevented exploitation. Emit each unique `(blockedURI, sample)` as a finding.

### EC-18. Probe runs on a route that lacks shadow DOM, workers, RTC, etc.
Most pages will have zero `BrowserPlatformContext` findings. The probe still installs the bootstrap and runs the harvest — overhead per page is ~1.5s + 1 evaluate round-trip. Gate the probe behind `enabled === true` and don't run on routes the user excluded via `excludePages`.

### EC-19. Closed shadow root hosting a critical violation
Closed shadow roots are invisible to `host.shadowRoot`. We respect the developer's privacy boundary. Documented limitation: a component library that uses closed shadow can hide a11y bugs from us. Recommend the user run `--a11y-strict` against the component library's standalone test harness, not the consuming app.

### EC-20. `bootstrapInstallFailures` due to CSP `unsafe-eval` blocking proxy construction
On apps with strict CSP, `new Proxy(...)` may be blocked. The bootstrap returns `{installed: false, reason: 'csp_blocked'}` and the run continues; affected probes report no findings on that page. Telemetry counts the failure.

---

## 9. Test plan

### 9.1 Unit tests

| File | Tests |
|---|---|
| `packages/cli/src/discovery/browser-platform-probe.test.ts` | (a) bootstrap-install round-trips with fixture envelope; (b) classify maps each envelope shape to expected detections; (c) shadow-a11y de-dupe against light-DOM axe; (d) postmessage static-lint regex on 6 sample handler shapes (3 guarded, 3 unguarded); (e) SW staleness across two `registeredAt` snapshots; (f) RTC `failed` AND `hadHandler` matrix (4 combos). |
| `packages/cli/src/discovery/dom-walker.test.ts` | Shadow-DOM descent collects elements behind `<my-component>`; closed shadow is skipped; selector format includes `>>>` token. |
| `packages/cli/src/cluster/signature.test.ts` | One assertion per new BugKind. |
| `packages/cli/src/phases/classify.test.ts` | New kinds are present in `KIND_PRIORITY` at expected indices. |
| `packages/cli/src/config.test.ts` | `browserPlatform` block parses; defaults applied; unknown keys rejected (`.strict()`). |

### 9.2 Synthetic fixture (`fixtures/browser-platform-bad/`)

A minimal Express + vanilla-JS app with one route per BugKind:

| Route | Bug |
|---|---|
| `/sw-stale` | Registers a SW that never calls `skipWaiting()`; `swStaleThresholdMs` is set low (2s) for the smoke. |
| `/worker-error` | Spawns a `Worker` that throws on first message. |
| `/iframe-unguarded` | Adds `addEventListener('message', e => eval(e.data))` (no origin check). |
| `/shadow-bad-contrast` | A `<custom-button>` web component with white-on-white text inside its open shadow root. |
| `/perm-denied` | Calls `navigator.geolocation.getCurrentPosition(...)`, no error path. |
| `/webrtc-fail` | Instantiates `RTCPeerConnection` with bogus ICE servers, no `iceconnectionstatechange` handler. |
| `/sri-block` | `<script integrity="sha256-WRONGHASH" src="...">`. |
| `/coop-coep-bad` | Uses `new SharedArrayBuffer(8)`, served WITHOUT COOP/COEP headers. |
| `/trusted-types-violate` | CSP `require-trusted-types-for 'script'`, JS does `el.innerHTML = userInput`. |

### 9.3 Integration smoke (`tests/integration/browser-platform-smoke.test.ts`)

End-to-end: spin up the fixture, run BugHunter with `--browser-platform`, assert ≥1 finding per BugKind. Visit `/sw-stale` twice within the run.

### 9.4 Regression: non-platform routes

Routes in existing fixtures that have no platform surface produce zero `browser_platform_*` findings. No false positives on `fixtures/race-bad/`, `fixtures/auth-good/`, the v0.6 SEO fixture.

### 9.5 Real-app smoke

Aspectv3 (no SW, has shadow DOM via Material UI light wrappers), TraiderJo (has SW for offline), with `--browser-platform`. Expected:
- Aspectv3: ≤ 2 findings, manually triaged. ≥ 1 must be a real bug or recommended hardening (e.g., postmessage handler in OAuth flow).
- TraiderJo: ≤ 4 findings; at minimum, a `service_worker_stale` if revisit fires twice.

---

## 10. Files to touch / add

### 10.1 Files to create

| File | Why |
|---|---|
| `packages/cli/src/discovery/browser-platform-probe.ts` | Probe entrypoint, bootstrap script, harvest, classifier. ~280 LoC. |
| `packages/cli/src/discovery/browser-platform-probe.test.ts` | Unit tests (§ 9.1). |
| `fixtures/browser-platform-bad/` | Synthetic fixture (§ 9.2). |
| `fixtures/browser-platform-bad/server.js` | Express server with one route per kind. |
| `fixtures/browser-platform-bad/sw.js`, `worker.js`, `index.html`, `*.html` | Per-route artefacts. |
| `tests/integration/browser-platform-smoke.test.ts` | E2E smoke (§ 9.3). |

### 10.2 Files to modify

| File | Change |
|---|---|
| `packages/cli/src/types.ts` | Add 9 BugKinds; add `BrowserPlatformContext`, `BrowserPlatformConfig`, `BrowserPlatformTelemetry`; add `browserPlatformContext?` to `BugDetection`; add `browserPlatform?` to `BugHunterConfig`; add `browserPlatform?` to `RunSummary`; add `shadowHost?: string` to `Element`. |
| `packages/cli/src/discovery/dom-walker.ts` | Extend `COLLECT_ELEMENTS_SCRIPT` with `walkRoots` (§ 5); update `RawEvalResult` and `shapeFromEvalResult`; add `shadowHost` field. |
| `packages/cli/src/phases/classify.ts` | Add 9 entries to `KIND_PRIORITY` (§ 4.2). |
| `packages/cli/src/cluster/signature.ts` | Add 9 `case` arms (§ 4.3). |
| `packages/cli/src/config.ts` | Add `browserPlatform` Zod block (§ 7.1). |
| `packages/cli/src/cli/run.ts` | Wire `--browser-platform`, `--no-browser-platform`, `--browser-platform-force-deny`, `--browser-platform-sw-stale-ms` (§ 7.2). |
| `packages/cli/src/phases/execute.ts` | In `onPageBaseline`, after axe block, call `runBrowserPlatformProbe` if enabled; collect detections into `browserPlatformDetections`. Merge into emit pipeline. |
| `packages/cli/src/phases/emit.ts` | Populate `summary.browserPlatform` telemetry (§ 7.3). |
| `packages/cli/src/phases/validate.ts` | Add `enableForcedPermissionDeny + resetPolicy === 'per-run'` warning. |
| `packages/cli/src/cluster/signature.test.ts` | New cluster-signature tests. |
| `packages/cli/src/discovery/dom-walker.test.ts` | Shadow-tree descent test. |

---

## 11. Negative requirements

- Do **not** add a tenth BugKind in v0.36. Each kind ships with a dedicated detector, fixture route, cluster signature, priority slot. Extra kinds (Web Push, FS Access, WebUSB) come in v0.37 once the v0.36 framework is validated.
- Do **not** change the shape of `BugDetection` beyond adding `browserPlatformContext?`. The existing `headerContext` / `raceContext` patterns are precedent.
- Do **not** introduce a runtime dependency for shadow-DOM piercing. The DOM walker uses Playwright's `>>>` syntax via the existing snapshot resolver.
- Do **not** block the axe-core version bump. The probe is gated on whether the page has axe loaded — same condition as v0.6.
- Do **not** re-enable forced-permission-deny by default. The default is OFF; users opt in when they understand the resetPolicy implication.
- Do **not** wrap platform constructors at the camofox-server level. The bootstrap installs at `evaluate` time so it's per-tab and removable; a server-level wrapper would leak across tabs and bug other features.
- Do **not** ship without the synthetic fixture. The fixture is the calibration baseline (§ 9.2) — without it, regressions on a real app can't be triaged against ground truth.
- Do **not** count first-visit SW absence as a finding. SW staleness requires re-visit; first-visit is silence (§ EC-1).
- Do **not** fan out the probe to every action. Per-pageRoute baseline only.
- Do **not** include `closed`-mode shadow roots. Privacy boundary; never traverse.
- Do **not** request real device permissions (mic, camera, USB). v0.36 forces denials only.

---

## 12. Risks + escape hatches

- **Per-page overhead.** The probe adds ~1.5s observation window + 1-2 evaluate round-trips per pageRoute. For a 50-route app, that's ~75s additional. Mitigation: probe is per-pageRoute (not per-test); pages with no platform surface return early in `runBrowserPlatformProbe` after a single capability check. `--no-browser-platform` disables the entire pass. Time-boxed by the global `--budget`.
- **CSP-strict apps blocking the bootstrap.** Apps with `script-src 'self'` will refuse the probe's eval'd Proxy installation. Bootstrap returns `{installed: false}` and the page's findings are skipped (telemetry counts the skip). Documented; not a blocker.
- **Camofox v0.1 lacks `addInitScript`.** Without init-scripts, the bootstrap installs AFTER navigate completes — workers/SWs created in the first ms after navigate are missed. Risk is small (most apps lazy-instantiate), and v0.37 + a camofox patch (§ 12.1) closes the gap.
- **False-positive flood on apps with many open shadow roots and a single pre-existing a11y bug.** Each shadow root that hosts the same component re-emits the same axe rule. The cluster-signature includes `hostSelector` which de-dupes per host pattern, but design systems with 30+ identical buttons surface 30 cluster keys. Mitigation: cluster-signature on the **component-tag-name** part of the host selector instead of the full unique selector. Add a normalizer `hostTagNameOf(hostSelector)` and use that in the cluster key.
- **Forced-permission-deny side effects.** Documented (EC-3); guarded by validate-phase warning.

### 12.1 Optional camofox follow-up (deferred to v0.37)

Add a `/tabs/:tabId/init-script` POST route to camofox-browser/server.js:
```js
app.post('/tabs/:tabId/init-script', async (req, res) => {
  const { script } = req.body;
  const tab = getTab(req.params.tabId);
  await tab.context.addInitScript(script);
  res.json({ ok: true });
});
```
Plus a corresponding `addInitScript(script)` method on `BrowserMcpAdapter`. Rolling this in lets the bootstrap install BEFORE navigate, capturing first-paint workers and SWs. v0.36 ships without this; v0.37 closes the gap.

---

## 13. Acceptance criteria

| Criterion | Verifier |
|---|---|
| All new unit tests pass | `npm test -- browser-platform` |
| Synthetic fixture produces ≥1 finding per BugKind | `npm test -- tests/integration/browser-platform-smoke` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Shadow-DOM walk descends open roots; closed roots skipped | `npm test -- dom-walker` (new shadow test) |
| `summary.json.browserPlatform.detectionsByKind` populated when enabled | `jq '.browserPlatform' summary.json` |
| `--no-browser-platform` disables the probe | CLI test asserting telemetry block is absent |
| `--browser-platform-force-deny` requires opt-in; warns when paired with `resetPolicy: 'per-run'` | validate-phase unit test |
| Cluster signatures distinct per (pageRoute, distinguishing-attr) | `signature.test.ts` |
| Existing v0.6 axe baseline produces same findings on non-shadow routes (no regression) | regression run on `fixtures/a11y-bad/` |
| First-visit SW does NOT emit `service_worker_stale` | smoke against `fixtures/browser-platform-bad/sw-stale` first visit |
| `web_worker_error` distinguishes `error` vs `messageerror` in cluster key | unit test |
| Probe overhead < 2.5s per pageRoute on idle page | integration timing assertion |
| Probe is gated by `browserPlatform.enabled` (default true if any other detection enabled) | config test |
| Bootstrap install failure does NOT crash the run; counts in telemetry | unit test (csp-blocked mock) |

---

## 14. Definition of done

- All files in § 10 created/modified.
- Synthetic fixture `fixtures/browser-platform-bad/` boots with `npm run dev` and serves all 9 routes.
- `bughunter run --browser-platform` against the fixture produces ≥ 9 findings (one per kind), each with the expected `browserPlatformContext.kind`.
- The fixture is committed; a README in `fixtures/browser-platform-bad/` documents the bug per route.
- `summary.json.browserPlatform` is present in every run with `--browser-platform`.
- The 9 new BugKinds appear in `KIND_PRIORITY` and `clusterSignature` at the documented positions.
- `Element.shadowHost` is populated for at least one element in the synthetic fixture run (verifiable in `actions.jsonl`).
- Verification suite (tsc, eslint, vitest, build) is clean.
- `dom-walker.ts` no longer ignores open shadow roots — verified by added unit test.
- `--browser-platform-force-deny` is wired and tested but defaults OFF.
- The killer-demo runbook (§ 15) reproduces all 9 findings.

---

## 15. Killer-demo runbook

```bash
# 1. Synthetic fixture
cd /root/BugHunter
npm run build
npm test -- tests/integration/browser-platform-smoke
# Expect ≥1 finding per BugKind, total ≥9.

# 2. Inspect the cluster shape
RUN=$(ls -t fixtures/browser-platform-bad/.bughunter/runs/ | head -1)
jq '.byKind | with_entries(select(.key | startswith("service_worker") or startswith("web_worker") or startswith("iframe_postmessage") or startswith("shadow_dom") or startswith("permission_denied") or startswith("webrtc") or startswith("subresource") or startswith("coop") or startswith("trusted_types")))' \
   fixtures/browser-platform-bad/.bughunter/runs/$RUN/summary.json

# 3. Verify shadow-DOM walk
jq '.elements | map(select(.shadowHost != null)) | length' \
   fixtures/browser-platform-bad/.bughunter/runs/$RUN/discovery/elements.json
# Expect > 0 — at least one element collected from inside an open shadow root.

# 4. Aspectv3 opt-in
cd /root/Aspectv3
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --browser-platform --max-bugs 100 --budget 1500000

# 5. TraiderJo opt-in (SW stale candidate)
cd /root/TraiderJo
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --browser-platform --browser-platform-sw-stale-ms 30000 --max-bugs 100 --budget 1500000
```

---

## 16. Open questions

1. **Should `service_worker_stale` ship in v0.36 given the first-visit caveat?** The detector requires re-visit data. Most BugHunter runs visit each pageRoute once. We could defer this kind to v0.37 once cross-run state persistence (Phase D) is in place. Recommendation: **ship**, with the documented "second-visit only" semantics — multi-role smokes already revisit, and the localStorage stamp persists across runs in the same camofox profile.

2. **Postmessage handler static-lint or runtime probe?** The current spec lints the handler's source via `Function.prototype.toString` regex. A runtime probe — sending a synthetic `MessageEvent` from the parent window with a known-bad origin and checking whether the handler executes — is more reliable but requires firing at least one `postMessage` and risks side-effects (the handler may navigate, mutate state, or post-back). Recommendation: stay static-lint for v0.36; runtime probe is v0.37 with explicit opt-in.

3. **Should `shadow_dom_a11y_violation` be a separate BugKind or a flag on the existing `accessibility_critical`?** Current design separates: shadow violations have a different fix shape (you change the component, not the page) and warrant their own cluster. Counterpoint: a triager seeing two BugKinds for "the same kind of problem" may suppress one and miss the other. Recommendation: keep separate; document the relationship in the BugKind glossary (out of scope for v0.36 spec).

4. **Cluster signature on full host selector vs component tag name?** § 12 flags the false-positive risk with full selectors. Should we normalise to tag name only (e.g. `my-button`) for the cluster key? Recommendation: yes, add `hostTagNameOf(hostSelector)` and use it in the cluster key. If the same component is broken in multiple instances on the same page, that's ONE bug to fix — not N.

5. **`coop_coep_violation` static SAB-scan or runtime-only?** Static script-text scan is heuristic-prone (a string `'SharedArrayBuffer'` in a comment fires the lint). Runtime-only (constructor proxy) misses reference-without-instantiation cases. Recommendation: emit only on **either** runtime instantiation OR a `'SharedArrayBuffer'` token AND `crossOriginIsolated === false`; if only the static-text token is present without instantiation, severity `'medium'`; if instantiation observed, severity `'high'`.

6. **`trusted_types_violation` static `innerHTML` scan reliability.** A loaded inline-script source-text scan for `\.innerHTML\s*=` is fragile (minified code, variable assignment to a variable then `.innerHTML`). Recommendation: ship the dynamic CSP-event path as the primary signal; the static path is supplementary, severity `'low'` when alone, `'high'` when paired with a dynamic violation.

7. **Should the bootstrap be hoisted to camofox via `addInitScript` in v0.36 or v0.37?** Hoisting eliminates the "bootstrap installs after navigate" gap. v0.36 ships without it (camofox v0.1 limitation). v0.37 spec already pencils it in (§ 12.1). Risk of deferring: workers spawned in the first ms post-navigate are missed. Recommendation: defer to v0.37; document the limitation in the v0.36 README; track findings missed by `bootstrapInstallFailures` telemetry.

8. **Permission-deny: per-pageRoute or per-run?** Forcing a deny on `notifications` is a context-wide state change. Doing it once per run is enough for a true positive (the app's response to a denial doesn't depend on which page issued the call). Per-pageRoute is the current spec; consider downgrading to per-run with the result attached to a synthetic `pageRoute === '__browser_platform__'` for clarity. Recommendation: keep per-pageRoute for now; reassess once Aspectv3 / TraiderJo runs show real false-positive rates.
