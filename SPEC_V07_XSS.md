# SPEC — v0.7 XSS (reflected + DOM)

**Status:** Draft 1, ready for @coder · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** v0.5 (`SPEC_V05_SECURITY_HYGIENE.md`, shipped via PR A + PR B; gaps patched in `SPEC_V05_PR_B_GAPS.md`).

This spec defines two new BugKinds — `xss_reflected` and `xss_dom` — and the cross-cutting **InjectionPalette** infrastructure that powers them. The user mandate is "the most comprehensive scanner on the planet." We hit it not by adding payload variety alone, but by wiring **active probing into existing test surfaces (forms + URL params + JSON request bodies)** with deterministic detection criteria and a sandboxed observation channel.

The XSS spec lands as a single PR `feat/v07-xss` with three tasks. The auth-flow spec (`SPEC_V07_AUTH_FLOWS.md`) ships as its own PR. Track 4 (XSS) and Track 5 (auth flows) are independent; either can land first.

---

## 1. Objective

Detect reflected XSS and DOM-based XSS during the existing execute phase by injecting **canary payloads** into form fields, URL query parameters, and (where the planner produces them) JSON request body fields, then observing whether the canary either renders unescaped in the response HTML (`xss_reflected`) or executes script in the browser DOM (`xss_dom`).

The detector is **active, not heuristic**: a finding fires only when a uniquely-tagged canary payload appears in a position where it would be parsed as script or markup. No "looks like it might be vulnerable" findings.

**In scope:**
- `xss_reflected` — canary appears unescaped in the response body of the same request that planted it.
- `xss_dom` — canary executes in the browser DOM (any sink: `innerHTML`, `document.write`, `eval`, attribute setter, `javascript:` URL navigation).
- Form-field injection, URL-param injection, JSON-body injection.
- Per-tool / per-form / per-URL-param cluster signatures.
- A `xss_stored` placeholder cluster signature so v0.8 can light up stored XSS without a schema migration.

**Out of scope (deferred):**
- `xss_stored` — requires a multi-step inject-then-fetch protocol; v0.8.
- `xss_blind` — requires an exfiltration callback (DNS or HTTP); v1.0.
- AngularJS expression injection (`{{constructor.constructor(...)}}` style); v0.9.
- Mutation XSS (mXSS) where parser quirks defeat sanitisers; v1.1.
- Polyglot payloads — v0.7 ships a finite palette; we expand later.

**Killer-demo target:**
- TraiderJo demo: at least one `xss_reflected` or `xss_dom` finding on a synthetic test page. Real TraiderJo may not be vulnerable (it uses React, which auto-escapes). The demo is a *negative-control* validator AND a synthetic-injection-point validator: we land a fixture page in the test suite that intentionally renders unsanitised HTML; the run fires the detection on the fixture; on the production app it does not.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | Add `BugKind` `xss_reflected`, `xss_dom`, `xss_stored` (placeholder); add `XssContext` to `BugDetection`. |
| `packages/cli/src/phases/execute.ts` | Both `executeApiTest` and `executeUiTestInner` need the injection hook. **Do not** create a parallel "xss execute phase" — XSS rides on the existing test cases. |
| `packages/cli/src/phases/plan.ts` | The planner produces `TestCase` objects with `palette` variants. XSS adds a new palette variant or a new `injectionPalette` field — TBD in § 3.3. |
| `packages/cli/src/mutation/apply.ts` | Where form / API test cases are minted today. New helper `xssTestCases` lives here. |
| `packages/cli/src/cluster/signature.ts` | New cluster-signature cases for the two kinds. |
| `packages/cli/src/phases/classify.ts` | XSS kinds slot into `KIND_PRIORITY` between `unhandled_exception` and `idor_horizontal` — they are **always critical** when they fire because the canary is unique. |
| `packages/cli/src/security/header-probe.ts` | The probe pattern: pure analysis function + side-effecting probe runner. Mirror this pattern for XSS. |
| `packages/cli/src/adapters/browser-mcp.ts` | `scope.evaluate(...)` is the channel for DOM-XSS detection. Read `evaluate`'s contract before writing the canary observer. |
| `packages/cli/src/discovery/dom-walker.ts` | Forms and inputs are already collected here. Reuse the form structure; do not re-walk. |
| `packages/cli/src/repro/action-log.ts` | XSS tests still emit action logs; the canary value goes into `input` field. |

