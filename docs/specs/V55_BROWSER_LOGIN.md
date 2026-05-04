# SPEC — v0.55 "Browser-login support: real recall through auth-gated routes"

**Status:** Draft 1 — ready for `@coder` assignment after V55.1 review
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-05-02
**Issue:** cunninghambe/BugHunter#166
**Smoke baseline:** Smoke #13 — comprehensive-bench, 14.1% recall (29/29 routes crawled, but 22 of 29 returned the unauth skeleton; 0 BugKinds reachable on auth-gated routes)
**Sibling specs:** V53 multi-surface (per-surface `auth` model deferred to V53.2 — this spec lands V53.2 for free, see § 7); V54 comprehensive-bench (consumer of this spec)
**Out of scope (firm):** SAML / OAuth / OIDC interactive flows; MFA / TOTP / SMS code entry; passkey / WebAuthn; CAPTCHA solving; cross-surface session sharing.

---

## 1. Problem statement

Smoke #13 against `comprehensive-bench` walked 29 routes, 22 of which auth-gate behind a cookie-JWT login (`POST /api/auth/login` → sets `bench_session` HttpOnly cookie). BugHunter never logged in, so all 22 routes returned the unauth skeleton (`<main>` empty, no in-page DOM, no API calls). The result was 14.1% recall — every UI-origin BugKind that lives behind login (`a11y_*`, `react_error`, `seo_*`, `keyboard_trap`, `slow_lcp`, `idor_*`, `crud_no_authz`, `xss_reflected_into_authed_view`, ~60 kinds total) was structurally unreachable. The same shape blocks Aspectv3 (form-fill `/login`, cookie-session) and any real-world target with a UI front door.

The headline is partially mis-framed: BugHunter's runtime *does* perform browser-login already — `packages/cli/src/discovery/browser-login.ts` (854 lines, well-tested) drives form-fill + submit + verify and supports `cookie | redirect | status | localStorage | dom_signal` success-checks. `packages/cli/src/phases/multi-context-runner.ts` already logs in N parallel tabs as different roles for cross-user IDOR. **What is broken is the upstream contract:**

