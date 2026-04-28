# SPEC — v0.7 Auth-flow detectors

**Status:** Draft 1, ready for @coder · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-28 · **Predecessor:** v0.5 PR B (`SPEC_V05_SECURITY_HYGIENE.md` § 4.9 + `SPEC_V05_PR_B_GAPS.md`).

This spec ships three auth-flow BugKinds: `auth_session_fixation`, `password_reset_token_reuse`, and `open_redirect`. (`open_redirect` is partially implemented in v0.5 — `security/header-probe.ts:checkOpenRedirect` exists but is not wired into the run pipeline; this spec finishes the wiring.) Plus a verification of the v0.5 `no_rate_limit_on_login` detector against TraiderJo's `humanLimiter`.

The auth-flow detectors are stateful: each one drives the SurfaceMCP login + reset surfaces through a multi-step protocol, asserting an invariant. They are **opt-in** at the project level (`config.authFlow.enabled`) because they mutate user state.

---

## 1. Objective

Add four auth-flow security detectors that drive real login and password-reset flows and assert standard security invariants:

| Kind | Invariant tested |
|---|---|
| `auth_session_fixation` | Session id changes on login. |
| `password_reset_token_reuse` | Single-use reset tokens cannot be redeemed twice. |
| `open_redirect` | `?redirect=`-style params reject off-origin URLs. |
| `no_rate_limit_on_login` | Login endpoint rate-limits brute-force attempts. (v0.5 ships; this spec verifies it works on TraiderJo's `humanLimiter`.) |

**In scope:**
- The three new detectors above.
- Wiring `checkOpenRedirect` from `security/header-probe.ts` into the run pipeline (it exists but is dead code).
- A new `auth-flow.ts` phase that runs alongside `cross-user.ts` between execute and classify.
- A v0.5 `no_rate_limit_on_login` smoke verification on TraiderJo with concrete pass/fail criteria.

**Out of scope:**
- Multi-factor auth flow analysis — v1.0.
- OAuth / OIDC flow attacks (state param tampering, redirect_uri injection beyond the simple case) — v0.8.
- Magic-link reuse — v0.8 (depends on email mocking infra).
- Password-strength enforcement detection — v0.9.
- Session cookie expiration analysis — v0.6 (or merge into `cookie_security_flags`).

**Killer-demo target on TraiderJo:**
- `auth_session_fixation`: TraiderJo issues `tj_sess` on login (line 602–604 per architect's earlier note). Detector captures the cookie before the credential POST, logs in, captures the cookie after; if the value is unchanged, fire. Probable: TraiderJo's `tj_sess` rotates correctly, no finding. The demo then introduces a synthetic regression by patching one line; re-run; finding fires. (Demo path is documented in § 11.)
- `password_reset_token_reuse`: TraiderJo has a reset endpoint (`/auth/reset`). Detector requests reset twice for the same email. If both tokens are valid simultaneously, fire.
- `open_redirect`: TraiderJo unlikely to fire (no obvious open-redirect param). Demo doesn't depend on this.
- `no_rate_limit_on_login`: TraiderJo's `humanLimiter` middleware should rate-limit. Expected: `no_rate_limit_on_login` does NOT fire. Demo confirms the gate works.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/security/auth-probes.ts` | The v0.5 `runAuthProbes` for `no_rate_limit_on_login`. New auth-flow phase composes with this; do not duplicate its rate-limit-discovery dance. |
| `packages/cli/src/security/rate-limit-discovery.ts` | Pre-flight rate-limit profile builder. Reuse for the new detectors' inter-attempt delay. |
| `packages/cli/src/security/header-probe.ts` | `checkOpenRedirect` exists at line 243; needs wiring into pipeline. |
| `packages/cli/src/phases/cross-user.ts` | The reference template for "phase-after-execute-before-classify." Mirror its options-shape, abort-reason discriminated union, and detection accumulator pattern. |
| `packages/cli/src/discovery/browser-login.ts` | The browser-login flow used in `discover.ts`. Auth-flow detectors reuse this for fixation testing. |
| `packages/cli/src/adapters/surface-mcp.ts` | `surface_describe_auth` returns the auth surface metadata; use it to find the login + reset endpoints. |
| `packages/cli/src/types.ts` | Add new BugKinds, contexts, config. |
| `packages/cli/src/cluster/signature.ts` | Add cases for the three new kinds. |
| `packages/cli/src/phases/classify.ts` | KIND_PRIORITY entries. |
| `packages/cli/src/cli/run.ts` | Wire the new `runAuthFlow` phase. |

### 2.2 Patterns to follow

- **Phase shape**: pure inputs (`runState`, `surface`, optionally `browser`), discriminated-union return (`{ detections, testCases, abortReason? }`), no global state.
- **No new HTTP client**: every external request goes through `SurfaceMcpAdapter` (for credentialed flows) or `BrowserMcpAdapter.openTab` for tab-scoped state. Direct `fetch` is reserved for `header-probe.ts`-style external probes only.
- **Idempotent re-entrancy**: the phase reads/writes only via `RunState`. If aborted mid-flow, a re-run resumes cleanly.
- **Cookie capture via browser tab**: session cookies live in the camofox session; capture them via `browser.evaluate('document.cookie')` plus `browser.evaluate('navigator.cookieStore?.getAll?.()')` if available.

### 2.3 DO NOT

- **Do not** create a real user account. Use `config.authProbe.testAccountUsername` (default `bughunter-probe-user@invalid.test`); never use a real production account.
- **Do not** persist captured tokens or cookies to disk outside `runs/<runId>/`. They expire and shouldn't be checked in artifact diffs.
- **Do not** run auth-flow detectors when `config.authFlow?.enabled !== true`. Default is **off** because the flows mutate user state (consume reset tokens, increment login counters).
- **Do not** add a new ResetPolicy enum value for auth-flow — reuse the existing `transactional | per-test | per-page | per-run`.
- **Do not** chain auth-flow detectors so that one's output is another's input. Each is independent and runs in its own try/catch.

---

## 3. Cross-cutting infrastructure

### 3.1 New phase: `phases/auth-flow.ts`

Mirrors `cross-user.ts`'s shape. Runs after execute, in parallel with cross-user (both consume `runState.discoveredIds` and the surface/browser; serialise the **calls** to surface but the phases run sequentially to avoid auth-token churn).

**Files to create:**
- `packages/cli/src/phases/auth-flow.ts`
- `packages/cli/src/phases/auth-flow.test.ts`

**Public API:**

```ts
export type AuthFlowOptions = {
  runState: RunState;
  surface: SurfaceMcpAdapter;
  browser?: BrowserMcpAdapter;
  appBaseUrl: string;
  roles: string[];
  maxClusters: number;
  onClusterFound: (key: string) => number;
};

export type AuthFlowResult = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  abortReason?: 'budget' | 'max_clusters' | 'auth_unavailable' | 'no_login_role' | 'disabled';
};

export async function runAuthFlow(opts: AuthFlowOptions): Promise<AuthFlowResult>;
```

The phase orchestrates four sub-checks. Each has its own `try/catch` wrapper; one failing does **not** prevent others from running.

```ts
async function runAuthFlow(opts: AuthFlowOptions): Promise<AuthFlowResult> {
  const cfg = opts.runState.config.authFlow;
  if (cfg?.enabled !== true) {
    log.info('auth-flow: disabled (config.authFlow.enabled !== true)');
    return { detections: [], testCases: [], abortReason: 'disabled' };
  }

  const detections: Array<{ testId: string; detection: BugDetection }> = [];
  const testCases: TestCase[] = [];

  await safeRunSubcheck('session_fixation', () => checkSessionFixation(opts), detections, testCases);
  await safeRunSubcheck('password_reset_reuse', () => checkPasswordResetReuse(opts), detections, testCases);
  await safeRunSubcheck('open_redirect', () => checkOpenRedirectFlow(opts), detections, testCases);

  log.info(`auth-flow: ${detections.length} detection(s)`);
  return { detections, testCases };
}
```

`safeRunSubcheck` is a 5-line helper: try, catch, log, swallow.

### 3.2 Type extensions

```ts
export type BugKind =
  | /* ...existing... */
  | 'auth_session_fixation'
  | 'password_reset_token_reuse';
  // 'open_redirect' already exists from v0.5

export type AuthFlowContext = {
  /** What the detector was checking. */
  invariant: 'session_id_rotates' | 'reset_token_single_use' | 'redirect_param_validates';
  /** For session_fixation: cookie name observed. */
  cookieName?: string;
  /** For session_fixation: pre/post values (truncated to 8 chars for log safety). */
  preValuePrefix?: string;
  postValuePrefix?: string;
  /** For password_reset: how many times the same token was redeemed successfully. */
  reuseCount?: number;
  /** For open_redirect: which param accepted off-origin. */
  paramName?: string;
  /** The off-origin target that succeeded. */
  redirectTarget?: string;
};

export type BugDetection = {
  /* ...existing fields... */
  authFlowContext?: AuthFlowContext;
};
```

### 3.3 Config

```ts
export type AuthFlowConfig = {
  /** Master switch. Default: false (opt-in). */
  enabled?: boolean;
  /** Which sub-checks to run. Defaults: all. */
  checks?: Array<'session_fixation' | 'password_reset_reuse' | 'open_redirect'>;
  /** Email used for password-reset probes. Default: config.authProbe.testAccountUsername. */
  testEmail?: string;
  /** For open_redirect: param names to test. Default: ['redirect','return_to','returnTo','next','url','continue','redirectUrl','dest','destination']. */
  redirectParamNames?: string[];
  /** For open_redirect: routes to probe. Default: routes containing one of the param names from URL crawling. */
  redirectRoutes?: string[];
  /** For password_reset_reuse: tool/route id of the request-reset endpoint. Required if check is enabled. */
  requestResetToolId?: string;
  /** For password_reset_reuse: tool/route id of the consume-reset endpoint. Required if check is enabled. */
  consumeResetToolId?: string;
  /** For session_fixation: max wait for cookie capture in ms. Default: 5000. */
  cookieCaptureTimeoutMs?: number;
};

export type BugHunterConfig = {
  /* ...existing... */
  authFlow?: AuthFlowConfig;
};
```

### 3.4 Cluster signatures

In `packages/cli/src/cluster/signature.ts`:

```ts
case 'auth_session_fixation': {
  const cookie = detection.authFlowContext?.cookieName ?? '';
  return `auth_session_fixation|${cookie}`;
}
case 'password_reset_token_reuse':
  return `password_reset_token_reuse|${detection.endpoint ?? ''}`;
// 'open_redirect' signature already defined in v0.5; no change.
```

In `packages/cli/src/phases/classify.ts`, KIND_PRIORITY (insert after `auth_bypass_via_unauthed_route`):

```ts
'auth_bypass_via_unauthed_route',
'auth_session_fixation',
'password_reset_token_reuse',
// open_redirect is already in the list
```

---

## 4. Detector algorithms

### 4.1 `checkSessionFixation`

**Invariant:** the session-id cookie value MUST change between pre-login and post-login states. Industry standard (OWASP A07).

**Algorithm:**

```ts
async function checkSessionFixation(opts: AuthFlowOptions): Promise<{ testId: string; detection: BugDetection } | null> {
  const { browser, surface, appBaseUrl, runState } = opts;
  const cfg = runState.config.authFlow;
  if (browser === undefined) {
    log.info('session-fixation: skipped (no browser adapter)');
    return null;
  }

  // Resolve the login role and auth metadata.
  const loginRole = runState.config.browserLogin?.role ?? runState.config.roles?.[0];
  if (loginRole === undefined || loginRole === '') {
    log.info('session-fixation: skipped (no login role configured)');
    return null;
  }

  const authMeta = await surface.surface_describe_auth({ role: loginRole });
  if (authMeta.authKind !== 'form' && authMeta.authKind !== 'nextauth') {
    log.info('session-fixation: skipped (auth kind not form-based)', { authKind: authMeta.authKind });
    return null;
  }

  const cookieName = authMeta.cookieName ?? authMeta.successCheck.kind === 'cookie' ? authMeta.successCheck.name : undefined;
  if (cookieName === undefined) return null;

  // Step 1: open the login page in a fresh tab; capture cookie value (may be empty if session is lazily issued).
  const preCookie = await captureCookie(browser, appBaseUrl, authMeta.uiLoginPath, cookieName, cfg?.cookieCaptureTimeoutMs ?? 5000);

  // Step 2: perform the login flow via existing browser-login module.
  const result = await loginInBrowser(browser, surface, {
    role: loginRole,
    baseUrl: appBaseUrl,
    verifyTimeoutMs: runState.config.browserLogin?.verifyTimeoutMs ?? 10_000,
    verifyPollMs: runState.config.browserLogin?.verifyPollMs ?? 500,
  });
  if (!result.ok) {
    log.warn('session-fixation: login failed; skipping', { reason: result.reason });
    return null;
  }

  // Step 3: capture cookie post-login.
  const postCookie = await captureCookie(browser, appBaseUrl, authMeta.uiLoginPath, cookieName, cfg?.cookieCaptureTimeoutMs ?? 5000);

  if (preCookie !== null && postCookie !== null && preCookie === postCookie) {
    return {
      testId: createId(),
      detection: {
        kind: 'auth_session_fixation',
        rootCause: `Session cookie '${cookieName}' did not change after login`,
        endpoint: authMeta.uiLoginPath,
        authFlowContext: {
          invariant: 'session_id_rotates',
          cookieName,
          preValuePrefix: preCookie.slice(0, 8),
          postValuePrefix: postCookie.slice(0, 8),
        },
      },
    };
  }
  return null;
}
```

**`captureCookie`** is a small helper in the same file: opens a tab to the login URL, reads `document.cookie`, finds the named cookie, returns the value (or `null` if absent).

**Edge cases handled:**
- Pre-login cookie may be absent (`null`) if the server doesn't issue a session id until login completes. In that case we cannot detect fixation by value comparison alone — but if the **post-login** cookie equals a value the server already had access to before login (e.g. a `__Host-` prefix carrying a fixed value), we still fire. This is over-engineered for v0.7 — keep the simple `preCookie === postCookie` check; document the limitation.
- Cookie may be `HttpOnly` and not visible to `document.cookie`. Mitigation: use the camofox cookie-jar API via `browser.evaluate` if exposed; if not, log `session-fixation: skipped (HttpOnly cookie not accessible)` and bail.
- Multiple session cookies — pick the one matching `authMeta.cookieName`; if absent, take the first cookie whose name matches `/sess|session|sid/i`.

### 4.2 `checkPasswordResetReuse`

**Invariant:** a password-reset token MUST be invalidated after first use.

**Required config:** `authFlow.requestResetToolId` and `authFlow.consumeResetToolId`. Without both, this check skips with `log.info('reset-reuse: skipped (no reset toolIds configured)')`.

**Algorithm:**

```ts
async function checkPasswordResetReuse(opts: AuthFlowOptions): Promise<{ testId: string; detection: BugDetection } | null> {
  const cfg = opts.runState.config.authFlow;
  const reqId = cfg?.requestResetToolId;
  const consId = cfg?.consumeResetToolId;
  if (reqId === undefined || consId === undefined) {
    log.info('reset-reuse: skipped (toolIds missing)');
    return null;
  }

  const email = cfg.testEmail
    ?? opts.runState.config.authProbe?.testAccountUsername
    ?? 'bughunter-probe-user@invalid.test';

  // Step 1: request reset twice in succession.
  const r1 = await opts.surface.surface_call({
    toolId: reqId,
    role: 'anonymous',
    input: { email },
    noAutoRelogin: true,
  });
  const r2 = await opts.surface.surface_call({
    toolId: reqId,
    role: 'anonymous',
    input: { email },
    noAutoRelogin: true,
  });

  // Step 2: extract tokens from response bodies.
  const t1 = extractResetToken(r1.body);
  const t2 = extractResetToken(r2.body);

  if (t1 === null || t2 === null) {
    log.info('reset-reuse: skipped (could not extract token from reset response)', { hasT1: t1 !== null, hasT2: t2 !== null });
    return null;
  }

  if (t1 === t2) {
    // Server returned the same token twice — that's a separate flavour: token-not-rotated.
    return {
      testId: createId(),
      detection: {
        kind: 'password_reset_token_reuse',
        rootCause: `Reset endpoint returned identical token on two consecutive requests`,
        endpoint: reqId,
        authFlowContext: {
          invariant: 'reset_token_single_use',
          reuseCount: 0,
        },
      },
    };
  }

  // Step 3: try to consume t1 (first token).
  const c1 = await opts.surface.surface_call({
    toolId: consId,
    role: 'anonymous',
    input: { token: t1, password: 'TempReset!' + Math.random().toString(36).slice(2, 10) },
    noAutoRelogin: true,
  });

  // Step 4: try to consume t1 AGAIN.
  const c2 = await opts.surface.surface_call({
    toolId: consId,
    role: 'anonymous',
    input: { token: t1, password: 'TempReset2!' + Math.random().toString(36).slice(2, 10) },
    noAutoRelogin: true,
  });

  const c1Status = c1.status ?? 0;
  const c2Status = c2.status ?? 0;

  if (c1Status >= 200 && c1Status < 300 && c2Status >= 200 && c2Status < 300) {
    return {
      testId: createId(),
      detection: {
        kind: 'password_reset_token_reuse',
        rootCause: `Reset token redeemed twice (statuses ${c1Status}/${c2Status})`,
        endpoint: consId,
        authFlowContext: {
          invariant: 'reset_token_single_use',
          reuseCount: 2,
        },
      },
    };
  }

  return null;
}

function extractResetToken(body: unknown): string | null {
  // Common shapes: { token: '...' }, { resetToken: '...' }, { data: { token: '...' } }, '{token: "..."}'
  if (typeof body === 'string') {
    const m = body.match(/(?:reset[_-]?)?token["']?\s*[:=]\s*["']([a-zA-Z0-9_\-]{8,256})["']/i);
    return m?.[1] ?? null;
  }
  if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['token', 'resetToken', 'reset_token', 'verificationToken']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length >= 8) return v;
    }
    // Recurse one level
    const data = obj.data;
    if (data !== null && typeof data === 'object') {
      return extractResetToken(data);
    }
  }
  return null;
}
```

**Edge cases:**
- Many production reset endpoints don't return the token in the response body — they email it. In that case `extractResetToken` returns null and we skip. Document this limitation: `log.info('reset-reuse: skipped (no token in response body — email-only delivery not supported in v0.7)')`. Add a roadmap pointer for v0.8 (email-mock integration).
- The two-request rate-limiting case: if the second request 429s, we have only one token; skip.
- Token may be issued on every request even when the underlying user lookup is the same — that's actually fine and expected. We only flag if **both** tokens consume successfully.

### 4.3 `checkOpenRedirectFlow`

The v0.5 `checkOpenRedirect` in `security/header-probe.ts:243` already implements the per-param probe. This task simply wires it.

**Algorithm:**

```ts
async function checkOpenRedirectFlow(opts: AuthFlowOptions): Promise<Array<{ testId: string; detection: BugDetection }>> {
  const cfg = opts.runState.config.authFlow;
  const paramNames = cfg?.redirectParamNames ?? OPEN_REDIRECT_PARAM_NAMES;

  // Source 1: configured routes
  let candidateUrls: string[] = (cfg?.redirectRoutes ?? []).map(r =>
    r.startsWith('http') ? r : `${opts.appBaseUrl}${r}`
  );

  // Source 2: discovered pages whose route OR query string contains a param name
  const discovered = opts.runState.discovery?.pages ?? [];
  for (const page of discovered) {
    const url = page.route.startsWith('http') ? page.route : `${opts.appBaseUrl}${page.route}`;
    try {
      const u = new URL(url);
      for (const param of paramNames) {
        if (u.searchParams.has(param)) {
          candidateUrls.push(url);
          break;
        }
      }
      // Also probe routes that look like login/logout/auth surfaces (likely to have a redirect)
      if (/login|signin|signout|logout|callback|auth/i.test(u.pathname)) {
        candidateUrls.push(url);
      }
    } catch {
      // Skip unparseable URL
    }
  }

  // Dedupe; cap at config.authFlow.maxRedirectProbes ?? 30
  const unique = [...new Set(candidateUrls)].slice(0, cfg?.maxRedirectProbes ?? 30);

  const out: Array<{ testId: string; detection: BugDetection }> = [];
  for (const url of unique) {
    try {
      const detections = await checkOpenRedirect(url, paramNames);
      for (const d of detections) {
        out.push({ testId: createId(), detection: d });
      }
    } catch (err) {
      log.warn('open-redirect: probe failed', { url, err: String(err) });
    }
  }
  return out;
}
```

**`checkOpenRedirect`** in `security/header-probe.ts` already returns `BugDetection[]` with `kind: 'open_redirect'`. No changes there — the function is correct as written. We import it directly.

**Edge case:** the existing `checkOpenRedirect` checks if `Location` header includes `evil.test`. Some apps prepend the configured origin then concatenate the param value as a path (e.g. `Location: https://app.example.com/https://evil.test`) — that's still vulnerable, but the substring match catches it. Confirm with a test fixture.

### 4.4 `no_rate_limit_on_login` smoke verification (v0.5 already shipped)

The v0.5 detector at `packages/cli/src/security/auth-probes.ts:runAuthProbes` is correct. The verification task here:

1. On TraiderJo, with `authProbe.enabled: true` and `--enable-auth-probes`, run the probe against TraiderJo's login endpoint.
2. Expected: TraiderJo's `humanLimiter` middleware fires 429 before 50 attempts; detector reports `rate-limit observed` and `detections: []`.
3. **Assertion:** rerun with `humanLimiter` artificially disabled (one-line patch documented in § 11). Detector fires `no_rate_limit_on_login`.

This is **not** a code change — it's a regression test added to the smoke runbook. Document in `SPEC_V05_SECURITY_HYGIENE.md`'s Killer-Demo section as a v0.7 verification step.

---

## 5. Wiring

In `packages/cli/src/cli/run.ts`, after `runCrossUser` and before `runClassify`:

```ts
// Phase 3.6: auth-flow detectors.
const { detections: authFlowDetections, testCases: authFlowTestCases } = await runAuthFlow({
  runState,
  surface,
  browser,
  appBaseUrl: resolved.appBaseUrl ?? new URL(resolved.surfaceMcpUrl).origin,
  roles: effectiveRoles,
  maxClusters: resolved.maxBugs,
  onClusterFound: () => runState.clusterCount,
});
```

Then merge `authFlowDetections` into the classify pipeline alongside `crossUserDetections` and `headerProbeDetections`:

```ts
const staticDetectionList: BugDetection[] = [
  ...(discovery.staticDetections ?? []),
  ...(headerProbeDetections ?? []),
  ...crossUserDetections.map(d => d.detection),
  ...authFlowDetections.map(d => d.detection),
];
```

And include `authFlowTestCases` in the cluster-phase test-case list:

```ts
const allTestCases = [
  ...testCases,
  ...baselineTestCases,
  ...staticTestCases,
  ...crossUserTestCases,
  ...authFlowTestCases,
];
```

---

## 6. Test plan

### 6.1 Unit — auth-flow.ts

`packages/cli/src/phases/auth-flow.test.ts`:

- Skips when `config.authFlow.enabled !== true` → returns `abortReason: 'disabled'`.
- Session-fixation test:
  - Mock `browser.openTab` and `browser.evaluate` to return preCookie='ABC' then postCookie='ABC'. Mock `surface.surface_describe_auth` to return form auth with cookieName='sid'. Mock `loginInBrowser` to succeed.
  - Assert `auth_session_fixation` detection fires with `cookieName: 'sid'` and `preValuePrefix === postValuePrefix`.
- Session-fixation negative case: pre='ABC', post='XYZ' → no detection.
- Reset-reuse test:
  - Mock `surface_call` for `requestResetToolId` to return `{ body: { token: 'tok-1' } }` then `{ body: { token: 'tok-2' } }`.
  - Mock `surface_call` for `consumeResetToolId` to return `{ status: 200 }` for both consume calls.
  - Assert `password_reset_token_reuse` fires with `reuseCount: 2`.
- Reset-reuse negative: second consume returns 410 → no detection.
- Open-redirect: mock `fetch` (used by header-probe.ts) to return 302 + `Location: https://evil.test` for `?redirect=https://evil.test`. Assert detection.

### 6.2 Unit — extractResetToken

Same test file:

- `extractResetToken({ token: 'abc12345' })` → `'abc12345'`.
- `extractResetToken({ data: { resetToken: 'def67890' } })` → `'def67890'`.
- `extractResetToken('{"token": "ghi11122"}')` (string body) → `'ghi11122'`.
- `extractResetToken({ status: 'ok' })` → `null`.
- `extractResetToken(null)` → `null`.

### 6.3 Integration — wired into run pipeline

`packages/cli/src/cli/run-auth-flow.test.ts` (new):

- Construct a `runCommand` with mocked surface + browser. Set `config.authFlow.enabled: true` with all three checks.
- Assert that after the run, `state.json.clusters` includes any auth-flow detections that fired in mocks.
- Assert that without `config.authFlow.enabled`, none of the auth-flow logs appear (no `auth-flow:` log lines).

### 6.4 Smoke gate (manual; @qa)

- TraiderJo run with auth-flow enabled:
  - `auth_session_fixation`: 0 (TraiderJo rotates `tj_sess`).
  - `password_reset_token_reuse`: skipped if no reset toolId configured; otherwise 0 expected.
  - `open_redirect`: 0 (no obvious open-redirect param).
- TraiderJo run with `humanLimiter` patched off:
  - `no_rate_limit_on_login`: 1.

---

## 7. Files to touch

**Create:**
- `packages/cli/src/phases/auth-flow.ts`
- `packages/cli/src/phases/auth-flow.test.ts`
- `packages/cli/src/cli/run-auth-flow.test.ts` (integration)

**Modify:**
- `packages/cli/src/types.ts` — add `auth_session_fixation`, `password_reset_token_reuse` to `BugKind`; add `AuthFlowContext`; extend `BugDetection.authFlowContext`; add `AuthFlowConfig`; extend `BugHunterConfig`.
- `packages/cli/src/cluster/signature.ts` — add new cases.
- `packages/cli/src/phases/classify.ts` — slot into KIND_PRIORITY.
- `packages/cli/src/cli/run.ts` — wire `runAuthFlow` after `runCrossUser`.
- `packages/cli/src/cli/run.test.ts` (if exists) — extend.
- `packages/cli/src/security/header-probe.ts` — **no change**; we just import `checkOpenRedirect` and `OPEN_REDIRECT_PARAM_NAMES`.

---

## 8. Negative requirements

- **No new HTTP client.** Use `SurfaceMcpAdapter` and `fetch` (in `header-probe.ts` only).
- **No emoji.** Anywhere.
- **No `as any`.** Use discriminated unions and narrow.
- **No new dependency.**
- **No silent catch.** Every catch logs at `info` minimum.
- **No persistence of tokens or cookies to disk.** Capture-in-memory only.
- **No real user account creation.** Use the configured `testAccountUsername`.
- **No coupling between sub-checks.** Each is a pure function over its inputs; one fails, others continue.
- **No retry inside `runAuthFlow`.** Single attempt per sub-check; if it fails, log and move on. Retry logic, if needed, is the caller's job.
- **No mutation of `runState.discoveredIds`.** Auth-flow does not feed the IDOR matrix.
- **Functions max 40 lines.** `checkSessionFixation` and `checkPasswordResetReuse` are larger by design — extract `captureCookie` and `extractResetToken` into pure helpers; keep the orchestrators slim.
- **No call to `surface.surface_call` with `noAutoRelogin: false`** in any auth-flow check. We are **explicitly** testing what happens without re-auth.

---

## 9. Task breakdown

### Task A1 — Types + cluster signatures + classify priority

**Assignee:** @coder · **Depends on:** none · **Branch:** `feat/v07-auth-flows`

**Files to modify:** `types.ts`, `cluster/signature.ts`, `cluster/signature.test.ts`, `phases/classify.ts`

**Test:** `npx vitest run packages/cli/src/cluster/signature.test.ts`

**Done when:**
- `auth_session_fixation` and `password_reset_token_reuse` in `BugKind`.
- `AuthFlowContext` defined.
- Cluster signatures stable and tested.
- `KIND_PRIORITY` updated.
- All existing tests pass.

**DO NOT:** create the phase yet.

### Task A2 — `auth-flow.ts` phase + sub-checks

**Assignee:** @coder · **Depends on:** A1

**Files to create:** `phases/auth-flow.ts`, `phases/auth-flow.test.ts`

**Test:** `npx vitest run packages/cli/src/phases/auth-flow.test.ts`

**Done when:**
- All 3 sub-checks implemented per § 4.
- Unit tests cover positive + negative + skip paths for each.
- `extractResetToken` tested per § 6.2.
- No call to `runAuthFlow` from `cli/run.ts` yet — that's A3.

**DO NOT:** modify `runCommand` or `cli/run.ts`.

### Task A3 — Wire into run pipeline + integration test + verify v0.5 rate-limit detector

**Assignee:** @coder · **Depends on:** A2

**Files to modify:** `cli/run.ts`
**Files to create:** `cli/run-auth-flow.test.ts`

**Test:** `npx vitest run packages/cli/src/cli/run-auth-flow.test.ts`

**Done when:**
- `runAuthFlow` is called between `runCrossUser` and `runClassify`.
- Detections merge into the static-detection list and reach classify.
- TestCases merge into `allTestCases` for cluster phase.
- Integration test passes.
- Manual smoke verification of v0.5 `no_rate_limit_on_login` on TraiderJo (with and without `humanLimiter`) documented in PR description.

**DO NOT:** alter any other phase. Auth-flow is additive.

---

## 10. Acceptance

- All three tasks land in `feat/v07-auth-flows` and pass CI.
- TraiderJo run with default config: zero auth-flow clusters (auth-flow opt-in).
- TraiderJo run with `authFlow.enabled: true`: `auth_session_fixation: 0` (passes), `password_reset_token_reuse: 0` (skipped or passes), `open_redirect: 0` (no obvious param).
- Synthetic regression run with `humanLimiter` patched off (per § 11): `no_rate_limit_on_login: 1`.
- Synthetic regression run with `tj_sess` cookie rotation patched off: `auth_session_fixation: 1`.
- `npm run lint && npm run typecheck && npm test` clean.

---

## 11. TraiderJo killer-demo runbook

Append to `SPEC_V05_SECURITY_HYGIENE.md` § 10 (Killer-Demo). Steps:

### 11.1 Negative-control (TraiderJo as-is)

```bash
cd /tmp/TraiderJo
# Add to .bughunter/config.json:
#   "authProbe": { "enabled": true, "maxAttempts": 30 },
#   "authFlow": { "enabled": true, "checks": ["session_fixation", "open_redirect"] }
bughunter run --enable-auth-probes
```

Expected: 0 auth-flow / 0 rate-limit detections.

### 11.2 Synthetic-regression session-fixation

In TraiderJo `index.js` at the line that issues `tj_sess` post-login (~line 602), comment out the cookie rotation:

```js
// res.cookie('tj_sess', generateNewSid(), { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE });
```

Re-run BugHunter. Expected: 1 `auth_session_fixation` cluster.

### 11.3 Synthetic-regression rate-limit

In TraiderJo `index.js` at line 230, comment out `humanLimiter`:

```js
// app.use('/auth/login', humanLimiter);
```

Re-run BugHunter with `--enable-auth-probes`. Expected: 1 `no_rate_limit_on_login` cluster.

### 11.4 Restore TraiderJo

`git checkout index.js` in TraiderJo.

---

## 12. Risk

**Medium-high.** Auth-flow detectors mutate state — three risk axes:

1. **Reset-token consumption changes the user's password.** If `testAccountUsername` resolves to a real account by accident (typo in config), the detector resets that user's password. Mitigation: the consume-reset call always uses a random throwaway password; the user can recover via the same reset flow. The default username is `bughunter-probe-user@invalid.test` which is an invalid TLD; document that the user MUST configure a real test account before the reset-reuse check fires.
2. **Login attempts increment the user's failure counter.** If the test account exists and has a lockout policy, the run can lock it out. Mitigation: `runAuthProbes` already uses a fake-credentials approach so the password is always wrong; the failure-count rises but no real user is affected.
3. **Session-fixation flow opens a real browser tab.** If the run is interrupted (Ctrl-C), the tab leaks. Mitigation: existing `closeAllExistingTabs` (called at the start of every run) handles this. Verify in the integration test.

The **biggest** v0.7 architectural risk is that auth-flow can clash with cross-user — both phases call `surface_call` against the same role concurrently. The simple mitigation: run them **sequentially** in `cli/run.ts`. Phase order: execute → cross-user → auth-flow → classify. Document this in the spec.

---

## 13. Predicted v0.7 output on TraiderJo

With `authFlow.enabled: true` and stock TraiderJo:

| Detector | Expected outcome |
|---|---|
| `auth_session_fixation` | 0 (TraiderJo rotates `tj_sess`) |
| `password_reset_token_reuse` | 0 if reset toolIds aren't configured (skipped); 0 expected if configured (TraiderJo's reset is presumably correct) |
| `open_redirect` | 0 (no obvious open-redirect param in TraiderJo's surface) |
| `no_rate_limit_on_login` | 0 (TraiderJo has `humanLimiter`) |

After the synthetic regressions in § 11.2 and § 11.3:

| Detector | Expected outcome |
|---|---|
| `auth_session_fixation` | 1 (`tj_sess` did not rotate) |
| `no_rate_limit_on_login` | 1 (50 bogus credential POSTs accepted without 429) |

The TraiderJo demo for v0.7: **the scanner correctly flags both regressions and stays silent on the unmodified app.** That is the killer-demo proof point.

---

## 14. Open questions

None. Ship.