### 2.2 Patterns to follow

- **Canary-with-id**: every payload includes a 16-char hex nonce so detection is unambiguous. Two canaries from two test cases never collide.
- **Active observation**: `xss_dom` uses a pre-execute browser hook that installs a `MutationObserver` listening for any DOM node containing the canary; if such a node is found and is a `<script>` element OR has an `on*` attribute carrying the canary, fire.
- **Cluster signature stability**: `xss_reflected|<route>|<paramName>` — one cluster per (route, param) pair. Two payloads against the same param collapse.

### 2.3 DO NOT

- **Do not** write payloads to disk. Canaries are generated per-test, never persisted.
- **Do not** introduce a third HTML parser. Reuse the regex-based response-body match pattern from `header-probe.ts`'s `analyzeResponseBody`.
- **Do not** introduce a new browser adapter method. Use `scope.evaluate` for DOM observation.
- **Do not** generate payloads from the LLM. The palette is finite and version-pinned (§ 3.2).
- **Do not** disable React/Vue/Angular's built-in escapers; we test the production code path, not a forced-vulnerable one.
- **Do not** alter `MUTATION_OBSERVER_START_SCRIPT` — extend it via a separate `XSS_OBSERVER_START_SCRIPT` constant.

---

## 3. Cross-cutting infrastructure

### 3.1 Module: `security/injection-palette` (new)

A pure module that produces canary payloads keyed to a per-test nonce.

**Files to create:**
- `packages/cli/src/security/injection-palette.ts`
- `packages/cli/src/security/injection-palette.test.ts`

**Public API:**

```ts
export type InjectionContext = 'html_body' | 'html_attr' | 'js_string' | 'url_param' | 'json_body';

export type CanaryPayload = {
  /** The literal value to inject. */
  value: string;
  /** 16-char hex nonce embedded in the value. Used for detection. */
  nonce: string;
  /** Which sink shape this payload tests. */
  context: InjectionContext;
  /** Human-readable name for the rootCause string. */
  variant: string;
};

export function generateCanaries(count: 'minimal' | 'full'): CanaryPayload[];
export function buildCanaryRegex(nonce: string): RegExp;
export function canaryAppearsAsHtml(body: string, nonce: string): boolean;
export function canaryAppearsAsAttribute(body: string, nonce: string): boolean;
export function canaryAppearsInScriptTag(body: string, nonce: string): boolean;
```

**Palette (`generateCanaries('minimal')` returns 5 payloads; `'full'` returns 12):**

Minimal (always run):

| variant | context | value template |
|---|---|---|
| `script_tag_basic` | `html_body` | `<script>window.__bh_xss_${nonce}=1</script>` |
| `img_onerror` | `html_body` | `<img src=x onerror="window.__bh_xss_${nonce}=1">` |
| `attribute_breakout` | `html_attr` | `" autofocus onfocus="window.__bh_xss_${nonce}=1` |
| `url_javascript` | `url_param` | `javascript:window.__bh_xss_${nonce}=1` |
| `string_breakout` | `js_string` | `';window.__bh_xss_${nonce}=1;//` |

Full (run when `xss.depth: 'full'`):

Adds: `svg_onload`, `iframe_srcdoc`, `details_ontoggle`, `style_expression`, `meta_refresh`, `data_uri_html`, `template_literal_breakout`.

**Why a small palette?** Payload variety beyond ~12 is OWASP-cargo-cult — it inflates run time without adding coverage. Every additional payload adds 1 HTTP request per (form, role) pair; on a 50-route app with 30 forms the marginal cost is non-trivial. We optimise for **detection deterministic, palette small, contexts complete**.

### 3.2 Module: `security/xss-observer` (new)

A pure constants module exposing the browser-side observer script as a string. Mirrors `MUTATION_OBSERVER_START_SCRIPT` from `classify/state-change.ts`.

**Files to create:**
- `packages/cli/src/security/xss-observer.ts`

**Public API:**

```ts
/** Script that installs a window-level XSS canary tracker. Idempotent.
 *  After eval, window.__bh_xss is a Map<nonce, { fired: boolean; sink: string }>.
 *  Call XSS_OBSERVER_DRAIN_SCRIPT to read the map and clear it. */
export const XSS_OBSERVER_START_SCRIPT: string;
export const XSS_OBSERVER_DRAIN_SCRIPT: string;
```