1. `packages/cli/src/config.ts` Zod schema accepts only `auth: z.object({ kind: z.literal('none') }).optional()` (line 145). The `comprehensive-bench` `bughunter.config.json` declares `auth.kind: "credentials"` with embedded `credentials[]` — Zod rejects, the user sees a hard config-validation failure, and BugHunter never starts.
2. The auth *plan* (login URL, fields, success-check, credentials) is owned by SurfaceMCP and exposed via `surface_describe_auth`. BugHunter consumes it. But for SurfaceMCP to return a usable plan, the **SurfaceMCP** config must declare full auth metadata (not BugHunter's). The two configs got conflated in past audits.
3. `surface_describe_auth` returns only six discriminants today — `none | bearer | api_key | anonymous | form | nextauth` (`packages/cli/src/adapters/surface-mcp.ts:182`). It has no kind for "login is an API endpoint that returns Set-Cookie" — the comprehensive-bench shape. Browser-login can substitute `form` (drive the UI form), but a programmatic POST is faster, deterministic, and required for headless API-only smoke runs.

This spec lands the contract: BugHunter's config schema accepts the bench's shape, the form path keeps working, a new `cookie-endpoint` auth kind is added end-to-end (BugHunter config → SurfaceMCP plan → BugHunter login executor), per-role login is wired through cross-user, and per-surface auth (V53.2) lands in the same patch series.

---

## 2. Goals / non-goals

### 2.1 In scope
- **Config schema.** Extend BugHunter's `auth` Zod schema beyond `{ kind: 'none' }` to accept `cookie | form | bearer` with full credentials and login metadata. Existing `{ kind: 'none' }` and `{ kind: 'bearer' }` (V42-era) configs validate unchanged.
- **`cookie-endpoint` auth kind, end-to-end.** Programmatic POST → server returns Set-Cookie → BugHunter sets cookie on the browser context → crawl continues authed. Adds `authKind: 'cookie_endpoint'` to `DescribeAuthResult` and a `loginViaCookieEndpoint` executor.
- **Form auth: tighten the contract.** The existing form path stays. Document the BugHunter-side config field that drives a SurfaceMCP-form login when SurfaceMCP itself can't auto-generate the plan (e.g. for fixtures with no SurfaceMCP descriptor).
- **Per-role login for cross-user.** `multi-context-runner` already calls `loginInTabScope` per role; thread richer credentials maps so peer roles (`member`, `member-other`, `admin`) get logged in deterministically with their own credentials.
- **Per-surface auth (V53.2 implementation).** `config.surfaces[name].auth` now accepts the full shape (not just `{ kind: 'none' }`). `mergePerSurfaceConfig` selects per-surface auth, with top-level fall-through.
- **Browser-login phase integration.** Discover phase calls login *once per role we want to crawl as*, not just once total (today: only `loginRole`). Each crawl pass sees the right cookie jar.
- **Acceptance gate.** Smoke #14 against comprehensive-bench reaches ≥ 40% recall (target: 60% — quantified in § 9).

### 2.2 Out of scope (firm)
- **SAML / OAuth / OIDC interactive redirects.** Defer to V56. Out-of-band identity providers, browser redirect chains across third-party hosts, and consent screens require a separate threat model.
- **MFA / TOTP / SMS / email-link.** V56+. Detected today and reported as `two_factor_detected` — that path stays.
- **Passkey / WebAuthn.** V56+. Requires platform-authenticator emulation we do not own.
- **CAPTCHA solving.** Detected today as `captcha_detected` — stays a soft skip with `skipItem` emitted.
- **Cross-surface session sharing.** A session minted on `comprehensive-bench-web` does NOT auto-flow to `comprehensive-bench-api`; each surface logs in independently via its own `surface_describe_auth`. (Mirrors V53 § 2.2 firm rule.)
- **Logout-flow testing as a BugKind.** `logoutUrl` is recorded for completeness (used by session-fixation already) but no new logout-specific detector lands here.
- **Hot-reload of credentials.** Credentials are read once at config-load; rotation requires re-running BugHunter.

---

## 3. Architecture decision: BugHunter config carries credentials; SurfaceMCP carries the plan

Two architectures were considered:

- **A — BugHunter expresses the full login flow itself.** `config.auth.loginUrl`, `config.auth.loginSelector`, `config.auth.loginSuccessCheck` all in BugHunter config. BugHunter drives the login without consulting SurfaceMCP for a plan.
- **B — SurfaceMCP owns the plan; BugHunter owns credentials and a thin "kind" hint.** BugHunter's `config.auth.kind` is a *what*, not a *how*. The *how* is `surface_describe_auth`, which SurfaceMCP synthesizes from its own config.

**Decision: B.** Justification:
1. SurfaceMCP already returns a plan with field selectors, success-check, and trigger metadata. Re-implementing that in BugHunter doubles the surface area and creates two truths.
2. The existing `loginInBrowser` / `loginInTabScope` pipeline takes a `BrowseableAuthPlan` from `DescribeAuthResult` — already proven on `idor-bad`, `bughunter-self-deliberate-bugs`, real Aspectv3 runs.
3. V53 already declares per-surface auth as a SurfaceMCP-config concern (V53 § 6). Architecture B is the consistent extension.
4. Architecture A duplicates a 600-line surface owned by SurfaceMCP, which is the wrong direction.

**Boundary:** BugHunter's `config.auth` carries (a) the *kind discriminant* — telling BugHunter whether to skip login, attempt browser-form, attempt cookie-endpoint, or attach a static bearer; and (b) the *credentials map* — the username/password/token values that flow into per-role login. SurfaceMCP carries the *plan* — login URL, field selectors, success-check, cookie name. BugHunter merges credentials + plan at login time.

**Single new exception:** `cookie-endpoint` auth needs login *URL + body shape* on the BugHunter side too, because the call is direct (not via SurfaceMCP). For consistency, BugHunter accepts those fields in `config.auth` and SurfaceMCP also returns them in `DescribeAuthResult` (for surfaces where SurfaceMCP knows about them) — BugHunter prefers the SurfaceMCP plan when present; falls back to BugHunter config when not.

---

## 4. Existing code map — read first

### 4.1 Files you MUST read before any code

- `/root/BugHunter/packages/cli/src/discovery/browser-login.ts` — 854 lines, owns the form-fill flow. EXTEND this file; do NOT create a new login executor.
- `/root/BugHunter/packages/cli/src/discovery/browser-login.test.ts` — 700+ lines of tests. ADD test cases here; do NOT create a new test file.
- `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` — `DescribeAuthResult` discriminated union (line 182). EXTEND the union; do NOT redefine.
- `/root/BugHunter/packages/cli/src/phases/discover.ts` lines 33–88 — `runBrowserLoginPhase` is the discover-phase login entry-point. EXTEND in place.
- `/root/BugHunter/packages/cli/src/phases/multi-context-runner.ts` lines 280–420 — per-tab login for cross-user. The `loginInTabScope` calls there already loop per role.
- `/root/BugHunter/packages/cli/src/phases/auth-flow.ts` lines 83–146 — session-fixation already calls `loginInBrowser` after capturing the pre-cookie. Reference; no change needed in V55.1–V55.3.
- `/root/BugHunter/packages/cli/src/config.ts` line 145 — Zod schema for `auth`. EXTEND in place.
- `/root/BugHunter/packages/cli/src/types.ts` lines 1381–1392 (`BrowserLoginConfig`), lines 1593–1612 (`BugHunterConfig.auth` and `BugHunterConfig.surfaces[*].auth`). EXTEND in place.
- `/root/BugHunter/packages/cli/src/cli/run.ts` lines 552–577 — afterLogin / perRole hooks fire at the right point already; threading per-role login into the multi-surface pass extends this block.
- `/root/BugHunter/docs/specs/V53_MULTI_SURFACE_CONSUMER.md` § 6.5, § 11.2, § 11.3, § 11.5 — the per-surface auth model V55 lands.

### 4.2 Patterns to follow
- Discriminated unions for `DescribeAuthResult` and `auth` config (matches existing pattern).
- `loginInBrowser` returns a `LoginResult` discriminated on `ok` — keep the same shape for `loginViaCookieEndpoint`.
- `BoundSurfaceMcpAdapter` (V53.1) — wraps the surface in the per-surface arg. Use it; don't pass surface name through method args.
- Telemetry — every login emits a `log.info` with `{ surface, role, kind, ok }` fields.

### 4.3 DO NOT
- Do NOT create a new file for cookie-endpoint login. Add `loginViaCookieEndpoint` and `loginInCookieScope` to `browser-login.ts`.
- Do NOT add a separate `auth` parser. Extend the Zod object in `config.ts`.
- Do NOT bypass `surface_describe_auth`. Even for cookie-endpoint, BugHunter calls SurfaceMCP first; the BugHunter-config fields are the fallback when SurfaceMCP returns `authKind: 'none'` or doesn't know.
- Do NOT introduce `any`. Errors get `unknown` and narrow.
- Do NOT add retry loops to the login executor. A failed login is a soft skip with a recorded `LoginFailureReason`.
- Do NOT wire SAML/OAuth in this PR. Hard rejection at config-validation time.
- Do NOT change `loginInBrowser`'s public signature. Add a sibling executor `loginViaCookieEndpoint`. The phase chooses which to call based on `plan.authKind`.

---

## 5. Config schema (Zod) — full shape

`packages/cli/src/config.ts`. The current schema (line 145):

```ts
auth: z.object({ kind: z.literal('none') }).optional(),
```

V55 replaces it with a discriminated union:

```ts
const AuthCredentialSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  email: z.string().email().optional(),
  token: z.string().optional(),
  cookie: z.string().optional(),  // raw cookie value for pre-baked sessions
}).refine(
  c => c.username !== undefined || c.email !== undefined || c.token !== undefined || c.cookie !== undefined,
  { message: 'credentials entry needs at least one of username/email/token/cookie' },
);

const AuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('bearer'),
    token: z.string().min(1).optional(),  // top-level static token (V42 shape)
    credentials: z.record(z.string(), AuthCredentialSchema).optional(),
  }),
  z.object({
    kind: z.literal('form'),
    loginUrl: z.string().optional(),  // fallback when surface_describe_auth doesn't know
    fields: z.object({
      username: z.string().optional(),  // selector or name fragment for username/email field
      password: z.string().optional(),
      submit: z.string().optional(),
    }).optional(),
    successCheck: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cookie'), name: z.string().min(1) }),
      z.object({ kind: z.literal('redirect'), to: z.string().min(1) }),
      z.object({ kind: z.literal('dom_signal'), selector: z.string().min(1) }),
    ]).optional(),
    logoutUrl: z.string().optional(),
    credentials: z.record(z.string(), AuthCredentialSchema),  // role -> creds, REQUIRED for form
  }),
  z.object({
    kind: z.literal('cookie'),  // cookie-endpoint: programmatic POST + Set-Cookie response
    loginEndpoint: z.object({
      method: z.literal('POST'),
      url: z.string().min(1),
      bodyShape: z.enum(['json', 'form-encoded']),
      usernameField: z.string().default('email'),  // body key for username/email
      passwordField: z.string().default('password'),  // body key for password
    }),
    cookieName: z.string().min(1),  // session cookie BugHunter watches for after POST
    logoutEndpoint: z.object({
      method: z.literal('POST'),
      url: z.string().min(1),
    }).optional(),
    credentials: z.record(z.string(), AuthCredentialSchema),  // role -> creds, REQUIRED
  }),
  // V42 shape — kept for migration. New configs should use 'form' or 'cookie'.
  z.object({
    kind: z.literal('credentials'),  // legacy alias for 'cookie' or 'form' depending on tokenStorage
    loginUrl: z.string().optional(),
    loginEndpoint: z.string().optional(),
    tokenStorage: z.enum(['httpOnly-cookie', 'localStorage', 'bearer-header']).optional(),
    credentials: z.array(z.object({
      role: z.string(),
      email: z.string().email().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })).optional(),
  }).transform(legacy => migrateLegacyCredentials(legacy)),
]).optional();
```

**Migration shim** (`migrateLegacyCredentials`): the bench's `auth.kind: 'credentials'` shape (with `tokenStorage: 'httpOnly-cookie'`) becomes:

- `kind: 'cookie'` (or `'form'` if `tokenStorage === 'localStorage'`)
- `credentials[]` array → `credentials: Record<string, {email,password}>` keyed by `role`
- `loginEndpoint: 'POST /api/auth/login'` string → `{ method: 'POST', url: '/api/auth/login', bodyShape: 'json', usernameField: 'email', passwordField: 'password' }`

The shim keeps existing comprehensive-bench `bughunter.config.json` validating without rewrites. We log `WARN config: 'credentials' is a legacy auth.kind; prefer 'cookie' or 'form' (will be removed in v0.60)` once per run.

### 5.1 `BugHunterConfig.auth` TS type (parallel to Zod)

`packages/cli/src/types.ts` line 1599 — replace single-shape with the union, exported as `AuthConfig`:

```ts
export type AuthCredentials = {
  username?: string;
  password?: string;
  email?: string;
  token?: string;
  cookie?: string;
};

export type AuthConfig =
  | { kind: 'none' }
  | { kind: 'bearer'; token?: string; credentials?: Record<string, AuthCredentials> }
  | {
      kind: 'form';
      loginUrl?: string;
      fields?: { username?: string; password?: string; submit?: string };
      successCheck?: { kind: 'cookie'; name: string }
                   | { kind: 'redirect'; to: string }
                   | { kind: 'dom_signal'; selector: string };
      logoutUrl?: string;
      credentials: Record<string, AuthCredentials>;
    }
  | {
      kind: 'cookie';
      loginEndpoint: {
        method: 'POST';
        url: string;
        bodyShape: 'json' | 'form-encoded';
        usernameField: string;
        passwordField: string;
      };
      cookieName: string;
      logoutEndpoint?: { method: 'POST'; url: string };
      credentials: Record<string, AuthCredentials>;
    };
```

`BugHunterConfig.auth?: AuthConfig` and `BugHunterConfig.surfaces[name].auth?: AuthConfig`. Top-level fall-through preserved per V53.

---

## 6. `surface_describe_auth` extension — `cookie_endpoint`

`packages/cli/src/adapters/surface-mcp.ts` line 182. EXTEND the union:

```ts
export type DescribeAuthResult =
  | { authKind: 'none'; reason: 'no_auth_configured' }
  | { authKind: 'bearer'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'api_key'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'anonymous'; reason: 'role_has_no_credentials' }
  | { authKind: 'form'; /* unchanged */ ... }
  | { authKind: 'nextauth'; /* unchanged */ ... }
  | {
      authKind: 'cookie_endpoint';
      loginEndpoint: { method: 'POST'; url: string; bodyShape: 'json' | 'form-encoded' };
      usernameField: string;
      passwordField: string;
      cookieName: string;  // session cookie name to verify
      successCheck: { kind: 'cookie'; name: string };  // always cookie-kind for this auth
    };
```

The corresponding SurfaceMCP-side change is owned by SurfaceMCP — track in cunninghambe/SurfaceMCP#21 (filed alongside this spec). BugHunter consumes the new variant from V55.2 onward; if SurfaceMCP < the version that adds it, BugHunter falls back to its own `config.auth` for cookie-endpoint synthesis (§ 5).

---

## 7. Per-surface auth — V53.2 implementation in this patch

`mergePerSurfaceConfig(config, surfaceName)` was sketched in V53 § 6.4; V55 lands it. The merged config's `auth` is:

1. `config.surfaces?.[surfaceName]?.auth` if set → use verbatim
2. Else `config.auth` if set → use verbatim
3. Else `{ kind: 'none' }` → skip login

Test matrix (extends `packages/cli/src/cli/run.test.ts`):
- Top-level `auth.kind: 'cookie'`, no per-surface — every surface inherits cookie auth.
- Top-level `auth.kind: 'none'`, `surfaces.web.auth.kind: 'cookie'` — `web` logs in; other surfaces skip.
- Top-level absent, per-surface `web.auth.kind: 'form'` — `web` logs in; other surfaces skip with `'no_auth_configured'`.

Per-surface `credentials` are looked up by *role name*. The role names must match between surfaces for cross-surface stories (acceptance § 9.4). When a role exists in one surface's credentials but not another, the missing-credential surface skips that role's login with `LoginFailureReason: 'role_has_no_credentials'`.

---

## 8. Browser-login phase integration — per-role login

**Today:** `runBrowserLoginPhase` (discover.ts:33–88) logs in *one* role (`browserLogin.role` or `roles[0]`). The crawl that follows sees that one role's view.

**V55.3 change:** for each role we crawl as, login first, then crawl. The crawl loop becomes role-scoped.

Pseudocode for the new shape (no implementation here — that's coder's job):

```
for role in rolesToCrawl(config):
  loginResult = runBrowserLoginPhase(config, browser, surface, role)
  if loginResult.ok:
    discoveryForRole = walkDom + crawlFromSeeds(scope=loginResult.tabScope)
  else:
    discoveryForRole = walkDom + crawlFromSeeds(scope=anonymous)
    skippedItems.push({ route: '<login>', reason: `browser_login_${loginResult.reason}` })
  mergePages(discoveryForRole)
```

Cluster signature already includes role (V53 § 5.3) so per-role discoveries don't double-count.

`rolesToCrawl(config)` returns:
- `[browserLogin.role]` if explicitly set (back-compat)
- Otherwise the set of roles in `config.auth.credentials` keys, capped by `config.crawl.maxLoginRoles ?? 2` (defaults: 2 — the "primary" + one peer for IDOR coverage; full N-role crawl gated behind `--all-roles` flag for cost reasons).

V55.3 keeps `rolesToCrawl` returning a single role by default; opt-in to multi-role via `crawl.maxLoginRoles >= 2`. This avoids a 4× crawl-time blowup for users on the existing `auth.kind: 'none'` path.

---

## 9. Phasing

The deliverable is split into four shippable patches. Each is independently testable and reviewable. Each has a smoke gate.

### V55.1 — Config schema + form auth, single-role browser-login (this patch lands first)
**Scope:** § 5 (config schema + Zod), § 5.1 (TS types), § 7 partial (per-surface schema only — no per-role-login crawl yet), regression hardening on existing `loginInBrowser` form path.

**Files modified:** `config.ts`, `types.ts`, `cli/run.ts` (mergePerSurfaceConfig only), `discovery/browser-login.ts` (no new executor — only tighter argument typing if needed).
**Files created:** `config-auth-migrate.ts` for the legacy-shape shim. One new file, one specific reason.

**Done when:**
- Comprehensive-bench `bughunter.config.json` (`auth.kind: 'credentials'`) validates without rewrite.
- `auth.kind: 'cookie' | 'form' | 'bearer' | 'none'` all validate.
- `config.surfaces[*].auth` accepts the full union.
- `mergePerSurfaceConfig` resolves per-surface auth correctly (§ 7 test matrix).
- Existing form-login fixtures (idor-bad, bughunter-self-deliberate-bugs) pass smoke unchanged.

### V55.2 — Cookie-endpoint auth executor
**Scope:** new `loginViaCookieEndpoint` in `browser-login.ts`; new `cookie_endpoint` arm in `surface_describe_auth` consumer; new branch in `runBrowserLoginPhase` and `multi-context-runner` that selects executor by `plan.authKind`.

**Files modified:** `browser-login.ts` (add ~150 lines: executor + cookie-set helper), `phases/discover.ts` (branch on plan), `phases/multi-context-runner.ts` (branch in `getLoginPlan` + per-tab login dispatch), `adapters/surface-mcp.ts` (extend `DescribeAuthResult`).
**Files created:** none.

**Done when:**
- Comprehensive-bench `auth.kind: 'cookie'` config logs in via POST /api/auth/login, BugHunter sets cookie on browser context, subsequent navigation sees authed routes.
- Smoke #14a (cookie-endpoint only) reaches ≥ 35% recall.
- A unit test in `browser-login.test.ts` mocks the POST endpoint, verifies cookie is set, verifies subsequent `getCookieNames` includes the session cookie.

### V55.3 — Per-role multi-context login
**Scope:** § 8. `multi-context-runner` already does this for cross-user; V55.3 generalizes to the *crawl* phase so each role's view is independently discovered.

**Files modified:** `phases/discover.ts` (loop in `runBrowserLoginPhase` over roles, fan-out crawl), `cli/run.ts` (afterLogin/perRole hooks fire per-role), `types.ts` (add `crawl.maxLoginRoles`).
**Files created:** none.

**Done when:**
- With `crawl.maxLoginRoles: 2`, comprehensive-bench discovers `member`'s view AND `member-other`'s view; cluster count for `idor_*` increases.
- Default behaviour (no `maxLoginRoles`) is unchanged from V55.2.
- Smoke #14b reaches ≥ 50% recall on comprehensive-bench.

### V55.4 — Per-surface auth migration polish + telemetry
**Scope:** finish V53.2 deferred work — telemetry attribution per-surface, summary report fields, deprecation warning on legacy `auth.kind: 'credentials'`.

**Files modified:** `phases/emit.ts` (summary fields), `cli/run.ts` (deprecation log), `docs/MIGRATION_V42_TO_V55.md` (new — single doc file, justified).
**Files created:** `docs/MIGRATION_V42_TO_V55.md`.

**Done when:**
- Run summary `summary.json.surfaces[].authKind` is populated.
- Migration doc shipped.
- Smoke #14 (full) reaches ≥ 60% recall on comprehensive-bench.

---

## 10. Acceptance criteria

### 10.1 Config validation
- `comprehensive-bench/bughunter.config.json` (legacy `kind: 'credentials'` shape) loads without modification.
- `aspectv3/bughunter.config.json` (canonical `kind: 'form'` shape, `successCheck.kind: 'cookie'`) loads.
- `bughunter-self-deliberate-bugs/bughunter.config.json` (`kind: 'none'`) loads unchanged.
- A config with `kind: 'oauth'` errors out at load time with a clear "auth kind not supported in v0.55; see V56" message.

### 10.2 Recall lift on comprehensive-bench
- **Smoke #14 (V55.4 gate):** ≥ 60% recall (defined as `(matched_golds / total_golds)` against the comprehensive-bench gold-set). Baseline: 14.1%. Target lift: 4.3×. The bench has 22 of 29 routes auth-gated, so ~75% of total routes become reachable; with per-route detector hit-rate of ~80% on routes-that-render, theoretical ceiling is ~60% — V55.4 must approach that.
- **Smoke #14a (V55.2 gate):** ≥ 35% recall (single-role, cookie-endpoint).
- **Smoke #14b (V55.3 gate):** ≥ 50% recall (multi-role, IDOR + crud_no_authz lifts).

### 10.3 Aspectv3 end-to-end
A BugHunter run against Aspectv3 with `auth.kind: 'form'`, `credentials.member: { email, password }`, and `surface_describe_auth` returning the form plan, completes login and crawls all 30+ post-login routes. Verified by `discovery.pages` count ≥ 30 and `discovery.skipped` count for `browser_login_*` reasons === 0.

### 10.4 Single-surface, single-role legacy fixtures unchanged
`fixtures/idor-bad`, `fixtures/v52-visual-regression`, `fixtures/agentic-stub` produce identical cluster counts to v0.54. The schema migration is purely additive.

### 10.5 Failure isolation
- Login failure on one role does not abort the run. The role is recorded in `discovery.skipped[]` with `reason: 'browser_login_<reason>'`; other roles' crawls proceed.
- Login failure on one surface (multi-surface config) does not abort sibling surfaces (V53 § 11.6 already covers this — V55 must not regress it).
- A 401 on the cookie-endpoint POST returns `LoginResult.ok: false, reason: 'submit_failed'` (semantically: server rejected) — never a thrown error.
- A 5xx on the cookie-endpoint POST returns `LoginResult.ok: false, reason: 'login_page_load_failed'` (semantically: endpoint broken).

### 10.6 SurfaceMCP < `cookie_endpoint`-aware version compatibility
If SurfaceMCP returns `authKind: 'none'` or doesn't recognize the surface's auth shape, BugHunter falls back to its own `config.auth.kind: 'cookie'` block and constructs the login call from BugHunter-side fields. Tested in `browser-login.test.ts` with a stub SurfaceMCP that returns `none`.

### 10.7 Negative criteria
- No new `any` introduced in any of these files.
- No `console.*` calls (use `log.info` / `log.warn`).
- No file >300 lines is added; if `browser-login.ts` exceeds 1000 lines after V55.2, split `loginViaCookieEndpoint` into a helper file `browser-login-cookie.ts` co-located.
- No retry loop on login. A failed login is a soft-skip.

---

## 11. Test strategy

### 11.1 Unit tests
| Test                                                                          | File (new or existing)                                       |
|-------------------------------------------------------------------------------|--------------------------------------------------------------|
| Zod accepts `auth.kind: 'cookie'` with full shape                             | `packages/cli/src/config.test.ts` (NEW)                      |
| Zod accepts `auth.kind: 'form'` with credentials map                          | same                                                         |
| Zod accepts `auth.kind: 'credentials'` (legacy) and migrates to `'cookie'`    | same                                                         |
| Zod rejects `auth.kind: 'oauth'` with helpful message                         | same                                                         |
| `mergePerSurfaceConfig` — per-surface `auth.kind: 'cookie'` overrides top    | `packages/cli/src/cli/run.test.ts` (EXTEND)                  |
| `loginViaCookieEndpoint` — POST returns Set-Cookie → cookie set on browser   | `packages/cli/src/discovery/browser-login.test.ts` (EXTEND)  |
| `loginViaCookieEndpoint` — 401 returns `submit_failed` (no throw)            | same                                                         |
| `loginViaCookieEndpoint` — 5xx returns `login_page_load_failed`               | same                                                         |
| `loginViaCookieEndpoint` — missing credentials returns `role_has_no_credentials` | same                                                      |
| `runBrowserLoginPhase` — branches on `plan.authKind === 'cookie_endpoint'`    | `packages/cli/src/phases/discover.test.ts` (EXTEND)          |
| `runBrowserLoginPhase` — `crawl.maxLoginRoles: 2` logs in twice              | same                                                         |

### 11.2 Integration tests
- `fixtures/comprehensive-bench` (or a stripped-down clone in `fixtures/auth-cookie-bench`) — boot the bench, run BugHunter, assert ≥ 22 authed routes appear in `discovery.pages`.
- Existing form-login fixture (`fixtures/idor-bad`) — assert behaviour unchanged.

### 11.3 Smoke gates
- Smoke #14 (and sub-gates a/b) defined in `tests/smoke/recall-comprehensive-bench.ts`. Each phasing milestone gated on its corresponding smoke target.

---

## 12. Migration / back-compat

- **V42 single-surface `auth: { kind: 'none' }`** — validates unchanged. Behaviour unchanged.
- **V42 single-surface `auth: { kind: 'bearer', token: '...' }`** — validates unchanged. Behaviour unchanged (token attached to API tools).
- **V53/V54 `surfaces` block with per-surface `auth: { kind: 'none' }`** — validates unchanged. Behaviour unchanged.
- **Legacy `auth.kind: 'credentials'`** — validates via migration shim; deprecation warning logged once per run; behaviour: equivalent to `kind: 'cookie'` with `loginEndpoint: { method: POST, url: <loginEndpoint string parsed>, bodyShape: 'json' }`. Removal scheduled for V60.

No fixture or production config requires hand-editing for V55.1. V55.4 ships the migration doc encouraging users to move off `kind: 'credentials'`.

---

## 13. Open questions

These are not blockers — defaults given. Re-spec only if a stakeholder objects.

1. **Default `crawl.maxLoginRoles`** — V55.3 ships at `1` (no behaviour change). A separate spec discussion will raise it to `2` if the cost-vs-recall trade is worth it.
2. **Bearer-token rotation** — out of scope for V55. If a token expires mid-run, V42 behaviour is preserved (re-login probe in `validate.ts`).
3. **Cookie-endpoint with CSRF** — comprehensive-bench has no CSRF gate on /api/auth/login. Real-world targets often do. V56 spec will add `csrfPrime: { url, tokenCookieName, tokenHeaderName }` to the cookie-endpoint shape.
4. **Pre-baked `cookie` credential** — `AuthCredentials.cookie` is in the schema (for users who already have a session and want to bypass login). Not in V55 acceptance gates; lands as a side-effect of the schema. Tested in 11.1 only at validation level.

---

## 14. Risks

- **Risk:** SurfaceMCP doesn't ship `authKind: 'cookie_endpoint'` in time. **Mitigation:** § 10.6 — BugHunter falls back to its own `config.auth` block. SurfaceMCP upgrade is a quality-of-life improvement, not a V55 blocker.
- **Risk:** Comprehensive-bench's gold-set wasn't sized assuming 22 newly reachable routes — recall target may overshoot or undershoot. **Mitigation:** smoke gates at multiple phasing levels (V55.2/.3/.4) let us recalibrate.
- **Risk:** Per-role crawl in V55.3 quadruples runtime. **Mitigation:** opt-in via `crawl.maxLoginRoles`; default 1.
- **Risk:** Legacy-shape migration shim has bugs that silently miscoerce credentials. **Mitigation:** dedicated test in 11.1 + a `WARN` log on every migration trigger so users see it.
