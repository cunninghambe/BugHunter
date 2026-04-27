# BugHunter v0.3 — Browser-side login in the discover phase

**Status:** Draft · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-27 · **For implementation by:** @coder (Sonnet)

This is PR 3 of 3 for the BugHunter browser-login chain. **Depends on:**
- `camofox-mcp/spec-cookies` (PR 1) — must merge first; introduces the `cookies(tabId)` MCP tool used to verify HttpOnly session cookies.
- `SurfaceMCP/spec-describe-auth` (PR 2) — must merge second; introduces `surface_describe_auth(role)` and the optional UI-login config fields (`uiLoginPath`, `uiLoginFields`, `uiTriggerSelector`, `uiSubmitSelector`).

---

## 1. Problem Statement

BugHunter v0.2.1 (PR #7) crawls SPA routes from `/`, but on auth-walled SaaS apps every interesting route (`/dashboard`, `/trades`, `/settings`) sits behind a login. The crawler walks unauthenticated; SurfaceMCP holds owner cookies for its programmatic `surface_call`, but those cookies never enter the camofox browser context, so the browser-driven crawl + DOM walk only ever sees public surfaces.

Live evidence: `/tmp/TraiderJo` smoke test on v0.2.1 → discovery found 4 public pages (`/`, `/features`, `/privacy`, `/terms`), `testsPlanned: 0` because all interesting routes are gated.

This spec adds an explicit **browser-login step at the head of the discover phase**. Before any page discovery or DOM walk, BugHunter calls `surface_describe_auth(role)` to fetch the role's resolved credentials and the UI login plan, navigates to the login URL via camofox, fills the form using the existing `type` MCP tool, clicks submit, and verifies success by reading the cookie jar (via the new `cookies(tabId)` MCP tool from PR 1) or by URL change. The authenticated browser session is then reused for the entire discover phase.

This unlocks UI testing on every form-based-login SaaS — TraiderJo, Spoonworks (Auth.js v5 nextauth), and the long tail.

## 2. Boundaries

### In scope
- New module `src/discovery/browser-login.ts` exporting `loginInBrowser(browser, surface, role, config)`.
- Wire `loginInBrowser` into `src/phases/discover.ts` BEFORE `discoverPages()` and BEFORE `crawlFromSeeds()`.
- Extend `src/adapters/surface-mcp.ts` with `surface_describe_auth(role)` method and `DescribeAuthResult` types (mirror the SurfaceMCP server-side types from PR 2).
- Extend `src/adapters/browser-mcp.ts` with a `cookies(tabId)` method — wraps the new MCP tool from PR 1.
- Selector-discovery algorithm for fields and submit button (no fragile assumptions; explicit priority order in § 4.4).
- Success verification with a documented fallback chain (cookie via MCP → URL change).
- Feature flag (config-level): `browserLogin: { enabled: boolean; role?: string; verifyTimeoutMs?: number }`. Default is "auto" — enabled when the resolved auth is browseable AND there is at least one credentialed role. Allows ops to disable for triage.
- Update `vite-crawl-app` fixture: add a fake login flow (the existing `Login.tsx` already has the form; add server-side success behaviour and a config to drive it). Add an integration test that runs `runDiscover` against the fixture and asserts that post-login pages are discoverable.
- TraiderJo bring-up: apply the SurfaceMCP config diff (PR 2 § 8) to `/tmp/TraiderJo/surfacemcp.config.json` AS PART OF this PR. Verify smoke produces ≥ 5 UI tests on the auth-walled surface.

### Out of scope
- Multi-step / multi-page logins (email then password on a separate page; SAML redirects; OAuth consent screens). The v0.3 surface handles single-page form login. Document the limitation; add a "skipped: multi_step_unsupported" path for future work.
- Captcha. Document as `skipped: captcha_detected` if a captcha element is present (heuristic: `<img alt="captcha">`, `iframe[src*="captcha"]`, `[class*="captcha"]`). Skip browser login for that role + log + continue (the role becomes effectively anonymous for UI tests).
- 2FA / TOTP. Same posture — document as `skipped: 2fa_detected` and continue.
- Per-role parallel browser-login. Discovery uses the first role with credentials; subsequent roles get separate sessions only at execute-time (existing behaviour, unchanged).
- Sharing the resulting cookies back to SurfaceMCP. The two systems remain independent for now; SurfaceMCP keeps its own programmatic session, BugHunter keeps its own browser session.
- Persisting the browser session across runs. Each `bughunter run` starts fresh.
- Modifying the `nextauth` flow to use the camofox browser; we drive the form via the same MCP tool path. SurfaceMCP-side nextauth stays untouched.
- A "validate-only" CLI subcommand that just runs the login flow. Not in scope.

### External dependencies
- camofox-mcp v0.2 (PR 1) reachable at `config.browserMcpUrl`.
- SurfaceMCP v0.3 (PR 2) reachable at `config.surfaceMcpUrl`.
- No new npm dependencies.

## 3. Existing Code to Reuse

### 3.1 Files you MUST read before writing any code

- `packages/cli/src/phases/discover.ts` — current discover phase. The browser-login call is inserted at the top, BEFORE `surface.surface_list_tools()` (or alongside it; ordering rationale in § 4.6). The crawl call already passes through; the new authenticated session flows in by virtue of the same `browser` adapter being shared.
- `packages/cli/src/adapters/surface-mcp.ts` — `SurfaceMcpAdapter` interface. Add the `surface_describe_auth(args)` method. Mirror the server-side response types from `SurfaceMCP/spec-describe-auth` § 4.1 verbatim.
- `packages/cli/src/adapters/browser-mcp.ts` — `BrowserMcpAdapter` interface. Add `cookies(tabId?: string)`. The implementation calls the new `cookies` MCP tool added in `camofox-mcp/spec-cookies`. NOTE: the existing adapter has a private `currentTabId` and a `requireTab()` helper; reuse them.
- `packages/cli/src/adapters/browser-mcp-snapshot.ts` — pure snapshot parser. Reuse `parseSnapshot` and the structured `{role, name?, nth?}` selector form for finding the submit button. Do NOT add a new selector resolver path.
- `packages/cli/src/discovery/dom-walker.ts` — pattern reference. Use `browser.evaluate(<JS>)` for DOM-level checks the snapshot can't express (the trigger-selector click target may be outside the a11y tree on minimal landing pages — use evaluate as a fallback).
- `packages/cli/src/types.ts` — `BugHunterConfig`. Add `browserLogin?: BrowserLoginConfig`. Use the same `?:` patterns as `crawl?: CrawlConfig`.
- `packages/cli/src/config.ts` — Zod schema. Extend with the new optional field. Match the existing pattern.
- `packages/cli/src/log.ts` — `log.info` / `log.warn` / `log.error`. Use everywhere.
- `packages/cli/src/discovery/crawler.ts` — read for the structure of a small, well-tested module. Match its disposition: pure, returns a result type, no I/O outside the injected adapter.
- `packages/cli/src/discovery/crawler.test.ts` — pattern for `vi.fn()` + mocked adapter. Match for `browser-login.test.ts`.
- `packages/cli/tests/e2e/bughunter-e2e.test.ts` and `helpers/fixture-project.ts` — integration test scaffolding. Use this for the auth integration test against `vite-crawl-app`.
- `fixtures/vite-crawl-app/src/pages/Login.tsx` — existing login form (`<input id="email" name="email" type="email">`, `<input id="password" name="password" type="password">`, `<button type="submit">Sign in</button>`). Already useable as-is; we add only a backend success path.
- `fixtures/vite-crawl-app/surfacemcp.config.json` — currently `auth: {kind: 'none'}`. Convert to `'form'` for the integration test. Use a separate config (e.g. `surfacemcp.auth.config.json`) and parametrize the integration test, OR rev the existing config and rev all dependent tests. Choose the less-disruptive path; default recommendation: add a NEW fixture `vite-crawl-app-auth/` rather than mutating the existing one. Justification: the no-auth crawl path must keep working unmodified.
- `/tmp/TraiderJo/src/components/Auth.tsx` lines 442–461 — TraiderJo's actual login modal. Field IDs are `auth-identifier` and `auth-password`. The modal is opened by clicking the navbar "Sign in" button (`/tmp/TraiderJo/src/components/Navbar.tsx` line 73–80). This is the canonical "real-world" target for browser login.
- `/tmp/TraiderJo/.bughunter/config.json` — TraiderJo's BugHunter config. The browserLogin config field is added here as part of the bring-up (§ 7).

### 3.2 Patterns to follow

- **No new top-level `src/` directory.** New module lives in `src/discovery/browser-login.ts` next to `crawler.ts` and `dom-walker.ts`.
- **Pure function, injected adapters.** `loginInBrowser(browser, surface, role, opts)` takes the adapters and returns `Promise<LoginResult>`. No `import` of the live HTTP adapter inside the module. Easy to unit-test.
- **Error handling via discriminated union (return value), not throws** — match the global CLAUDE.md guidance:
  ```ts
  type LoginResult =
    | { ok: true; cookies: CookieEntry[]; finalUrl: string }
    | { ok: false; reason: LoginFailureReason; detail: string };
  ```
  Throws are reserved for adapter / transport failures (the adapter already throws `BrowserMcpError`).
- **Feature gating**: log the "skipped" path explicitly; never silently no-op.
- **Logging tone**: match existing — `log.info('browser_login: ...')` prefix on every line so logs are greppable.
- **Test layout**: `src/discovery/browser-login.test.ts` (unit, mocked adapters) + `tests/e2e/browser-login-e2e.test.ts` (integration, fixture).
- **Type discipline**: no `any`. Adapter response shape mirrors PR 2's `DescribeAuthResult` exactly.

### 3.3 DO NOT

- Do NOT add login logic inside `discoverPages` or `crawlFromSeeds`. Those modules stay focused. Login runs BEFORE them.
- Do NOT import `surface-mcp.ts`'s HTTP implementation in `browser-login.ts`. Take the interface (`SurfaceMcpAdapter`) by parameter.
- Do NOT swallow snapshot/click/type errors from the adapter. Let them propagate up to `loginInBrowser`, which classifies and converts to a `LoginResult`.
- Do NOT retry the login flow more than once. Re-login retry policy is owned by SurfaceMCP for `surface_call`; for browser login, a single failure is terminal for the discover phase (continues with anonymous role + warning).
- Do NOT read credentials from disk in BugHunter. SurfaceMCP resolves them; BugHunter just types the values it receives.
- Do NOT modify `crawler.ts`, `dom-walker.ts`, `pages.ts`, `element-collapse.ts`, or `form-cross-ref.ts`. The browser-login module is upstream of all of them.
- Do NOT add a "preLogin" path here. PR 2's `surface_describe_auth` returns the resolved login plan; preLogin (CSRF token capture) on the API side is separate. For browser login, navigating to the login URL natively loads the CSRF token into the form; no preLogin step is needed in the browser flow. Confirmed against the TraiderJo and Spoonworks Auth.js cases.
- Do NOT bundle the SurfaceMCP cookie session into the browser session. Browser session is independent.
- Do NOT mutate `BrowserMcpAdapter`'s frozen surface beyond the additive `cookies(tabId)` method. That additive surface is sanctioned by PR 1.
- Do NOT skip the integration test. Unit tests with mocked adapters do not catch selector-resolution edge cases.
- Do NOT write a test that depends on a live TraiderJo server. The TraiderJo bring-up is a manual smoke; automated tests run against `vite-crawl-app(-auth)`.

## 4. Interface Contract

### 4.1 New types in `packages/cli/src/types.ts`

```ts
export type BrowserLoginConfig = {
  /** When false, skip browser-login entirely (anonymous-only discovery). Default: true. */
  enabled?: boolean;
  /**
   * Which role to log in as. Defaults to the first credentialed role from `roles[]`.
   * Use this when multiple roles have credentials and you want to pin the discovery
   * session to a specific one (e.g. 'owner' vs 'member').
   */
  role?: string;
  /** Max wait after submit-click for successCheck to be satisfied. Default: 10000ms. */
  verifyTimeoutMs?: number;
  /**
   * Polling interval for cookie-jar / URL checks during verification. Default: 500ms.
   */
  verifyPollMs?: number;
};
```

Add to `BugHunterConfig`:
```ts
browserLogin?: BrowserLoginConfig;
```

### 4.2 New types in `packages/cli/src/adapters/surface-mcp.ts`

Mirror PR 2 § 4.1 verbatim:
```ts
export type DescribeAuthResult =
  | { authKind: 'none'; reason: 'no_auth_configured' }
  | { authKind: 'bearer'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'api_key'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'anonymous'; reason: 'role_has_no_credentials' }
  | {
      authKind: 'form';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName?: string;
    }
  | {
      authKind: 'nextauth';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName: string;
    };

export type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };
```

Extend `SurfaceMcpAdapter`:
```ts
surface_describe_auth(args: { role: string }): Promise<DescribeAuthResult>;
```

Extend `HttpSurfaceMcpAdapter`:
```ts
async surface_describe_auth(args: { role: string }): Promise<DescribeAuthResult> {
  return this.mcpCall<DescribeAuthResult>('surface_describe_auth', args);
}
```

### 4.3 New method on `BrowserMcpAdapter` (and `CamofoxBrowserMcpAdapter`)

```ts
export type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};
export type CookiesResult = { tabId: string; cookies: CookieEntry[] };

// On the interface:
cookies(urls?: string[]): Promise<CookiesResult>;
```

Implementation in `CamofoxBrowserMcpAdapter`:
```ts
async cookies(urls?: string[]): Promise<CookiesResult> {
  const tabId = this.requireTab();
  const args: Record<string, unknown> = { tabId };
  if (urls && urls.length > 0) args.urls = urls;
  return this.mcpCall<CookiesResult>('cookies', args);
}
```

`requireTab()` already exists on the adapter; no new wiring.

### 4.4 `loginInBrowser` — selector-discovery algorithm

Module: `packages/cli/src/discovery/browser-login.ts`.

Public signature:
```ts
export type LoginResult =
  | { ok: true; cookies: CookieEntry[]; finalUrl: string }
  | { ok: false; reason: LoginFailureReason; detail: string };

export type LoginFailureReason =
  | 'auth_not_browseable'   // bearer/api_key/none
  | 'role_has_no_credentials'
  | 'login_page_load_failed'
  | 'trigger_not_found'
  | 'field_not_found'       // an input matching a credential field could not be located
  | 'submit_not_found'
  | 'submit_failed'         // submit click threw or post-submit page is broken
  | 'verification_failed'   // submit succeeded but successCheck never matched
  | 'captcha_detected'
  | 'two_factor_detected'
  | 'unknown_error';

export async function loginInBrowser(
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  config: { role: string; baseUrl: string; verifyTimeoutMs: number; verifyPollMs: number }
): Promise<LoginResult>;
```

Algorithm:

1. **Describe auth.** Call `surface.surface_describe_auth({ role })`. Map non-browseable kinds to `{ ok: false, reason: ... }` and return early:
   - `'none'` → `{ ok: false, reason: 'auth_not_browseable', detail: 'auth.kind === none' }`.
   - `'bearer'` / `'api_key'` → `{ ok: false, reason: 'auth_not_browseable', detail: <plan.detail> }`.
   - `'anonymous'` → `{ ok: false, reason: 'role_has_no_credentials', detail: <plan.reason> }`.
   - The two non-error sentinels above are still `ok: false` because they short-circuit the discover phase's "logged in" path. The caller in `discover.ts` interprets them as "continue without auth" — see § 4.6.
2. **Navigate to login URL.** Compute `loginUrl = new URL(plan.uiLoginPath, baseUrl).toString()`. Call `browser.navigate(loginUrl)`. On any thrown `BrowserMcpError` → `{ ok: false, reason: 'login_page_load_failed', detail: '<err.message>' }`.
3. **Detect captcha / 2FA.** Snapshot the page and DOM-evaluate quickly. Heuristic in `evaluate`:
   ```js
   (function(){
     const captcha = !!document.querySelector('iframe[src*="captcha"], [class*="captcha"], [id*="captcha"], [aria-label*="captcha" i]');
     const twoFa = !!document.querySelector('input[name*="otp" i], input[name*="totp" i], input[autocomplete="one-time-code"]');
     return { captcha, twoFa };
   })()
   ```
   If `captcha` → return `{ ok: false, reason: 'captcha_detected', detail: <selector that matched> }`. (We accept the cost of one extra evaluate per login; runs once per discover phase.)
   If `twoFa` → return `{ ok: false, reason: 'two_factor_detected', detail: ... }`.
4. **Click trigger if configured.** If `plan.uiTriggerSelector` is set:
   - Try `browser.click(plan.uiTriggerSelector)`. The selector resolver in `browser-mcp-snapshot.ts` accepts `tag[attr="value"]`, `#id`, plain tag, and falls back to `evaluate`-then-resolve for `:has-text()` / `.class`. If the selector cannot be resolved → `{ ok: false, reason: 'trigger_not_found', detail: '<selector>' }`.
   - After click, snapshot the page again — the modal / drawer should now be open. (Re-snapshot is implicit on the next `click` / `type` call; no explicit step needed.)
5. **Locate input fields.** For each entry in `plan.fields` (which is `{ credKey: domName }`), find the corresponding input. Priority order (try in sequence; first hit wins):
   1. `input[name="<domName>"]`
   2. `input[id="<domName>"]`
   3. `input[name="<credKey>"]` (fallback to credential-key as input name — common when uiLoginFields was unset)
   4. `input[id="<credKey>"]`
   5. `input[id="auth-<domName>"]` (TraiderJo-style, prefix-namespaced ids)
   6. `input[id="auth-<credKey>"]`
   7. `input[type="<typeFromCredKey>"]` where `typeFromCredKey` is `'password'` if `credKey === 'password'` or `domName.toLowerCase().includes('password')`, else `'email'` if `'email'`-substring match, else nothing — skip type-based fallback for fully ambiguous keys.
   8. `input[placeholder*="<credKey>" i]` (case-insensitive substring) — last resort.
   The selector resolver already handles every shape above (attr selectors, id selectors). Iterate via the existing `browser.type(selector, value)` — pass each candidate selector in order; a `BrowserMcpError` of kind `element_not_found` falls through to the next candidate. ALL OTHER errors (e.g. `transport`, `snapshot_failed`) bubble.
   If no candidate resolves → `{ ok: false, reason: 'field_not_found', detail: 'No input matched any candidate selector for credential key "<credKey>" (domName "<domName>")' }`.
6. **Type values.** For each located field, `browser.type(<resolvedSelector>, plan.values[domName])`. The existing `type()` does NOT submit (the implementation passes `submit: false`); confirm before the implementer ships.
7. **Locate submit button.** Priority order:
   1. If `plan.uiSubmitSelector` is set, use it directly.
   2. Snapshot-based structured selector: `{ role: 'button', name: <textMatch> }` for each of `['Sign in', 'Log in', 'Login', 'Continue', 'Submit']` (case-insensitive contains, evaluated against the snapshot's accessible-name field — but the existing structured-resolver does an exact lowercase compare. So we iterate candidates and rely on the parser's `name` extraction matching one of those literals.)
   3. Snapshot fallback: `button[type="submit"]` via the attr-selector path.
   4. DOM evaluate fallback: `document.querySelector('button[type="submit"]')`. This goes through `resolveViaEvaluate` → `resolveByHtml`.
   If none resolve → `{ ok: false, reason: 'submit_not_found', detail: 'Tried: uiSubmitSelector, structured role+name, button[type=submit], evaluate fallback' }`.
8. **Click submit.** `browser.click(<resolved>)`. On `BrowserMcpError` other than `element_not_found` → `{ ok: false, reason: 'submit_failed', detail: '<err.message>' }`.
9. **Wait for success.** Loop until `verifyTimeoutMs` elapses, polling every `verifyPollMs`:
   - **Cookie-based** (`successCheck.kind === 'cookie'`): call `browser.cookies()`. If any cookie matches `name === successCheck.name` → success. Optimization: scope the call with `urls: [baseUrl]`.
     - Fallback for non-HttpOnly cookies in case the `cookies` MCP tool is unavailable or fails: `browser.evaluate('document.cookie')` and parse — but NEVER as the primary path (HttpOnly is the common case). If `cookies` fails twice in a row, log warning and fall through to URL-change detection.
   - **Redirect-based** (`successCheck.kind === 'redirect'`): poll `browser.evaluate('location.href')`. Success if URL matches (`includes(successCheck.to)` — same loose match as `loginForm`'s `loc.includes(check.to)` in SurfaceMCP).
   - **Status-based** (`successCheck.kind === 'status'`): N/A in the browser flow (status is the form POST response, hidden from page JS). Treat as if successCheck were `redirect`-style: poll for any URL change away from `loginUrl` AND absence of common error messages (heuristic: page does not contain `[role="alert"]` with text matching `/invalid|incorrect|wrong|fail/i`). Document this as best-effort.
10. **On verify success** → `{ ok: true, cookies: <fromBrowser.cookies()>, finalUrl: <fromBrowser.evaluate('location.href')> }`.
11. **On verify timeout** → `{ ok: false, reason: 'verification_failed', detail: 'successCheck=<JSON> not satisfied within <verifyTimeoutMs>ms; lastUrl=<...>; cookieNames=<comma-joined>' }`.

### 4.5 Negative-test escape hatch (DO NOT modify)

The existing palette negative-test path (which calls `surface_call` with `noAutoRelogin: true`) is unaffected. Browser login runs in the **discover** phase only. Negative-test runs in **execute**.

### 4.6 Wiring in `phases/discover.ts`

Insert at the top of `runDiscover`, BEFORE `surface.surface_list_tools()`:

```ts
// Browser-side login (PR 3) — runs once per discover phase.
const loginCfg = config.browserLogin;
const browserLoginEnabled = (loginCfg?.enabled ?? true) && !!browser;
let loginRoleUsed: string | undefined;

if (browserLoginEnabled && browser) {
  const loginRole = loginCfg?.role ?? roles[0];   // first role in run config
  if (!loginRole) {
    log.info('browser_login: no roles configured; skipping');
  } else {
    const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
    const result = await loginInBrowser(browser, surface, {
      role: loginRole,
      baseUrl,
      verifyTimeoutMs: loginCfg?.verifyTimeoutMs ?? 10_000,
      verifyPollMs: loginCfg?.verifyPollMs ?? 500,
    });
    if (result.ok) {
      loginRoleUsed = loginRole;
      log.info(`browser_login: success (role=${loginRole}, cookies=${result.cookies.length}, url=${result.finalUrl})`);
    } else {
      log.warn(`browser_login: skipped (role=${loginRole}, reason=${result.reason}): ${result.detail}`);
      skipList.push({
        route: '<login>',
        reason: `browser_login_${result.reason}`,
      });
    }
  }
} else if (!browser) {
  log.info('browser_login: skipped (no browser adapter)');
}
```

The crawl, page discovery, and DOM walk that follow REUSE the same `browser` adapter; the camofox session retains the cookies set by the form submit. No additional wiring needed downstream — the existing `withTab` path (per-test isolated tabs) preserves cookies because cookies are context-level, not tab-level. **Confirmed against camofox-browser's session model**: each `getSession(userId)` returns one Playwright `BrowserContext`; tabs share the context; cookies set in one tab are visible in all tabs.

### 4.7 No changes to:
- `phases/plan.ts`, `phases/execute.ts`, `phases/classify.ts`, `phases/cluster.ts`, `phases/emit.ts`.
- `discovery/dom-walker.ts`, `discovery/crawler.ts`, `discovery/pages.ts`, `discovery/element-collapse.ts`, `discovery/form-cross-ref.ts`, `discovery/filesystem-pages.ts`.
- The `BugHunterConfig` schema except for the additive `browserLogin?` field.
- The `SurfaceMcpAdapter` interface except for the additive `surface_describe_auth` method.
- The `BrowserMcpAdapter` interface except for the additive `cookies` method.
- `browser-mcp-snapshot.ts` selector-resolution rules (selector logic stays single-source).
- The default forbidden paths.

## 5. Edge Cases

| # | Case | Behaviour |
|---|---|---|
| 1 | `browserMcpUrl` not configured | `browser` is undefined; existing `if (browser)` checks skip both crawl and login. `skipList` records `'browser_login_skipped: no_browser'`. |
| 2 | `surface_describe_auth` not present (PR 2 not deployed) | The MCP call throws `Tool not found`. Catch in `loginInBrowser`'s pre-step, return `{ ok: false, reason: 'unknown_error', detail: 'surface_describe_auth not available; SurfaceMCP needs upgrade to >=v0.3' }`. |
| 3 | `cookies` MCP tool not present (PR 1 not deployed) | Same posture: catch, fall back to `evaluate('document.cookie')` for non-HttpOnly cookies, log warning. If the success cookie is HttpOnly, fall through to URL-change verification. |
| 4 | Login URL returns 404 | `browser.navigate` throws `BrowserMcpError('navigation_failed', ...)`. → `login_page_load_failed`. |
| 5 | Login URL is the same as the post-login URL (logged-in user) | If a session cookie is already set, `cookies()` succeeds before the form is even located — we go straight to verify-success. ADD A FAST PATH: after navigate, before snapshotting fields, run cookie check ONCE. If success cookie present → return `{ ok: true, ... }` immediately. Saves a flow on test reruns where the camofox session retained a prior cookie. |
| 6 | Trigger selector exists but doesn't open the modal (timing) | Re-snapshot is implicit on next `click` / `type`. If the field-discovery loop fails to find inputs → `field_not_found`. Add a 250ms sleep after trigger click to reduce timing flakes. |
| 7 | Field input is inside a shadow DOM | The existing `evaluate` fallback uses `document.querySelector`, which doesn't pierce shadow roots. Document as a known limitation; return `field_not_found` with detail. |
| 8 | Multiple forms on the login page (login + register tabs both rendered) | The selector-discovery picks the FIRST match in document order. Document this. If it picks the wrong one, the user must set `uiTriggerSelector` to switch to the login tab first OR scope the field selectors. |
| 9 | Wrong credentials (`$env:VAR` empty) | Login submits with empty values → server rejects → no session cookie → `verification_failed`. The detail string surfaces "cookieNames=..." which makes the cause obvious. |
| 10 | Submit button has spinner / disabled state during inflight | Cookies are set when the server responds; the polling loop catches that. `verifyTimeoutMs: 10_000` (default) accommodates slow networks. |
| 11 | Login redirects to `/onboarding` instead of `/dashboard` | URL-change verification still passes (URL is no longer `loginUrl`). Cookie verification passes if the cookie was set. **Both paths are tolerant of unexpected post-login URLs** — by design. |
| 12 | Session cookie is set with `domain=.example.com` and the test runs against `localhost` | Domain mismatch → cookie not sent. `cookies()` still returns it (Playwright returns ALL cookies in the context). The successCheck `name` match still passes. The fact that subsequent requests don't carry it is a separate problem; if it surfaces, document as `verification_failed: cookie set but domain mismatched`. We don't try to be smart here. |
| 13 | The page sets multiple session cookies (`a`, `b`, `c`); successCheck only names one | Only the named cookie is required. Pass-through. |
| 14 | The URL changes to a relative path (rare) | `evaluate('location.href')` returns absolute; URL match remains correct. |
| 15 | `verifyTimeoutMs` exceeded but the login DID succeed (slow network) | `verification_failed`. The cookie may show up moments later, but discover-phase is already moving on. Increase `verifyTimeoutMs` in config. Document. |
| 16 | The first role has no credentials but a later role does | `loginInBrowser` is called with `loginRole = roles[0]` by default. If that role is anonymous, `surface_describe_auth` returns `{authKind: 'anonymous'}` and we skip browser login. CONFIG ESCAPE: user can set `browserLogin.role: 'owner'` to pin to a specific role. Document. |
| 17 | Captcha / 2FA detected | Skip browser login with an explicit reason. Discover continues unauthenticated. Surface in skipList. |
| 18 | Login form uses CSRF token in a hidden input | Native browser navigation loads the token into the form. Submitting it submits the token with the rest. No special handling required. Confirmed against TraiderJo (no CSRF — JSON body) and Spoonworks Auth.js (CSRF token rendered server-side; Auth.js handles client-side). |
| 19 | Login form is rendered by JS after a delay | If the form isn't in the snapshot when we try to type, `field_not_found`. Mitigation: 250ms sleep after navigate (and after trigger click). Document. Don't add elaborate retry logic; that's a v0.4 problem if it surfaces. |
| 20 | Browser MCP returns a different shape for `cookies` than expected | The adapter mocks the response shape; if the upstream wire shape drifts, the adapter test fails. Catch in `loginInBrowser`, surface as `unknown_error`. |
| 21 | A different test in the discover phase clicks "Logout" via crawl | The crawler is read-only — only follows `<a href>` links. Logout is typically a `<button>`; not followed. If a project has `<a href="/logout">`, add it to `excludedRoutes`. Document. |
| 22 | TraiderJo's `tj_sess` is HttpOnly + SameSite=Strict | Already verified end-to-end by the live target (§ 7). |

## 6. Acceptance Criteria

1. `cd /root/BugHunter && pnpm -C packages/cli typecheck` (or whatever the canonical typecheck command is in this repo — check `package.json` scripts) clean.
2. `pnpm -C packages/cli test` green. Tests cover:
   - **`src/discovery/browser-login.test.ts`** (new):
     - Auth=`none` → `{ok: false, reason: 'auth_not_browseable'}`.
     - Auth=`bearer` → `{ok: false, reason: 'auth_not_browseable'}`.
     - Auth=`api_key` → `{ok: false, reason: 'auth_not_browseable'}`.
     - Anonymous role → `{ok: false, reason: 'role_has_no_credentials'}`.
     - Form auth happy path: trigger click, two field types, submit click, cookie verify success → `{ok: true}`.
     - Form auth, trigger missing → `{ok: false, reason: 'trigger_not_found'}`.
     - Form auth, password field cannot be found across all 8 candidates → `{ok: false, reason: 'field_not_found'}`.
     - Form auth, submit not found across all 4 candidates → `{ok: false, reason: 'submit_not_found'}`.
     - Form auth, cookie successCheck never satisfied within timeout → `{ok: false, reason: 'verification_failed'}`.
     - Captcha detected → `{ok: false, reason: 'captcha_detected'}`.
     - 2FA detected → `{ok: false, reason: 'two_factor_detected'}`.
     - Fast-path: cookie already set on navigate → `{ok: true}` without form interaction.
     - NextAuth happy path: synthesized cookie successCheck succeeds.
     - URL-change verification (status-based fallback).
     - Cookie tool fails (PR 1 not deployed) → graceful fallback to URL-change verification.
   - **`src/adapters/surface-mcp.test.ts`** (extend or new):
     - `surface_describe_auth({role: 'owner'})` invokes the right MCP tool with correct args.
   - **`src/adapters/browser-mcp.test.ts`** (extend or new):
     - `cookies()` calls the new MCP tool with the current tabId.
     - `cookies(['http://example.com'])` forwards the urls argument.
   - **`tests/e2e/browser-login-e2e.test.ts`** (new):
     - Spawn `vite-crawl-app-auth/` fixture (new fixture per § 3.1; or rev existing).
     - Run `runDiscover` end-to-end with a real camofox-mcp-http daemon (via `helpers/spawn.ts`).
     - Assert `pages` contains the post-login routes (`/dashboard`, `/profile`).
     - Assert `skipList` does NOT contain `browser_login_*`.
3. `pnpm -C packages/cli build` clean (or whatever the canonical build is).
4. **Live target — TraiderJo**:
   - Apply the SurfaceMCP config diff (PR 2 § 8) to `/tmp/TraiderJo/surfacemcp.config.json`.
   - Add `browserLogin: { enabled: true, role: 'owner' }` to `/tmp/TraiderJo/.bughunter/config.json` (optional; the default is auto-on, but make it explicit for the smoke).
   - Run the full smoke (whatever `bughunter run` invocation is canonical for TraiderJo per `dist-skill/bughunt-host.md`).
   - **Pass criteria**:
     - `browser_login: success (role=owner, cookies=≥1, url=...)` in logs.
     - `pages` count includes routes that previously required auth (e.g. `/dashboard`, `/trades`, `/settings`).
     - `testsPlanned` ≥ 5 (vs current 0). Most should be UI tests (palette is `happy` or `null`).
5. **Live target — vite-crawl-app(-auth)**:
   - Integration test in (2) above.
   - The fixture's "logged-in" state exposes a `<a href="/profile">` link and a `<a href="/dashboard">` link that the crawler then follows.
6. **No regression**:
   - Existing `vite-crawl-app` (no auth) integration test still passes — proves the auth path is fully gated.
   - `crawler.test.ts`, `pages.test.ts`, `bughunter-e2e.test.ts` still pass.

## 7. Files Touched

```
BugHunter/
├── SPEC_BROWSER_LOGIN.md                     # NEW — this file
├── packages/cli/src/
│   ├── types.ts                              # MODIFIED — add BrowserLoginConfig, extend BugHunterConfig
│   ├── config.ts                             # MODIFIED — Zod schema for browserLogin
│   ├── adapters/
│   │   ├── surface-mcp.ts                    # MODIFIED — add surface_describe_auth + DescribeAuthResult types
│   │   └── browser-mcp.ts                    # MODIFIED — add cookies() method + CookieEntry types
│   ├── discovery/
│   │   ├── browser-login.ts                  # NEW (~250 LOC) — loginInBrowser + helpers
│   │   └── browser-login.test.ts             # NEW — unit tests with mocked adapters
│   └── phases/
│       └── discover.ts                       # MODIFIED — wire loginInBrowser at the top
├── packages/cli/tests/
│   ├── adapters/
│   │   └── browser-mcp-cookies.test.ts       # NEW — cookies adapter test
│   └── e2e/
│       └── browser-login-e2e.test.ts         # NEW — fixture-based integration test
└── fixtures/
    └── vite-crawl-app-auth/                  # NEW (or revved variant of vite-crawl-app)
        ├── package.json
        ├── vite.config.ts
        ├── index.html
        ├── server.ts                         # tiny Express server: GET /api/login, sets a cookie
        ├── src/
        │   ├── App.tsx                       # routes by cookie; /dashboard + /profile when logged in
        │   ├── pages/
        │   │   ├── Landing.tsx
        │   │   ├── Login.tsx                 # extant form, enhanced to call /api/login
        │   │   ├── Dashboard.tsx             # NEW
        │   │   └── Profile.tsx               # NEW
        │   └── main.tsx
        └── surfacemcp.config.json            # auth.kind = 'form', uiLoginPath = '/login'

/tmp/TraiderJo/
├── surfacemcp.config.json                    # MODIFIED — add uiLoginPath/uiLoginFields/uiTriggerSelector
└── .bughunter/config.json                    # MODIFIED — add browserLogin block
```

No new dependencies. No new top-level directories.

## 8. Definition of Done

A reviewer can:
```bash
cd /root/BugHunter
git checkout spec/browser-login

pnpm -C packages/cli install
pnpm -C packages/cli typecheck
pnpm -C packages/cli test                 # green, including new browser-login tests
pnpm -C packages/cli build

# Manual smoke: TraiderJo
cd /tmp/TraiderJo
# (Apply SurfaceMCP & BugHunter config diffs documented in this spec.)
pm2 restart traiderjo-server traiderjo-vite traiderjo-surfacemcp
bughunter run --max-bugs 5
# In the run logs, expect:
#   browser_login: success (role=owner, cookies=≥1, url=http://...)
#   crawl: visited N pages including /dashboard, /trades, ...
#   testsPlanned: ≥ 5
```

PR description must include:
> Depends on: camofox-mcp/spec-cookies (merged), SurfaceMCP/spec-describe-auth (merged).
> Closes the v0.2.1 testsPlanned: 0 issue on auth-walled SaaS.

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Selector discovery picks the wrong input on a complex page | The 8-step priority order with explicit fallbacks; user can override via `uiLoginFields` (PR 2). |
| Submit click resolves to a non-submit button (e.g. "Continue with Google") | Structured selector prefers role=button + literal name match against the canonical login labels first. `uiSubmitSelector` overrides. |
| Login successful but cookie not visible to MCP tool (HttpOnly + tool unavailable) | Documented fallback: URL-change detection. |
| Race condition: cookies arrive after `verifyTimeoutMs` | `verifyTimeoutMs` is configurable; default 10s; doc says to bump for slow networks. |
| Browser session loss between login and crawl | Camofox sessions are per-user; tabs share context. The same `browser` adapter is passed to all subsequent calls. Verified by integration test. |
| Captcha appears mid-flow on the live target | Heuristic detection up front; skipped + logged. Discover continues without auth. |
| Some apps require the form to be inside an iframe | Out of scope for v0.3. Document. Spec the workaround (manual cookie injection) as v0.4 work. |
| Multiple roles in one run | Browser login uses ONE role; subsequent roles use SurfaceMCP's programmatic auth as before. Discovery is the only phase that needs browser auth. Execute already supports per-role API auth. |

## 10. Test Plan (TODO checklist for QA)

- [ ] Unit tests for `loginInBrowser` cover all 14 cases in § 6.2.
- [ ] Adapter tests for `surface_describe_auth` and `cookies`.
- [ ] Integration test against `vite-crawl-app-auth` fixture passes locally.
- [ ] Existing `bughunter-e2e.test.ts` still passes.
- [ ] TraiderJo smoke:
  - [ ] `browser_login: success` in logs.
  - [ ] `testsPlanned ≥ 5`.
  - [ ] At least one UI test runs against `/dashboard` or another auth-walled route.
- [ ] No regression on Spoonworks (run smoke once; nextauth flow still works).
- [ ] Type check + build clean.
- [ ] Logs are greppable (`browser_login:` prefix everywhere).

## 11. Glossary

- **Browseable auth kind**: `form` or `nextauth`. Drives a real form. Distinguished from `bearer` / `api_key` (programmatic) and `none` (no auth).
- **UI login URL**: the URL a human points their browser at to log in. May differ from the API endpoint that processes the credentials (e.g. TraiderJo: UI `/`, API `/auth/login`).
- **Trigger selector**: optional CSS selector clicked before the form is visible. For modal-style logins.
- **Success check**: the criterion that proves login succeeded. Cookie name (most common), URL redirect target, or HTTP status (status not browser-observable; falls back to URL-change heuristic).
- **Fast path**: when the camofox session already carries the success cookie at navigate time, skip the form interaction.