**Observer implementation (paraphrased; the file contains the literal string):**

```js
(function(){
  if (window.__bh_xss_installed) return;
  window.__bh_xss_installed = true;
  window.__bh_xss = new Map();

  // Sink 1: any window.__bh_xss_<nonce> assignment lands here via Proxy on window.
  // We don't proxy window (compat hazard); instead the canary scripts assign directly,
  // and a periodic sweep migrates them into the Map.
  function sweep() {
    for (const k of Object.keys(window)) {
      if (k.startsWith('__bh_xss_') && k.length > 9) {
        const nonce = k.slice(9);
        if (!window.__bh_xss.has(nonce)) {
          window.__bh_xss.set(nonce, { fired: true, sink: 'window_assign' });
        }
      }
    }
  }
  setInterval(sweep, 100);

  // Sink 2: MutationObserver — flag any inserted <script> with our nonce.
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        const html = node.outerHTML || '';
        const match = html.match(/__bh_xss_([a-f0-9]{16})/);
        if (match) {
          const nonce = match[1];
          if (!window.__bh_xss.has(nonce)) {
            window.__bh_xss.set(nonce, { fired: true, sink: 'dom_inserted' });
          }
        }
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
```

`XSS_OBSERVER_DRAIN_SCRIPT`:

```js
(function(){
  const out = [];
  if (window.__bh_xss instanceof Map) {
    for (const [nonce, info] of window.__bh_xss) {
      out.push({ nonce, fired: info.fired, sink: info.sink });
    }
    window.__bh_xss.clear();
  }
  return out;
})()
```

**Idempotence:** the start script must be safe to call multiple times in the same tab (e.g. when `executeUiTest` runs the same page twice for owner + anon). The `__bh_xss_installed` guard ensures this.

### 3.3 InjectionPalette: how XSS rides into the planner

XSS adds a new `palette` value to the existing `PaletteVariant` union: `'xss_inject'`. (Do **not** add it to `null | happy | edge | out_of_bounds` — those are payload shapes for normal execution. XSS is its own palette because it changes the test's expected outcome from "success" to "expected_failure_but_observe_canary" — but we don't add a new `expectedOutcome` value because the existing `expected_failure` is correct here: a vulnerable app may still 200-OK with the canary echoed.)

**Modify `packages/cli/src/types.ts`:**

```ts
export type PaletteVariant = 'null' | 'happy' | 'edge' | 'out_of_bounds' | 'xss_inject';
```

**Modify `packages/cli/src/mutation/apply.ts`:**

Add `xssFormTestCases(...)` and `xssApiTestCases(...)`. Each takes the same args as the existing helpers but:
- Replaces every text-input field with a canary payload (cycling through variants — one canary per test case).
- Replaces every URL-param-mapped field with the URL-param-context canary.
- Replaces every JSON-body string field with the HTML-body-context canary.

The test case carries the canary nonce in `action.input` so the executor can read it back. To avoid bloating the action log, store the nonce in a new optional field `action.injectionNonce?: string` rather than scraping it from the input on observation.

**Modify `Action`:**

```ts
export type Action = {
  kind: ActionKind;
  selector?: string;
  via: ActionVia;
  expectedOutcome: ExpectedOutcome;
  palette: PaletteVariant;
  toolId?: string;
  input?: unknown;
  /** When set, the test plants this nonce in input and expects no XSS reflection. */
  injectionNonce?: string;
};
```

**Modify `packages/cli/src/phases/plan.ts`:**

Wire the new helpers behind a config flag `config.xss?.enabled` (default `true` once T07 lands). For every form planned in the existing happy-palette pass, mint additional XSS test cases — one per canary variant — at the **same** role.

Cap with `config.xss?.maxTestCases` (default `200`).

### 3.4 Detection wiring

**API path (`executeApiTest`):**
- After `surface_call` returns, if `tc.action.injectionNonce !== undefined`:
  - If `callResult.body` is a string OR an object whose serialised JSON contains the nonce, run the four `canaryAppears*` checks against the serialised body.
  - If any check returns true, emit `xss_reflected` with `xssContext` populated.

**UI path (`executeUiTestInner`):**
- Before the action runs, evaluate `XSS_OBSERVER_START_SCRIPT` (ignore errors silently — but log at `debug`).
- Run the action (which includes typing the canary into a field and clicking submit).
- Capture `postSnapshot.snapshot`.
- If `tc.action.injectionNonce !== undefined`:
  - Run the four `canaryAppears*` checks against the snapshot HTML → if any true, emit `xss_reflected`.
  - Evaluate `XSS_OBSERVER_DRAIN_SCRIPT` → if returned array contains an entry with `nonce === tc.action.injectionNonce && fired === true`, emit `xss_dom` with `xssContext.sink`.

**Both paths:**
- Reflection and DOM observation can both fire on the same test case. Per § 3.5.1 priority hierarchy, `xss_dom` wins (it's a confirmed exec, not just an echo). Reflected becomes a `secondaryObservation`.

### 3.5 Type extensions

Add to `packages/cli/src/types.ts`:

```ts
export type BugKind =
  | /* ...existing... */
  | 'xss_reflected'
  | 'xss_dom'
  | 'xss_stored';   // placeholder; v0.8

export type XssContext = {
  /** The canary variant that fired ('script_tag_basic', etc.). */
  variant: string;
  /** Where the canary was planted. */
  injectionPoint: 'form_field' | 'url_param' | 'json_body';
  /** Field name (form input name, URL param name, JSON key). */
  fieldName: string;
  /** Where the canary appeared / executed. */
  sink: 'reflected_html' | 'reflected_attr' | 'reflected_script' | 'dom_inserted' | 'window_assign';
  /** 16-char nonce for traceability. */
  nonce: string;
};

export type BugDetection = {
  /* ...existing fields... */
  xssContext?: XssContext;
};
```

### 3.6 Cluster signatures

In `packages/cli/src/cluster/signature.ts`, add:

```ts
case 'xss_reflected': {
  const route = detection.endpoint ?? detection.pageRoute ?? '';
  const field = detection.xssContext?.fieldName ?? '';
  return `xss_reflected|${route}|${field}`;
}
case 'xss_dom': {
  const route = detection.pageRoute ?? '';
  const field = detection.xssContext?.fieldName ?? '';
  const sink = detection.xssContext?.sink ?? '';
  return `xss_dom|${route}|${field}|${sink}`;
}
case 'xss_stored':
  // v0.8 placeholder — never fires in v0.7. Kept for cluster-collation forward-compat.
  return `xss_stored|${detection.endpoint ?? ''}|${detection.xssContext?.fieldName ?? ''}`;
```

In `packages/cli/src/phases/classify.ts`, insert into `KIND_PRIORITY` immediately after `'unhandled_exception'`:

```ts
'unhandled_exception',
'xss_dom',         // confirmed JS exec
'xss_reflected',   // confirmed echo
'xss_stored',      // v0.8 placeholder, never fires
'network_5xx',
// ...
```

### 3.7 Config

Add to `packages/cli/src/types.ts`:

```ts
export type XssConfig = {
  /** Master switch. Default: true (opt-out). */
  enabled?: boolean;
  /** Palette depth. Default: 'minimal' (5 payloads). 'full' = 12. */
  depth?: 'minimal' | 'full';
  /** Cap on XSS test cases per run. Default: 200. */
  maxTestCases?: number;
  /** Routes to skip entirely (matched as glob). Default: []. */
  excludedRoutes?: string[];
  /** When true, also mutate JSON request body fields. Default: true. */
  mutateJsonBodies?: boolean;
};

export type BugHunterConfig = {
  /* ...existing... */
  xss?: XssConfig;
};
```

---

## 4. Detection algorithms — pure functions

### 4.1 `canaryAppearsAsHtml(body: string, nonce: string): boolean`

Returns true iff a tag with the canary nonce is present in the body and not inside an HTML-encoded escape. Algorithm:

1. Build regex: `new RegExp(\`<[a-z][^>]*__bh_xss_${nonce}\`, 'i')` — looks for any tag that contains the nonce in its source.
2. Build escape-check: `new RegExp(\`&lt;[^&]*__bh_xss_${nonce}\`, 'i')` — if this matches AND the prior matches, both are true and the prior wins (it's still rendered as a tag somewhere).
3. Return `tagRegex.test(body) === true`.

The escape check is for explainability in the log only; does not affect the boolean.

### 4.2 `canaryAppearsAsAttribute(body: string, nonce: string): boolean`

Returns true iff the canary appears unescaped inside an attribute value such that it could break out. Algorithm:

1. Look for any tag with `on*=` followed by the nonce: `new RegExp(\`<[^>]*\\son[a-z]+\\s*=\\s*["']?[^"'>]*__bh_xss_${nonce}\`, 'i')`.
2. Look for `style=` containing `expression(` followed by the nonce.
3. Look for any attribute terminator escape — a `"` or `'` in the canary that would close an outer attribute. We detect this by checking if the canary value (with its nonce embedded) appears unescaped in the body AND the canary contains an unescaped `"` or `'`.

### 4.3 `canaryAppearsInScriptTag(body: string, nonce: string): boolean`

Returns true iff the canary appears inside `<script>...</script>` content. Algorithm:

1. Tokenise the body into script-content blocks: `body.match(/<script[^>]*>([\s\S]*?)<\/script>/gi)`.
2. For each block, check if it contains `__bh_xss_${nonce}` literal.
3. Return true on first hit.

The motivation: a server that JSON-injects user input into an inline `<script>` tag (`<script>const x = "${userInput}"`) and the user planted a `';alert(1);//` payload — the literal nonce IS in the script block, evidence of `js_string`-context vulnerability.

### 4.4 DOM observation

`xss_dom` fires when the drained map contains an entry for the canary's nonce with `fired === true`. The `sink` field on the entry distinguishes:

- `window_assign`: the canary's `window.__bh_xss_<nonce>=1` ran.
- `dom_inserted`: a `<script>` or `<svg onload=...>` containing the nonce was inserted into the DOM.

Both prove arbitrary script execution. Both fire `xss_dom`.

---

## 5. Test plan

### 5.1 Unit — palette

`packages/cli/src/security/injection-palette.test.ts`:
- `generateCanaries('minimal').length === 5`.
- Each canary's `value` contains its `nonce`.
- Two calls return canaries with different nonces.
- All 5 contexts (`html_body`, `html_attr`, `js_string`, `url_param`, `json_body`) are represented at least once in `'full'`.
- `canaryAppearsAsHtml('<script>window.__bh_xss_aaaa1111bbbb2222=1</script>', 'aaaa1111bbbb2222')` → `true`.
- `canaryAppearsAsHtml('&lt;script&gt;__bh_xss_aaaa1111bbbb2222&lt;/script&gt;', 'aaaa1111bbbb2222')` → `false` (HTML-escaped).
- `canaryAppearsAsAttribute('<input value=" autofocus onfocus="window.__bh_xss_aaaa1111bbbb2222=1">', 'aaaa1111bbbb2222')` → `true`.
- `canaryAppearsInScriptTag('<script>const x = "\';window.__bh_xss_aaaa1111bbbb2222=1;//"</script>', 'aaaa1111bbbb2222')` → `true`.
- 10+ negative tests against safely-escaped fixtures.

### 5.2 Unit — observer

`packages/cli/src/security/xss-observer.test.ts` (new, pure-string assertion):
- `XSS_OBSERVER_START_SCRIPT.length > 0`.
- `XSS_OBSERVER_START_SCRIPT.includes('__bh_xss_installed')`.
- `XSS_OBSERVER_DRAIN_SCRIPT.includes('window.__bh_xss')`.
- These are sanity tests; the script is exercised via the integration test below.

### 5.3 Unit — mutation helpers

`packages/cli/src/mutation/apply.test.ts` (extend):
- `xssFormTestCases` produces N test cases for a form with N text fields × |palette|.
- Each test case has `action.injectionNonce` populated.
- Each test case's input value contains the nonce embedded in the canary template.
- Empty form → empty array.

### 5.4 Unit — cluster signature

`packages/cli/src/cluster/signature.test.ts` (extend):
- `clusterSignature({ kind: 'xss_reflected', endpoint: '/login', xssContext: { fieldName: 'next' } })` === `'xss_reflected|/login|next'`.
- Two detections with different nonces but same field collapse to same signature.

### 5.5 Integration — end-to-end with synthetic vulnerable fixture

`packages/cli/src/phases/execute-xss.test.ts` (new):

Create an in-memory fixture that simulates a vulnerable Express endpoint (`/echo?q=<...>` returns `<div>${q}</div>` with no escaping). The test:

1. Mock SurfaceMcpAdapter's `surface_call` to return the unescaped echo body.
2. Plant a canary via `xssApiTestCases`.
3. Run `executeApiTest` with the test case.
4. Assert the result contains a `BugDetection` with `kind === 'xss_reflected'` and the nonce from step 2.

Create a second fixture for the UI path with a stub `BrowserMcpAdapter`:
1. `scope.snapshot()` returns HTML that contains `<script>window.__bh_xss_<nonce>=1</script>` (after action).
2. `scope.evaluate(XSS_OBSERVER_DRAIN_SCRIPT)` returns `[{ nonce: '<...>', fired: true, sink: 'dom_inserted' }]`.
3. Assert `xss_dom` fires.

### 5.6 Smoke gate (manual; @qa)

- TraiderJo run: assert no `xss_reflected` / `xss_dom` clusters fire (React auto-escapes; should be clean).
- Add a synthetic fixture project at `packages/cli/test/fixtures/xss-app/` that runs an Express server with a deliberately-vulnerable `/echo` endpoint. New CI job `npm run test:xss-fixture` runs `bughunter run` against the fixture and asserts >=1 `xss_reflected` cluster.

---

## 6. Files to touch

**Create:**
- `packages/cli/src/security/injection-palette.ts`
- `packages/cli/src/security/injection-palette.test.ts`
- `packages/cli/src/security/xss-observer.ts`
- `packages/cli/src/security/xss-observer.test.ts`
- `packages/cli/src/phases/execute-xss.test.ts`
- `packages/cli/test/fixtures/xss-app/` (Express dev fixture; ~50 lines)
- `packages/cli/test/fixtures/xss-app/.bughunter/config.json`

**Modify:**
- `packages/cli/src/types.ts` — add `xss_reflected`, `xss_dom`, `xss_stored` to `BugKind`; add `XssContext`; extend `BugDetection`; extend `Action.injectionNonce`; add `xss_inject` to `PaletteVariant`; add `XssConfig`; extend `BugHunterConfig`.
- `packages/cli/src/mutation/apply.ts` — add `xssFormTestCases`, `xssApiTestCases`.
- `packages/cli/src/mutation/apply.test.ts` — extend.
- `packages/cli/src/phases/plan.ts` — wire XSS test cases behind `config.xss?.enabled ?? true`.
- `packages/cli/src/phases/execute.ts` — wire reflection check + DOM observer drain in both `executeApiTest` and `executeUiTestInner`.
- `packages/cli/src/cluster/signature.ts` — three new cases.
- `packages/cli/src/cluster/signature.test.ts` — extend.
- `packages/cli/src/phases/classify.ts` — slot XSS kinds into `KIND_PRIORITY`.

---

## 7. Negative requirements

- **No new dependency.** All HTML/JS analysis is regex-based against snapshot strings.
- **No `as any`.** `unknown` and narrow.
- **No emoji.** Anywhere.
- **No payload generation outside `injection-palette.ts`.** The list is closed.
- **No persistence of canary nonces.** They live in `Action.injectionNonce` and in transient `window.__bh_xss` only.
- **No `eval` outside the observer scripts.** The observer script string is `eval`-equivalent via `scope.evaluate`; that is intentional and isolated.
- **No coupling to `discoveredIds` or IDOR.** XSS is independent of cross-user; do not merge their phases.
- **No silent catch.** Every catch logs at `debug` minimum.
- **Functions max 40 lines.** The injection helpers in `apply.ts` should compose; if `xssFormTestCases` exceeds, extract `mintCanaryForField`.
- **Files max 300 lines.** `injection-palette.ts` is the largest new file; keep payload table compact.
- **No test depends on a remote server.** Fixture project is self-contained Express.

---

## 8. Task breakdown

### Task X1 — InjectionPalette + XSS observer (foundation)

**Assignee:** @coder · **Depends on:** none · **Branch:** `feat/v07-xss`

**Files to create:** `security/injection-palette.ts`, `security/injection-palette.test.ts`, `security/xss-observer.ts`, `security/xss-observer.test.ts`
**Files to modify:** `types.ts` (only the new fields/kinds; do not touch existing tests)

**Test:** `npx vitest run packages/cli/src/security/injection-palette.test.ts packages/cli/src/security/xss-observer.test.ts`

**Done when:**
- Both modules exist and are tested.
- `BugKind` includes `xss_reflected`, `xss_dom`, `xss_stored`.
- `BugDetection.xssContext` exists.
- `Action.injectionNonce` exists.
- All existing tests still pass (no breakage).

**DO NOT:** wire into the planner or executor in this task. Pure-module-only.

### Task X2 — Mutation helpers + cluster signatures + classify

**Assignee:** @coder · **Depends on:** X1

**Files to modify:** `mutation/apply.ts`, `mutation/apply.test.ts`, `cluster/signature.ts`, `cluster/signature.test.ts`, `phases/classify.ts`

**Test:** `npx vitest run packages/cli/src/mutation/apply.test.ts packages/cli/src/cluster/signature.test.ts`

**Done when:**
- `xssFormTestCases` and `xssApiTestCases` exist with passing tests.
- Cluster signatures stable and tested.
- KIND_PRIORITY updated.

**DO NOT:** call from `runPlan` yet — that's task X3.

### Task X3 — Wire XSS into plan + execute, end-to-end

**Assignee:** @coder · **Depends on:** X2

**Files to modify:** `phases/plan.ts`, `phases/execute.ts`
**Files to create:** `phases/execute-xss.test.ts`, fixture under `packages/cli/test/fixtures/xss-app/`

**Test:** `npx vitest run packages/cli/src/phases/execute-xss.test.ts && npm run test:xss-fixture`

**Done when:**
- Synthetic-vulnerable fixture run produces >= 1 `xss_reflected` cluster.
- TraiderJo run produces 0 XSS clusters (negative control).
- All existing tests pass.

**DO NOT:** add a new phase between execute and classify; XSS rides on the existing execute.

---

## 9. Acceptance

- All three tasks land in `feat/v07-xss` and pass CI.
- Synthetic fixture (`xss-app`) produces a `xss_reflected` cluster with the expected `fieldName` and `sink: 'reflected_html'`.
- TraiderJo run is clean of XSS clusters.
- A second smoke fixture with a `<script>${q}</script>` injection point produces `xss_reflected` with `sink: 'reflected_script'`.
- Config flag `xss.enabled = false` disables XSS test generation entirely (verify by `state.json` planner output).
- `npm run lint && npm run typecheck && npm test` clean.

---

## 10. Risk

**Medium.** Three risk vectors:

1. **Test runtime inflation.** Adding 5 canaries × every form × every role can multiply the API test count by 5–10x. The `xss.maxTestCases: 200` cap bounds this, but the planner must order by priority: forms with text inputs and URL params first, JSON-body-only tests last. Document the cap in run logs: `xss: planned N canary tests, capped at 200`.
2. **False positives via shared canary value.** Two test cases that share a nonce (collision) would create false positives. The nonce generator must use `crypto.randomBytes(8).toString('hex')` per canary; collisions at 16 hex chars are 1 in 2^64 — safe.
3. **`scope.evaluate` injection blowback.** The observer script is `eval`-injected into the page. If a third-party script in the page also defines `window.__bh_xss_*`, we'd false-positive. Mitigation: prefix every nonce with a fixed magic string `bh_${randomHex}`, and the observer only matches that prefix. Add a check: if `window.__bh_xss_installed` is set but `__bh_xss` Map is missing, log a warning — that tells us a script collision happened.

The DOM observer's `setInterval(sweep, 100)` is a memory leak risk if pages are not closed cleanly. Mitigate by clearing the interval on page unload **and** by always calling `XSS_OBSERVER_DRAIN_SCRIPT` (which clears the Map but not the interval — so add a `clearInterval` to the drain script).

---

## 11. Predicted v0.7 output on TraiderJo

- `xss_reflected`: 0 (React escapes by default).
- `xss_dom`: 0 (no `dangerouslySetInnerHTML` flagged in grep).

This is the *correct* outcome for a healthy React app. The XSS detector earns its keep on:

- The synthetic fixture (`xss-app`) — fires 5 reflected canaries.
- Any project that uses `v-html` (Vue), `[innerHTML]` (Angular), `dangerouslySetInnerHTML` (React), or server-rendered template injection.

The user's "most comprehensive scanner" claim hinges on detecting the *non-obvious* cases:

- A React app where a user-controlled string is passed to a `dangerouslySetInnerHTML` somewhere in a markdown renderer.
- A Vue app where `{{ rawHtml }}` is replaced with `v-html` in one component.
- An Express middleware that templates a response with a Mustache-style sub.

For these, the canary palette catches it. For the rest (sanitised React/Vue/Angular), the detector correctly stays silent.

---

## 12. Open questions

None at this time.
