# SPEC — v0.5 "Security & Surface Hygiene"

**Status:** Draft 1, ready for @coder/@designer assignment · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-27 · **Source roadmap:** `SPEC_COMPREHENSIVE_ROADMAP.md` §6.v0.5 + §8 resolutions · **Predecessor:** v0.4 vision (`SPEC_VISION_DETECTION.md`, shipped) · **Successor:** v0.6 "Performance & Web Vitals" (separate spec, not yet written).

This spec is the **implementation contract** for v0.5. It is coder-implementable end-to-end. Every BugKind, every infrastructure module, every config knob, and every CLI surface is named here. The §8 user resolutions in the roadmap (Q1–Q8) and the spec defaults for Q9–Q10 are baked in; do not re-litigate them in code review.

When a phrase appears in **bold** in a Done-when clause, the verifier (test or human) should look for it literally.

---

## 0. Reading guide

| Section | Audience | When to read |
|---|---|---|
| §1 Objective + boundaries | everyone | first |
| §2 Existing code map | @coder before any task | before keyboard touch |
| §3 Cross-cutting infra (5 modules) | @coder per assigned module | before that module's tasks |
| §4 BugKind specs (16 kinds) | @coder per assigned kind | before that kind's tasks |
| §5 Vision auth refactor (sub-spec) | @coder + @designer | before vision work |
| §6 CLI surfaces (`suppress`) | @coder | before CLI work |
| §7 Negative requirements | everyone | before commit |
| §8 Task breakdown + ownership | @architect (assigning) + assignee | per task |
| §9 Acceptance + done-when matrix | @qa + @architect | end of phase |
| §10 Killer-demo runbook (TraiderJo) | @architect closing v0.5 | end-of-phase verification |

---

## 1. Objective

Ship 18 new `BugKind`s in five clusters (IDOR / headers / auth probes / static analysis / synthetic interactions) plus the cross-cutting infrastructure they depend on, without breaking v0.4 vision or any existing detector. Refactor vision auth to prefer the local Claude CLI (per Q8) so non-API-key users get vision automatically. (The roadmap appendix §10 said "16"; reconciled here. The actual list spans IDOR (3) + open redirect (1) + headers (3) + CSRF (1) + auth probes (1) + static analysis (3) + body/url leaks (2) + synthetic (2) + LLM-era (1) + react refinement (1) = 18.)

**Out of scope** for v0.5 (do not implement, even partially):

- `slow_lcp` / `slow_inp` / `slow_cls`, `n_plus_one_api_calls`, `bundle_size_exceeded` (v0.6).
- Real CDP heap / performance metrics (v0.6).
- `xss_reflected`, `xss_stored`, `xss_dom`, `sql_injection_suspected`, `default_creds`, `password_reset_token_reuse` (v0.7).
- Multi-viewport, multi-browser (v0.8 / v0.9).
- LLM-of-source / LLM-of-response pipeline (v0.7).
- The full Q9 invariants block (v1.0).
- The `bughunter watch` command (v0.7+; we only set up architectural re-entrancy now).

The shape of v0.5: **wrap OSS tools where they exist** (`gitleaks`, `npm audit`, `semgrep` OSS, eslint `no-empty`); **build native checks where existing tools don't have BugHunter's per-action context** (IDOR, header probes, optimistic-update divergence); **reserve names** for v0.7 deliverables (`sql_injection_suspected`'s wrapper skeleton; the suppression CLI; the natural-language invariants placeholder).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

These exist today, are stable, and must be **extended, not duplicated**. Each is critical for a specific v0.5 module:

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | `BugKind` union, `BugDetection`, `BugCluster`, `BugHunterConfig`, `RunState`, `RunSummary`. ALL new types extend this file; do not create a parallel `types-v05.ts`. |
| `packages/cli/src/cluster/signature.ts` | Cluster-signature derivation. Every new BugKind requires a new `case` in `clusterSignature` and (where applicable) a new branch in `extractNormalizedFields`. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. New kinds slot in by priority; security findings rank above visual but below `unhandled_exception`. Pattern documented in §3.1. |
| `packages/cli/src/phases/execute.ts` | The phase pipeline. New cross-user phase runs **after** execute, before classify; new header probe runs **inside** execute as a per-page hook. |
| `packages/cli/src/phases/cluster.ts` | Cluster materialization + `occurrenceIdByTestId` contract. New phases that produce detections must mint occurrence ids the same way. |
| `packages/cli/src/adapters/surface-mcp.ts` | The SurfaceMCP HTTP adapter. New cross-user replay reuses this; do not create a second HTTP client. |
| `packages/cli/src/adapters/browser-mcp.ts` | Browser MCP adapter. New synthetic scenarios drive through this surface. |
| `packages/cli/src/adapters/vision-client.ts` | Existing vision client. The new `claudeCli` auth is a **third class implementing `VisionClientInterface`**, not a fork of `AnthropicVisionClient`. |
| `packages/cli/src/classify/network.ts` | `normalizePath()`. Reuse for IDOR endpoint normalization; do not reimplement path-id replacement. |
| `packages/cli/src/classify/state-change.ts` | Mutation-observer pattern. Reuse for `optimistic_update_divergence` (we observe DOM and HAR together). |
| `packages/cli/src/repro/action-log.ts` | Action-log writer. New phases that produce occurrences must call `writeActionLog` so the action is replayable. |
| `packages/cli/src/store/filesystem.ts` | `runPaths()`. All run artifacts live under `runs/<runId>/`. Do not write outside this path; do not introduce process-global state (Q4 re-entrancy). |
| `packages/cli/src/log.ts` | The structured logger. Use it; do not `console.log`. |
| `packages/cli/src/discovery/crawler.ts` | The crawler. Header probes run as a per-discovered-page hook; reuse the page list rather than re-crawling. |

### 2.2 Patterns to follow

**Adapter pattern** — every external dependency (SurfaceMCP, browser MCP, vision API, `npm audit`, `gitleaks`, `semgrep`) lives behind an interface in `packages/cli/src/adapters/` or `packages/cli/src/static/`. Tests mock the interface. There is no "just call `child_process.spawn` from inside a phase."

**Discriminated-union returns** — phase functions return `{ ok: true; data: T }` or `{ ok: false; reason: string }`. Errors that escape a phase boundary are infrastructure failures and go through `InfrastructureFailure`, not exceptions.

**Cluster signature normalization** — every new BugKind defines its `clusterSignature` deterministically. Two findings with the same root cause (different role, different occurrence) collapse to one cluster.

**API responses follow `{ data, error }`** — any new HTTP surface (e.g. cross-user-probe results returned from a future MCP) follows this; never bare arrays.

### 2.3 DO NOT

- Do not create new schema files; extend `types.ts`.
- Do not create a new HTTP client; reuse `surface-mcp.ts`'s adapter.
- Do not create a parallel `RunState`; new fields land in the existing one.
- Do not duplicate `classifyNetworkRequests` for a security pass — extend or compose, never copy-paste.
- Do not introduce `any` to unblock a tool-output type — write a Zod schema in `packages/cli/src/static/schemas/` and parse the tool's JSON output through it.
- Do not call `console.log`; use the structured logger.
- Do not write outside `runs/<runId>/` (re-entrancy gate).
- Do not import from `@anthropic-ai/sdk` in any file except `adapters/vision-client.ts` and the new `adapters/vision-claude-cli.ts`.

---

## 3. Cross-cutting infrastructure

Five modules. Each lands as its own commit, in dependency order: types → infra → first detector using each infra → remaining detectors. **No detector ships before its underlying infra is reviewed-merged.**

### 3.1 `infra:cross-user` + `infra:resource-ids`

**Files to create:**
- `packages/cli/src/phases/cross-user.ts` — new phase between `execute` and `classify`.
- `packages/cli/src/security/resource-id-extractor.ts` — pure function; harvests IDs from JSON response bodies.
- `packages/cli/src/security/resource-id-extractor.test.ts` — unit tests against fixture JSON.

**Files to modify:**
- `packages/cli/src/types.ts` — add `BugKind` entries (`idor_horizontal`, `idor_vertical_role_escalate`, `auth_bypass_via_unauthed_route`); add `RunState.discoveredIds` field; extend `BugDetection` with `idorContext?: { sourceRole: string; targetRole: string; resourceField: string; resourceValue: string; }`.
- `packages/cli/src/cli/index.ts` (or wherever the run-loop is composed) — call `runCrossUser` after `runExecute`, before `runClassify`.
- `packages/cli/src/cluster/signature.ts` — add `case 'idor_horizontal'` etc.

**Phase signature (re-entrant; reads/writes only via RunState):**

```ts
export type CrossUserOptions = {
  runState: RunState;
  surface: SurfaceMcpAdapter;
  // The resolved login state per role — supplied by execute phase.
  roleSessions: Map<string, RoleSession>;
  maxClusters: number;
  onClusterFound: (key: string) => number;
};
export type CrossUserResult = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[]; // one per replay attempt; needed for cluster phase
  abortReason?: 'budget' | 'max_clusters' | 'timeout';
};
export async function runCrossUser(opts: CrossUserOptions): Promise<CrossUserResult>;
```

**`RunState.discoveredIds` shape (Q7):**

```ts
type DiscoveredIds = Map<
  string,                      // role
  Map<
    string,                    // field name (e.g. "tradeId")
    Set<string>                // unique values seen owned by that role
  >
>;
```

The execute phase populates `discoveredIds` as a side-effect hook on every JSON response. The hook function is **pure** (no IO; just walks the parsed body) and unit-testable.

**Cross-user replay algorithm (per Q7 layered approach):**

```
for each (sourceRole, targetRole) where sourceRole != targetRole:
  for each (toolId, fieldName, idValue) in discoveredIds[sourceRole]:
    skip if discoveryFixtures[toolId][targetRole] explicitly opts out
    request = SurfaceMCP.synthesizeCall(toolId, role=targetRole, params={[pathParam]: idValue})
    response = request.execute()
    expect: 401 | 403 | 404
    if response.status === 200:
      emit idor_horizontal finding (cluster signature: idor_horizontal|toolId|fieldName)
    if response.status === 200 AND sourceRole was "anonymous":
      emit auth_bypass_via_unauthed_route (cluster signature: auth_bypass_via_unauthed_route|toolId)
    if response.status === 500:
      emit network_5xx via the existing classifier (the 5xx is also a finding; let the existing classifier handle it)
```

**Vertical-escalation finding:** detect when role A is non-admin and target is an admin-only route. SurfaceMCP exposes `requiresAdmin: boolean` per tool; the cross-user phase iterates admin tools as the lowest-privilege role and flags any 200.

**Cluster signature:**
- `idor_horizontal|<toolId>|<fieldName>` — collapses every (sourceRole, targetRole, idValue) triple under one cluster per (route, field). The cluster reports one canonical occurrence with full artifacts; subsequent occurrences are summary form (existing artifact-budget rules).
- `idor_vertical_role_escalate|<toolId>|<roleAttempted>` — collapses by route + attempting role; the admin route accepting any non-admin role is one finding.
- `auth_bypass_via_unauthed_route|<toolId>` — collapses by route only; one cluster per public-without-auth route.

**Failure modes:**
- SurfaceMCP returns 5xx during replay → infrastructure failure (not a security finding).
- Role session expired mid-phase → re-login via existing `browser-login.ts`; if re-login fails, emit one infrastructure failure for the role and skip remaining replays for that target role.
- `discoveredIds[sourceRole]` is empty → log info "no resource ids harvested for role X; cross-user phase produced 0 candidates" and continue.

**Cost / time budget:** Cap replays at `min(crossUserMaxReplays = 200, role_count^2 × tool_count × ids_per_tool)`. Time budget: same `maxRuntimeMs - elapsed` as other phases. Replays run serial-per-target-role to avoid hammering rate limits.

### 3.2 `infra:headers` (CSP/CORS/cookie/redirect probe)

**Files to create:**
- `packages/cli/src/security/header-probe.ts` — pure HTTP-and-rules module.
- `packages/cli/src/security/header-rules.ts` — the rule data (CSP minimal-required directives; CORS misuse patterns; cookie-flag rules).
- `packages/cli/src/security/header-probe.test.ts` — unit tests with fake responses.

**Files to modify:**
- `packages/cli/src/types.ts` — add `BugKind` entries (`missing_csp_header`, `permissive_cors`, `cookie_security_flags`, `csrf_missing_on_mutating_route`, `open_redirect`, `sensitive_data_in_url`, `stack_trace_leak_in_response`); add `BugDetection.headerContext?: { headerName: string; observedValue?: string; expectedShape: string; }`.
- `packages/cli/src/phases/execute.ts` — call the probe **once per discovered page** at the start of UI test execution for that page (before the action runs). Cached by URL, so multiple actions on one page share one probe.
- `packages/cli/src/cluster/signature.ts` — branches.

**Probe interface:**

```ts
export type HeaderProbeRequest = {
  url: string;          // dev server URL
  method: 'GET' | 'OPTIONS' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
};
export type HeaderProbeResult = {
  status: number;
  responseHeaders: Record<string, string>;
  setCookieHeaders: string[];
  durationMs: number;
};
export async function probeHeaders(req: HeaderProbeRequest): Promise<HeaderProbeResult>;
```

**Detection rules (each becomes a `BugDetection` if violated):**

| Rule id | Header / probe | Violation |
|---|---|---|
| `csp.missing` | `Content-Security-Policy` absent | emit `missing_csp_header` |
| `csp.weak.unsafeInlineScripts` | CSP present but `script-src` includes `'unsafe-inline'` | emit `missing_csp_header` with `cspWeakness: 'inline_scripts_allowed'`, severity informational |
| `cors.permissive_credentialed` | `Access-Control-Allow-Origin: *` AND `Access-Control-Allow-Credentials: true` | emit `permissive_cors` (this combination is rejected by browsers but is a smell) |
| `cors.permissive_authed_endpoint` | `Access-Control-Allow-Origin: *` on endpoint that requires auth (per SurfaceMCP) | emit `permissive_cors` |
| `cookie.no_secure` | session-shaped cookie without `Secure` flag (and dev server is over HTTPS) | emit `cookie_security_flags` |
| `cookie.no_http_only` | session-shaped cookie without `HttpOnly` | emit `cookie_security_flags` |
| `cookie.no_same_site` | session-shaped cookie without explicit `SameSite` | emit `cookie_security_flags` |
| `csrf.missing_on_mutator` | state-changing endpoint (POST/PUT/PATCH/DELETE per SurfaceMCP) accepts request without any of: `X-CSRF-Token` header, cookie-bound CSRF, or strict `Origin` check | emit `csrf_missing_on_mutating_route` |
| `redirect.open` | URL with `?redirect=`/`?return_to=`/`?url=`/`?next=` query param accepts `https://evil.test` and emits `Location` to it | emit `open_redirect` |
| `url.sensitive_param` | observed URL in HAR contains `?password=`, `?token=`, `?api_key=`, `?secret=`, `?email=` (case-insensitive) | emit `sensitive_data_in_url` |
| `body.stack_trace` | 5xx response body matches `/at \/[^"]+\.(js|ts):\d+/` or framework-specific stack patterns | emit `stack_trace_leak_in_response` |

**Detection of "session-shaped cookie":** any `Set-Cookie` whose name is in the `SESSION_COOKIE_NAME_PATTERNS` allowlist (`['session', 'sid', 'sess', 'auth', 'token', 'tj_sess', 'connect.sid', 'next-auth']`) **or** whose value length is >= 32 chars and matches `[A-Za-z0-9_+/=.-]+` (opaque token shape).

**Detection of "session-shaped cookie when dev is HTTP":** `cookie.no_secure` is **suppressed** when the probed origin is `http://localhost*`. Logged at info level so the user knows we skipped the check. The check fires as expected when probing a deployed dev server over HTTPS (the user's choice; not enforced).

**Cluster signatures:**
- `missing_csp_header|<origin>` — one cluster per origin.
- `permissive_cors|<route>|<rule>` — `<rule>` is one of `permissive_credentialed`, `permissive_authed_endpoint`.
- `cookie_security_flags|<cookie_name>|<missing_flag>` — separate clusters for `no_secure` vs `no_http_only` so a fix targeting one doesn't claim to fix another.
- `csrf_missing_on_mutating_route|<toolId>` — per route.
- `open_redirect|<route>|<paramName>` — per route + parameter.
- `sensitive_data_in_url|<route>|<paramName>` — per route + parameter name; param value is normalized away.
- `stack_trace_leak_in_response|<route>|<framePathFingerprint>` — `framePathFingerprint` is the first 3 path segments of the leaked stack frame, hashed.

**Cost / time budget:** the probe is one extra HTTP request per discovered page. Default `maxHeaderProbes: 100` per run. Cached so the same origin isn't re-probed; a 500-page crawl probes ~50 unique origins.

**False-positive shape and filter:**
- CSP weakness on apps using inline scripts intentionally → `severityThreshold` knob. Default reports informational; `--strict-csp` flag promotes to major.
- Cookie flag findings on `http://localhost*` → suppressed by default per above.
- CSRF missing where the route uses double-submit-cookie pattern (cookie-bound token without an `X-CSRF-Token` header) — detection must check the `Set-Cookie` jar for a CSRF cookie before flagging missing.

### 3.3 `infra:auth-probes` + dynamic rate-limit discovery (Q5)

**Files to create:**
- `packages/cli/src/security/rate-limit-discovery.ts` — pre-flight probe that observes `RateLimit-*` headers on a sacrificial endpoint and returns `{ limit, intervalMs, concurrency, delayBetweenAttemptsMs }`.
- `packages/cli/src/security/auth-probes.ts` — the brute-force / no-rate-limit probe. Accepts the discovery output and runs within those bounds.
- `packages/cli/src/security/auth-probes.test.ts` — unit tests with mock SurfaceMCP responses.

**Files to modify:**
- `packages/cli/src/types.ts` — add `BugKind: 'no_rate_limit_on_login'`; add `BugHunterConfig.authProbe?: { enabled: boolean; maxAttempts: number; sacrificialEndpoint?: string; }` (default `enabled: false`).
- `packages/cli/src/cli/index.ts` — wire `--enable-auth-probes` flag → `config.authProbe.enabled = true`.
- `packages/cli/src/phases/execute.ts` — after the normal execute pass, if `config.authProbe.enabled`, run `runAuthProbes(...)`.

**Discovery procedure (Q5 verbatim):**

```ts
export type RateLimitProfile = {
  source: 'observed' | 'fallback';
  limit?: number;            // when observed
  intervalMs?: number;       // when observed
  concurrency: number;       // 1..16
  delayBetweenAttemptsMs: number; // 50..5000
};

export async function discoverRateLimit(
  surface: SurfaceMcpAdapter,
  sacrificialEndpoint: string
): Promise<RateLimitProfile> {
  // 1. Send 5 sequential GETs; observe headers.
  // 2. If any of: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Limit, Retry-After are present:
  //    - limit = parseInt(RateLimit-Limit ?? X-RateLimit-Limit)
  //    - resetSec = parseInt(RateLimit-Reset ?? X-RateLimit-Reset)
  //    - intervalMs = resetSec * 1000
  //    - concurrency = max(1, Math.floor(limit / 4))
  //    - delayBetweenAttemptsMs = Math.ceil((intervalMs / limit) * 4)
  //    - return { source: 'observed', limit, intervalMs, concurrency, delayBetweenAttemptsMs }
  // 3. Else: return { source: 'fallback', concurrency: 1, delayBetweenAttemptsMs: 200 }
}
```

The probe **never exceeds** `config.authProbe.maxAttempts` regardless of what discovery returned.

**`no_rate_limit_on_login` detection:**

```
cap = min(config.authProbe.maxAttempts, 50)
attempts = 0
while attempts < cap:
  status = POST /login with bogus credentials, throttled per RateLimitProfile
  attempts += 1
  if status === 429: emit nothing; rate limit is working; break
  if status === 423: emit nothing; account-locked is working; break
if attempts === cap and no 429/423 ever observed:
  emit no_rate_limit_on_login
    rootCause: "Login endpoint accepted ${cap} bogus-credential POSTs without 429/423"
    targetPath: <login route>
    rateLimitProfile: <RateLimitProfile>
```

**Cluster signature:** `no_rate_limit_on_login|<loginRoute>` — one finding per login route.

**Failure modes / false positives:**
- App returns 200 to `/login` regardless of credentials (some non-standard auth flows) → check the response body; if body shape is `{ error: "..." }` or status is 200 with `application/json` and `success: false`, that's the signal we got, count it as a "miss," continue. If we ran the cap and the body never shifted from "denied" pattern to "success" pattern, the rate-limit finding still holds (the login still wasn't slowed down).
- Re-login during the probe locks the BugHunter run's own session → run auth probes in an **isolated** session (no shared cookie jar with the rest of the run); after probes, the original sessions are unaffected.
- Account-locked state persists between runs → users can configure `authProbe.testAccountUsername` to a known throwaway account; default is `bughunter-probe-user@invalid.test` so real accounts are not affected.

### 3.4 `infra:static` (static-analysis framework + first wraps; Q1 OSS-only)

**Files to create:**
- `packages/cli/src/static/runner.ts` — the tool-runner framework. Accepts a `StaticTool` descriptor; spawns; parses; emits detections.
- `packages/cli/src/static/tools/gitleaks.ts` — gitleaks adapter.
- `packages/cli/src/static/tools/npm-audit.ts` — `npm audit --json` adapter.
- `packages/cli/src/static/tools/semgrep.ts` — semgrep adapter; runs `semgrep --config=p/owasp-top-ten --config=p/secrets --json`. Per Q1, OSS rule sets only.
- `packages/cli/src/static/tools/eslint-no-empty.ts` — eslint adapter that runs eslint with `no-empty` enabled and parses JSON output.
- `packages/cli/src/static/semgrep-rules/` — directory for custom YAML rules (Q1 escape hatch). Empty at v0.5; populated in v0.7+.
- `packages/cli/src/static/sqlmap-runner.ts` — **skeleton only.** Exports the interface and the heuristic pre-filter (POST endpoints + GET endpoints with `search`/`filter`/`q`/`order_by`/`sort`). The actual `spawn('sqlmap', ...)` is a `TODO(v0.7)` returning `{ ok: false, reason: 'not_implemented' }`. The skeleton lets v0.7 land without a framework rewrite.
- `packages/cli/src/static/schemas/` — Zod schemas for each tool's JSON output. One file per tool.
- `packages/cli/src/static/runner.test.ts` and per-tool `*.test.ts` — unit tests with recorded-fixture tool outputs (no live spawn).

**Files to modify:**
- `packages/cli/src/types.ts` — add `BugKind` entries (`vulnerable_dependency_high`, `hardcoded_credentials_in_source`, `swallowed_error_empty_catch`); add `BugDetection.staticContext?: { tool: string; ruleId: string; sourceFile: string; sourceLine?: number; }`.
- `packages/cli/src/phases/discover.ts` — after the existing discovery, run `runStaticAnalysis(runState)` if `config.staticAnalysis?.enabled !== false`. Static checks default-on at v0.5.
- `packages/cli/src/cluster/signature.ts` — branches.

**Tool-runner contract:**

```ts
export type StaticTool = {
  id: string;                  // 'gitleaks' | 'npm-audit' | 'semgrep' | 'eslint-no-empty'
  binary: string;              // 'gitleaks' | 'npm' | 'semgrep' | 'npx'
  args: (projectDir: string) => string[];
  parseStdout: (raw: string) => { detections: BugDetection[]; warnings: string[] };
  timeoutMs: number;
  // If the binary is not on PATH, the runner emits a configuration finding
  // (BugKind: 'console_error' is wrong here — see types.ts addition for a
  // dedicated 'static_tool_unavailable' meta-kind, or skip silently with
  // a warning. Decision: skip silently with a structured-log warning.)
  optional: boolean;           // true for tools that may not be installed
};
export async function runStaticTool(tool: StaticTool, projectDir: string): Promise<StaticToolRun>;
export async function runStaticAnalysis(runState: RunState): Promise<StaticToolRun[]>;
```

**Per-tool details:**

| Tool | Args | Output → BugKind |
|---|---|---|
| `gitleaks` | `gitleaks detect --source <projectDir> --report-format json --report-path -` | each finding → `hardcoded_credentials_in_source`, `staticContext.ruleId = finding.RuleID`, `sourceFile = finding.File`, `sourceLine = finding.StartLine` |
| `npm-audit` | `npm audit --json --audit-level=high` (run in `<projectDir>`) | each advisory with severity in `{high, critical}` → `vulnerable_dependency_high`, `staticContext.ruleId = advisoryId`, `sourceFile = "package-lock.json"`, `rootCause = "${packageName} ${version}: ${title}"` |
| `semgrep` | `semgrep --config=p/owasp-top-ten --config=p/secrets --config=p/javascript --config=p/typescript --json --quiet --error --severity=ERROR --severity=WARNING` (Q1 OSS-only) | findings filtered through a per-rule mapper to either `hardcoded_credentials_in_source` (rules `secrets.*`, `generic.secrets.*`) or skipped (other rules belong to v0.7+) |
| `eslint-no-empty` | `npx eslint --no-eslintrc --rule '{"no-empty":"error"}' --format json <globPattern>` (glob = `src/**/*.{ts,tsx,js,jsx}`) | each violation with `ruleId === "no-empty"` → `swallowed_error_empty_catch`, `staticContext` populated |

**Cluster signature for static findings:**
- `<bugKind>|<sourceFile>|<sourceLine>` — file + line is the natural unit. Two findings on the same line collapse.

**Re-entrancy (Q4):** the runner reads only `runState.config.projectDir` and writes only the returned detections array. No global state. Each tool's `parseStdout` is pure.

**Failure modes:**
- Binary not on PATH → log warning, skip the tool; do not abort the run.
- Tool exits non-zero with "no findings" semantics (e.g. gitleaks exits 1 when nothing found in some versions) → check the parsed JSON; if it's an empty findings array, treat as success.
- Tool stdout exceeds 50MB → truncate, log warning, parse what we got.
- Per-tool timeout (default 120s) → emit one infrastructure failure per tool that timed out; do not propagate.

**False-positive shape:**
- gitleaks regularly flags test fixtures with fake API keys → support a per-project `.bughunter/static-allow.json` matching gitleaks rule + path; the runner filters before emitting.
- npm audit's "transitive high" sometimes maps to advisories the user can't fix without a major upgrade → severity stays at the advisory's reported level; the architect-orchestrator decides whether to attempt a fix.

### 3.5 `infra:synthetic` (synthetic interaction primitives)

**Files to create:**
- `packages/cli/src/synthetic/runner.ts` — scenario dispatcher.
- `packages/cli/src/synthetic/scenarios/race-double-submit.ts` — first scenario.
- `packages/cli/src/synthetic/scenarios/optimistic-update-divergence.ts` — second scenario.
- `packages/cli/src/synthetic/scenarios/no-rate-limit-on-login.ts` — third scenario (delegates to `auth-probes.ts`).
- `packages/cli/src/synthetic/scenarios/__tests__/` — fixture-based tests.

**Files to modify:**
- `packages/cli/src/types.ts` — add `BugKind` entries (`race_double_submit`, `optimistic_update_divergence`); add `BugHunterConfig.synthetic?: { enabled: boolean; scenarios?: string[]; }` (default `enabled: false` because synthetic scenarios mutate state).
- `packages/cli/src/phases/execute.ts` — synthetic scenarios run **inside** the execute phase, gated by `config.synthetic.enabled`, only on roles flagged as "throwaway" (so they don't run as the user's real admin).

**Scenario interface:**

```ts
export type SyntheticScenario = {
  id: 'race_double_submit' | 'optimistic_update_divergence' | 'no_rate_limit_on_login';
  // Decide which (page, action) tuples this scenario applies to.
  appliesTo(testCase: TestCase): boolean;
  // Drive the scenario; emit detections.
  run(ctx: SyntheticContext): Promise<BugDetection[]>;
};
```

**`race_double_submit` algorithm:**

```
1. Find a TestCase with action.kind === 'click' and expectedOutcome === 'success' and palette === 'happy' on a mutating element (delete-, save-, submit-shaped text).
2. Instrument the page to count outgoing POST requests to the inferred mutator endpoint.
3. Click the trigger element TWICE within 100ms (Promise.all of two click promises, no await between).
4. Wait for both responses.
5. Detection: if both POSTs reached the server with 2xx (or one 2xx and the second is anything other than 409/422/425), emit `race_double_submit`.
   - 409 / 422 / 425 indicates the server detected the duplicate; correct.
   - Two 2xx + same payload echoed back = duplicate created; finding fires.
6. Cluster signature: `race_double_submit|<endpoint>|<formSignature>`.
```

**`optimistic_update_divergence` algorithm:**

```
1. After every test execution where the action was a mutator and the post-state vision said "success-shaped UI" (toast, redirect, success-class state):
   - Inspect HAR. Find the matching mutator request (closest preceding POST/PUT/PATCH to a SurfaceMCP-registered tool).
   - If status is non-2xx (>= 400 or undefined/aborted), emit `optimistic_update_divergence`.
2. Detection requires both signals: vision success + HAR failure. Either alone is not enough.
3. Cluster signature: `optimistic_update_divergence|<endpoint>|<status>`.
```

This relies on **vision** for the "UI shows success" half. v0.4 already runs vision per page; the optimistic-divergence scenario is a post-vision pass.

**`no_rate_limit_on_login`:** delegates to `auth-probes.ts` from §3.3.

**Re-entrancy / Q4:** scenarios mutate the application; they MUST run only on `runState.config.resetCommand`-managed throwaway data. The runner refuses to fire any scenario when `resetPolicy === 'per-run'` (the slowest reset) without explicit `synthetic.allowDestructiveOnPerRunReset: true`.

---

## 4. BugKind specs (per-kind detail)

Each kind below has: detection technique → signature → per-kind config knobs → cost → false-positive shape → killer-demo expected finding. The infrastructure was specified in §3; this section is the per-kind contract.

### 4.1 `idor_horizontal`
- **Detection:** §3.1 cross-user replay matrix. Source role A's harvested IDs replayed as target role B; 200 = finding.
- **Signature:** `idor_horizontal|<toolId>|<fieldName>`.
- **Config knobs:** `crossUser.crossRoleProbeEnabled` (default true); `crossUser.maxReplays` (default 200); `discoveryFixtures.<toolId>.<role>.<field>` per Q7 override.
- **Cost:** O(roles² × ids × tools) HTTP requests; bounded by `maxReplays`.
- **False-positive shape:** legitimate cross-account read access via shared-account features (TraiderJo's `getAccountAccess` returning `{ access: true }` for sharing). Filter: when SurfaceMCP marks the route as `acl: 'shared-resource-allowed'`, the cross-user phase **must not** flag a 200 from the shared user; flags only 200 from a user with **no** shared-access relation. Implementation: cross-user phase consults `SurfaceMCP.aclFor(toolId, sourceUserId, targetUserId)` if available; absence defaults to "no relation, treat 200 as finding."
- **TraiderJo killer demo:** `GET /api/trades/:tradeId/mistakes` (line 5004 of `/tmp/TraiderJo/server/src/index.js`). With user A's `tradeId` harvested via the response-body extractor and replayed as user B (no shared-account relation), expected behavior is 403; if 200, IDOR fired. Even if TraiderJo's current code correctly returns 403, the spec needs the detector to be confidently green in those cases — that *is* the demo (the gate works).

### 4.2 `idor_vertical_role_escalate`
- **Detection:** Iterate routes flagged `requiresAdmin: true` in SurfaceMCP; replay each as the lowest-privilege configured role. 200 = finding.
- **Signature:** `idor_vertical_role_escalate|<toolId>|<roleAttempted>`.
- **Config knobs:** `crossUser.adminRoleHints` (defaults to `["admin", "owner", "superuser"]`).
- **Cost:** O(adminRoutes × nonAdminRoles).
- **False-positive shape:** route returns 200 with empty result set (correct, but looks like access). Filter: response body is `[]` or `{ data: [] }` or `null` → suppress.
- **TraiderJo demo:** `GET /api/admin/users` (if it exists; if not, this kind produces zero findings, which is also a valid result for a well-segmented app).

### 4.3 `auth_bypass_via_unauthed_route`
- **Detection:** SurfaceMCP catalog → for every route with `requiresAuth: true`, send the request **without** an auth cookie/header. 200 = finding.
- **Signature:** `auth_bypass_via_unauthed_route|<toolId>`.
- **Config knobs:** `crossUser.anonymousProbeEnabled` (default true).
- **Cost:** O(authedRoutes).
- **False-positive shape:** routes whose auth check is correct but return 200 with redirect-to-login HTML body → check `Content-Type` is `application/json`; if HTML, do not flag.
- **TraiderJo demo:** any of the `/api/trades/*` routes called without `tj_sess` cookie should 401; spec confirms the gate works.

### 4.4 `missing_csp_header`
- **Detection:** §3.2 header probe rule `csp.missing` and `csp.weak.unsafeInlineScripts`.
- **Signature:** `missing_csp_header|<origin>` (one cluster per origin; not per page).
- **Config knobs:** `headers.csp.severityForUnsafeInline` (`'informational' | 'major'`; default `'informational'`).
- **Cost:** 1 HTTP request per unique origin in the run.
- **False-positive shape:** development-only origins where CSP is intentionally absent → suppress on `localhost*` only when `headers.csp.localhostMode === 'skip'` (default skip).
- **TraiderJo demo:** TraiderJo currently emits CSP at `index.js:397` with `script-src 'self' 'unsafe-inline'`. The detector flags `cspWeakness: 'inline_scripts_allowed'` at `informational` severity. This becomes a calibration-gate test: the user can `bughunter suppress` this cluster and re-run.

### 4.5 `permissive_cors`
- **Detection:** §3.2 rules `cors.permissive_credentialed` and `cors.permissive_authed_endpoint`.
- **Signature:** `permissive_cors|<route>|<rule>`.
- **Config knobs:** none beyond infra.
- **False-positive shape:** the rule is unambiguous; few false positives expected.
- **TraiderJo demo:** TraiderJo uses `cors({...})` at `index.js:361`. If the configured origin is `*` AND `credentials: true`, finding fires. Probable yes; the user has opted into a permissive dev posture, but that posture should fail this check.

### 4.6 `cookie_security_flags`
- **Detection:** §3.2 rules `cookie.no_secure`, `cookie.no_http_only`, `cookie.no_same_site`. Three separate sub-checks; one cluster each.
- **Signature:** `cookie_security_flags|<cookieName>|<missingFlag>`.
- **Config knobs:** `headers.cookies.localhostMode` (`'skip' | 'flag'`; default `'skip'` for `Secure` only).
- **False-positive shape:** the dev cookie at `index.js:602-604` (`tj_sess`, `httpOnly: true`, `sameSite: 'strict'`, `secure: COOKIE_SECURE`) — if `COOKIE_SECURE` is false in dev, only `no_secure` fires, and that's suppressed by default per the localhost rule. Correct.
- **TraiderJo demo:** the `tj_csrf` cookie at `index.js:453-456` has `httpOnly: false` (correct for a CSRF token that JS reads). Filter: cookie name matching `csrf` is excluded from the `no_http_only` rule.

### 4.7 `csrf_missing_on_mutating_route`
- **Detection:** §3.2 rule `csrf.missing_on_mutator`. Emit POSTs/PUTs to mutator routes with no `X-CSRF-Token` header and no CSRF cookie; observe whether 2xx returns. 2xx = finding.
- **Signature:** `csrf_missing_on_mutating_route|<toolId>`.
- **Config knobs:** `headers.csrf.cookieNamePatterns` (default `['csrf', 'xsrf', '_csrf']`).
- **False-positive shape:** APIs explicitly protected by `Origin` checks and not CSRF tokens → check the `Origin` and `Referer` echo behavior; if the server 403s when those headers don't match, treat the route as protected.
- **TraiderJo demo:** TraiderJo issues `tj_csrf` and validates it on mutators. Probe sends a POST without `tj_csrf`, expects 403, no finding. If TraiderJo were to remove the CSRF middleware on a single route, the detector catches it on the next run.

### 4.8 `open_redirect`
- **Detection:** §3.2 rule `redirect.open`. Discover routes accepting `?redirect=`/`?return_to=`/etc.; replace with `https://evil.test`; if the response 3xx + `Location: https://evil.test`, finding fires.
- **Signature:** `open_redirect|<route>|<paramName>`.
- **Config knobs:** `headers.redirect.paramNames` (default `['redirect', 'return_to', 'returnTo', 'next', 'url', 'continue', 'redirectUrl']`).
- **False-positive shape:** allow-listing is correctly enforced server-side → server returns 400/422; no finding.
- **TraiderJo demo:** unlikely to fire on TraiderJo (no obvious open-redirect-shaped param). Demo does not depend on this firing.

### 4.9 `no_rate_limit_on_login`
- **Detection:** §3.3 algorithm. Cap-driven brute-force with rate-limit discovery pre-flight.
- **Signature:** `no_rate_limit_on_login|<loginRoute>`.
- **Config knobs:** `authProbe.maxAttempts` (default 50); `authProbe.testAccountUsername` (default `bughunter-probe-user@invalid.test`); `authProbe.enabled` (CLI `--enable-auth-probes`).
- **False-positive shape:** `authProbe.maxAttempts` set too low → finding fires when rate limit kicks in at exactly the cap. Mitigation: discovery output sets the cap; if `RateLimit-Limit: 100` is observed, we never run more than 50 anyway, and the finding will not fire because we won't see the limit hit either way (we'd suppress). Edge case: limit is 30 → we run 50 → limit kicks in at attempt 30, the rest 429 → no finding. Correct.
- **TraiderJo demo:** TraiderJo has `rateLimit({...})` middleware (line 230, `humanLimiter`, `aiLimiter`, etc.). The login route should hit the limiter; expected: no finding. Demo confirms the gate works.

### 4.10 `vulnerable_dependency_high`
- **Detection:** §3.4 `npm audit --json --audit-level=high`. Each advisory at high or critical severity → one detection.
- **Signature:** `vulnerable_dependency_high|<advisoryId>`.
- **Config knobs:** `staticAnalysis.npmAudit.minSeverity` (default `'high'`; v0.7 may add `'medium'`).
- **Cost:** one `npm audit` invocation per run; <5s on a healthy lockfile.
- **False-positive shape:** advisories with no upgrade path → still a real finding; severity is the architect's signal to triage.
- **TraiderJo demo:** TraiderJo's lockfile has hundreds of transitive deps; `npm audit --audit-level=high` will reliably surface at least one. Concrete prediction: a transitive `axios` / `node-fetch` / `lodash` advisory.

### 4.11 `hardcoded_credentials_in_source`
- **Detection:** §3.4 gitleaks (primary) + semgrep `p/secrets` rules (secondary). Findings collapse on `<sourceFile>:<sourceLine>`.
- **Signature:** `hardcoded_credentials_in_source|<sourceFile>|<sourceLine>`.
- **Config knobs:** `staticAnalysis.allowFile` (path to `.bughunter/static-allow.json`).
- **False-positive shape:** test fixtures with fake AWS keys → allowlist by path.
- **TraiderJo demo:** TraiderJo's source has multiple `process.env.STRIPE_*` patterns. gitleaks should NOT flag environment variable reads; if it does, that's a tool-config bug. Probable hits: fixture files with example API keys in `tests/`.

### 4.12 `swallowed_error_empty_catch`
- **Detection:** §3.4 eslint with `no-empty: error` enabled, parsed for `catch` blocks.
- **Signature:** `swallowed_error_empty_catch|<sourceFile>|<sourceLine>`.
- **Config knobs:** none beyond infra.
- **False-positive shape:** intentional empty catches are sometimes legitimate (e.g. parsing a number that may not parse). The rule has a known false-positive rate of ~20% on real code. Mitigation: rule emits at `severity: 'minor'` by default; user can elevate.
- **TraiderJo demo:** scan TraiderJo source for `catch (e) {}`. Predicted hits: 1–3 in adapter code.

### 4.13 `stack_trace_leak_in_response`
- **Detection:** §3.2 rule `body.stack_trace`. 5xx response body matches stack-frame regex.
- **Signature:** `stack_trace_leak_in_response|<route>|<framePathFingerprint>`.
- **Config knobs:** `headers.stackTrace.frameFingerprintLength` (default 3 path segments, hashed).
- **False-positive shape:** legitimate dev-mode stack traces in 5xx are intentional; severity reflects that. In v0.7's `mode: 'build'` opt-in, this elevates to major.
- **TraiderJo demo:** trigger a known-faulty endpoint; if Express's default error handler leaks the stack, finding fires.

### 4.14 `sensitive_data_in_url`
- **Detection:** §3.2 rule `url.sensitive_param`. HAR sweep for URLs with `?password=`/`?token=`/`?api_key=`/`?email=`.
- **Signature:** `sensitive_data_in_url|<route>|<paramName>`.
- **Config knobs:** `headers.sensitiveUrl.paramPatterns` (default `['password', 'pwd', 'token', 'api_key', 'apiKey', 'secret', 'email']`).
- **False-positive shape:** `?email=foo@bar.com` on a public unsubscribe link is sometimes intentional. Severity at `minor`; user can elevate.
- **TraiderJo demo:** scan TraiderJo's HAR; if any flow uses email-as-query, finding fires at `minor`.

### 4.15 `optimistic_update_divergence`
- **Detection:** §3.5 scenario. Vision says success + HAR says failure.
- **Signature:** `optimistic_update_divergence|<endpoint>|<status>`.
- **Config knobs:** `synthetic.optimisticDivergence.statusThreshold` (default 400).
- **False-positive shape:** vision misclassifies a non-success state as success. Mitigation: severity gating from v0.4 vision applies; only `major`+ vision findings count as "success-shaped UI."
- **TraiderJo demo:** trigger a save with intentionally-invalid payload; the UI's success-toast should not fire on a 4xx; if it does (vibe-coded handler with `setTimeout(reload, 1000)` masking the failure), finding fires. Probable on TraiderJo's vibe-coded save flows.

### 4.16 `race_double_submit`
- **Detection:** §3.5 scenario. Two sub-100ms clicks; both reach server with 2xx; no idempotency token.
- **Signature:** `race_double_submit|<endpoint>|<formSignature>`.
- **Config knobs:** `synthetic.raceDoubleSubmit.intervalMs` (default 50).
- **False-positive shape:** the second click was correctly rejected by the client (button disabled after first click) but the request still reached the server because the disable was async → check whether the second request had identical payload to the first; if identical and both 2xx, finding fires.
- **TraiderJo demo:** double-click on "Save Trade." If TraiderJo's debouncing is correct, no finding (button disabled mid-flight). If TraiderJo allows two POSTs through, finding fires.

### 4.17 `hallucinated_route`
- **Detection:** Cross-reference frontend `fetch('/api/x')` calls against SurfaceMCP catalog. Frontend call to a route SurfaceMCP doesn't know about → finding.
- **Signature:** `hallucinated_route|<calledRoute>`.
- **Config knobs:** `staticAnalysis.frontendSourceGlob` (default `src/**/*.{ts,tsx,js,jsx}`).
- **Implementation:** `packages/cli/src/static/native/hallucinated-route.ts` — reads the project's frontend source via `ts-morph`, extracts string literals passed to `fetch(`/`axios.`/etc., compares against `surface.tools.map(t => t.path)`. Findings emit per call site.
- **False-positive shape:** routes registered outside SurfaceMCP (third-party APIs called from the frontend) → filter: only flag routes whose host is the app's own origin or a relative path.
- **TraiderJo demo:** TraiderJo's frontend at `/tmp/TraiderJo/src/` has hundreds of `fetch` calls. If any call references a route not in SurfaceMCP's catalog (typical with vibe-coded apps where the LLM invented a route), finding fires. Probable yes.

### 4.18 `hydration_mismatch` (promote from `react_error`)
- **Detection:** Existing `react_error` classifier with refined patterns. The console-error text matches `/Hydration failed because/`, `/Text content does not match server-rendered HTML/`, `/Did not match. Server: .* Client:/`. Promotion: `react_error` becomes the parent kind; `hydration_mismatch` is a more specific child for these patterns.
- **Signature:** `hydration_mismatch|<pageRoute>|<patternFingerprint>`.
- **Config knobs:** none.
- **Implementation:** modify `packages/cli/src/classify/react.ts` to detect the patterns and emit `hydration_mismatch` instead of `react_error`. Existing `react_error` cluster signature continues to work; we just add a more-specific kind for hydration-only patterns.
- **False-positive shape:** browser-extension-injected DOM diffs cause spurious hydration warnings → filter via existing third-party-or-generated logic.
- **TraiderJo demo:** TraiderJo is Vite + React-Router (not Next), so SSR hydration is not in play; this kind has zero findings on TraiderJo. That's expected; the kind earns its keep on Next.js / Remix apps.

---

## 5. Vision auth refactor (sub-spec) — Q8 resolution

**Goal:** vision works without `ANTHROPIC_API_KEY` whenever the developer has the Claude CLI installed and authenticated. API-key path remains unchanged.

### 5.1 Type changes

`packages/cli/src/adapters/vision-client.ts`:

```ts
// Replace the existing 2-variant union:
//   | { kind: 'apiKey'; apiKey: string }
//   | { kind: 'oauth'; authToken: string }
// with:
export type VisionAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'claudeCli'; binaryPath: string };
// 'oauth' is removed (it never worked; see commit 6eb2d8f).
```

The existing `AnthropicVisionClient` keeps its `apiKey` branch and **deletes its `oauth` branch** (already reverted on `main`; this spec just confirms removal).

### 5.2 New file: `packages/cli/src/adapters/vision-claude-cli.ts`

Implements `VisionClientInterface` using subprocess invocation of the Claude CLI.

```ts
export class ClaudeCliVisionClient implements VisionClientInterface {
  constructor(
    private readonly binaryPath: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}
  async classify(req: VisionRequest): Promise<VisionResponse> {
    // Compose the prompt: req.promptText + "\n\nThe screenshot is at: " + absolute(req.imagePath).
    // The Claude CLI reads the file off disk; no base64 needed.
    // spawn('<binaryPath>', ['--print', '--input-format', 'text', '--output-format', 'json', '--model', this.model])
    // Pipe prompt to stdin. Read stdout. Parse JSON. The response shape under --output-format=json is documented at:
    //   `claude --print --help` → { result: string, usage?: { input_tokens, output_tokens } }
    // Map result.usage to VisionResponse.usage; rawText is result.result.
  }
}
```

Failure modes:
- Subprocess exit code non-zero → `VisionApiError('transport', stderr)`.
- Subprocess stdout is not valid JSON → `VisionApiError('malformed', ...)`.
- Subprocess hangs > timeoutMs → kill, throw `VisionApiError('timeout', ...)`.
- `claude` binary disappears mid-run → re-detect on next call; if still missing, fall through to API-key path **only if API key is also configured**. Otherwise abort vision for this run.

### 5.3 Detection helper: `packages/cli/src/adapters/vision-auth-detect.ts`

Pure function (no IO at module load):

```ts
export type VisionAuthDetectResult =
  | { kind: 'claudeCli'; binaryPath: string }
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'unavailable'; reason: string };

export async function detectVisionAuth(env: NodeJS.ProcessEnv): Promise<VisionAuthDetectResult>;
```

Detection algorithm:
1. `which claude` (use `child_process.execFile('which', ['claude'])` with 1s timeout). If found:
2. `claude --version` (1s timeout). If exits 0:
3. Return `{ kind: 'claudeCli', binaryPath }`.
4. Otherwise check `env.ANTHROPIC_API_KEY`. If present and non-empty:
5. Return `{ kind: 'apiKey', apiKey }`.
6. Else return `{ kind: 'unavailable', reason: 'no Claude CLI on PATH and no ANTHROPIC_API_KEY' }`.

The vision config consumes this: when `unavailable`, vision is skipped with one warning logged and `RunSummary.vision.abortReason = 'auth'`.

### 5.4 Latency / cost / dedup

- API-key path: ~1–2 s/call (measured).
- Claude-CLI path: ~5–10 s/call (subprocess overhead + LLM round trip).
- Mitigation: existing `vision.concurrency` knob (default 4) and screenshot-hash dedup remain in place. The ClaudeCli path costs $0 to the user (Claude Code auth covers it); the API-key path costs whatever `claude-haiku-4-5` costs.
- The vision budget (`vision.maxCalls`, default 100) applies regardless of auth path.

### 5.5 Test plan

- **Unit:** mock `child_process.execFile` and `child_process.spawn` to return canned JSON; assert the parsed `VisionResponse`.
- **Integration:** ship a fake `claude` binary in `tests/fixtures/vision-cli/fake-claude` that prints a known JSON response. Set `PATH=tests/fixtures/vision-cli:$PATH` for the test; confirm the real `ClaudeCliVisionClient` exec'd it.
- **Regression:** the existing API-key vision tests must continue to pass unchanged.

### 5.6 Backward compatibility

- Existing `VisionConfig.apiKey` field unchanged.
- `VisionAuth` kind `'oauth'` is removed; if the value is set in a config (it can't be, it was never user-exposed), runtime errors with a clear message naming Q8.
- `RunSummary.vision.authMode: 'apiKey' | 'claudeCli'` is new; absent from old summaries; not breaking.

---

## 6. CLI surfaces

### 6.1 `bughunter suppress <clusterId> --reason "<text>"` (Q10 default)

**Files to create:**
- `packages/cli/src/cli/commands/suppress.ts`
- `packages/cli/src/cli/commands/suppress.test.ts`

**Files to modify:**
- `packages/cli/src/cli/index.ts` — register the `suppress` subcommand.
- `packages/cli/src/phases/cluster.ts` (or a new `phases/suppress.ts` that runs **before** cluster emit) — read `.bughunter/suppressions.json` and filter clusters whose signature matches.

**File format `.bughunter/suppressions.json`:**

```json
{
  "version": 1,
  "entries": [
    {
      "clusterSignature": "missing_csp_header|http://localhost:3002",
      "reason": "intentional dev-mode CSP",
      "addedAt": "2026-04-27T12:34:56Z",
      "addedBy": "user"
    }
  ]
}
```

Behavior:
- `bughunter suppress <clusterId> --reason "..."` → reads the most recent run's clusters; finds the cluster by id; appends an entry with that cluster's signature; writes back.
- `<clusterId>` is the cuid emitted in `BugCluster.id`. Stable across runs only via the signature; the reason is recorded against the signature.
- Filter applied at cluster phase: clusters whose signature matches a suppression entry are dropped; `RunSummary.suppressedClusters` increments.

### 6.2 `--enable-auth-probes` flag

CLI flag mapped to `config.authProbe.enabled = true`. Off by default. Documented in `bughunter --help`.

### 6.3 No new `bughunter watch` (Q4 forward-compat only)

Architecture is re-entrant; no new subcommand at v0.5.

---

## 7. Negative requirements (verbatim, before commit)

These are the tripwires; @architect rejects any PR that fails them.

- **No new files** outside the lists in §3.x and §4.x. If a task author thinks they need one, raise it in PR description first; @architect approves before it's added.
- **No `as any`.** All tool-output parsing goes through Zod schemas in `packages/cli/src/static/schemas/`.
- **No `console.log`.** Use the structured logger.
- **Max 40 lines per function.** Long detection algorithms are decomposed into pure helpers.
- **Max 300 lines per file.** Per-tool adapters and per-scenario modules stay small.
- **No copy-paste of existing handlers.** If a new detector resembles an old one, refactor the shared logic into a helper; don't fork.
- **No `child_process.spawn` outside `packages/cli/src/static/` and `packages/cli/src/adapters/vision-claude-cli.ts`.**
- **No global mutable state** introduced anywhere (Q4 re-entrancy).
- **No commercial Semgrep** (Q1).
- **No Safari/WebKit** anywhere in this phase (Q2).
- **No build-step probing** at v0.5; dev-server only (Q3).
- **No production scanning** (existing anti-goal).
- **No bypassing `--enable-auth-probes`.** Auth probes default off; the CLI flag is the only switch.
- **No new BugKinds beyond the §1 list of 18.** Even if a juicy related kind appears, defer it to v0.6+.
- **Vision auth must keep the API-key path working** (regression gate).
- **All new phases must read/write only via RunState and `runs/<runId>/`.** Re-entrancy gate.
- **All new HTTP surfaces follow `{ data, error }`** (existing convention).
- **All new types extend `types.ts`**, never define types separately on each side.

---

## 8. Task breakdown + ownership

Each task is agent-sized (~30 min human). Tasks are vertically sliced where possible (one behavior across DB / API / detector / cluster / test). Dependencies are explicit.

### Task v0.5-T01 — Types union extensions
**Assignee:** @coder · **Depends on:** none · **Files to modify:** `packages/cli/src/types.ts` only · **Test:** `npm test -- types.spec.ts` (new file or extend existing) · **Done when:** all 16 new BugKind names compile; `BugDetection` has the new optional context fields (`idorContext`, `headerContext`, `staticContext`); `RunState.discoveredIds` field added; `BugHunterConfig.authProbe` / `synthetic` / `headers` / `staticAnalysis` / `crossUser` blocks added with sensible defaults documented in JSDoc. · **DO NOT:** add any logic; types only.

### Task v0.5-T02 — Cluster signature branches
**Assignee:** @coder · **Depends on:** T01 · **Files to modify:** `packages/cli/src/cluster/signature.ts`, `packages/cli/src/cluster/signature.test.ts` · **Test:** `npm test -- cluster/signature` · **Done when:** every new BugKind has a deterministic signature; tests cover IDOR (collapse by toolId+field), header probes (collapse by origin/route+rule), static (collapse by file+line); `extractNormalizedFields` continues to work for hydration_mismatch (treated as a stack-fingerprintable kind). · **DO NOT:** add detection logic.

### Task v0.5-T03 — Vision auth detect helper
**Assignee:** @coder · **Depends on:** none · **Files to create:** `packages/cli/src/adapters/vision-auth-detect.ts`, `packages/cli/src/adapters/vision-auth-detect.test.ts` · **Files to modify:** none · **Test:** `npm test -- vision-auth-detect` · **Done when:** `detectVisionAuth(env)` returns `{ kind: 'claudeCli' }` when fake `claude` binary is on PATH; returns `{ kind: 'apiKey' }` when only `ANTHROPIC_API_KEY` is set; returns `{ kind: 'unavailable' }` otherwise. Tests use `tests/fixtures/vision-cli/fake-claude`. · **DO NOT:** plumb into `VisionClient` yet.

### Task v0.5-T04 — Claude CLI vision client
**Assignee:** @coder · **Depends on:** T03 · **Files to create:** `packages/cli/src/adapters/vision-claude-cli.ts`, `packages/cli/src/adapters/vision-claude-cli.test.ts` · **Files to modify:** `packages/cli/src/adapters/vision-client.ts` (remove `oauth` branch from `VisionAuth`; add `claudeCli` branch as a marker; instantiation lives in the new file). · **Test:** `npm test -- vision-claude-cli` · **Done when:** mock subprocess returns canned JSON; `classify(req)` resolves to `{ rawText, usage }`. Real-binary integration test with `fake-claude` passes. API-key existing tests still green. · **DO NOT:** change the existing `AnthropicVisionClient`'s API-key path.

### Task v0.5-T05 — Wire vision auth into the run loop
**Assignee:** @coder · **Depends on:** T03, T04 · **Files to modify:** `packages/cli/src/cli/index.ts` (or wherever the vision client is constructed) · **Test:** `npm test -- vision-auth.integration` (new) · **Done when:** when `claude` is on PATH, the run uses `ClaudeCliVisionClient`; when not, it falls back to `AnthropicVisionClient` via `ANTHROPIC_API_KEY`; when neither, vision is disabled with a clear log line and `RunSummary.vision.abortReason = 'auth'`. · **DO NOT:** change vision callers.

### Task v0.5-T06 — Static-analysis runner framework
**Assignee:** @coder · **Depends on:** T01 · **Files to create:** `packages/cli/src/static/runner.ts`, `packages/cli/src/static/runner.test.ts`, `packages/cli/src/static/schemas/` directory with one Zod schema per planned tool · **Test:** `npm test -- static/runner` · **Done when:** `runStaticTool(tool, projectDir)` spawns the binary, captures stdout up to 50MB, parses through Zod, returns `{ detections, warnings }`; missing-binary case is non-fatal; per-tool timeout caps at 120s. · **DO NOT:** implement individual tool adapters yet.

### Task v0.5-T07 — gitleaks adapter
**Assignee:** @coder · **Depends on:** T06 · **Files to create:** `packages/cli/src/static/tools/gitleaks.ts`, `packages/cli/src/static/tools/gitleaks.test.ts` · **Test:** `npm test -- gitleaks` · **Done when:** fixture-based test with recorded gitleaks JSON yields detections; missing binary yields a warning, not a failure. · **DO NOT:** ship the actual binary; users install it.

### Task v0.5-T08 — npm audit adapter
**Assignee:** @coder · **Depends on:** T06 · **Files to create:** `packages/cli/src/static/tools/npm-audit.ts`, fixture + test · **Done when:** `npm audit --json --audit-level=high` output parses into `vulnerable_dependency_high` detections; one cluster per advisoryId.

### Task v0.5-T09 — semgrep adapter (OSS rules only)
**Assignee:** @coder · **Depends on:** T06 · **Files to create:** `packages/cli/src/static/tools/semgrep.ts`, `packages/cli/src/static/semgrep-rules/.gitkeep`, fixture + test · **Done when:** `semgrep --config=p/owasp-top-ten --config=p/secrets --config=p/javascript --config=p/typescript --json` output filtered by rule prefix into either `hardcoded_credentials_in_source` or skipped; custom-YAML directory exists and is honored.

### Task v0.5-T10 — eslint no-empty adapter
**Assignee:** @coder · **Depends on:** T06 · **Files to create:** `packages/cli/src/static/tools/eslint-no-empty.ts`, fixture + test · **Done when:** eslint JSON output for `no-empty` rule maps to `swallowed_error_empty_catch` detections.

### Task v0.5-T11 — sqlmap skeleton (Q6)
**Assignee:** @coder · **Depends on:** T06 · **Files to create:** `packages/cli/src/static/sqlmap-runner.ts` (skeleton; pre-filter only), `packages/cli/src/static/sqlmap-runner.test.ts` · **Done when:** the heuristic pre-filter picks endpoints correctly; `runSqlmapOnEndpoint` returns `{ ok: false, reason: 'not_implemented' }` with a `TODO(v0.7)` marker; future v0.7 task adds the actual spawn.

### Task v0.5-T12 — Header probe module
**Assignee:** @coder · **Depends on:** T01 · **Files to create:** `packages/cli/src/security/header-probe.ts`, `packages/cli/src/security/header-rules.ts`, `packages/cli/src/security/header-probe.test.ts` · **Test:** `npm test -- header-probe` · **Done when:** all 11 detection rules from §3.2 implemented as pure functions over a `HeaderProbeResult`; localhost-mode skip works; cookie name patterns match TraiderJo's `tj_sess` and `tj_csrf` correctly; the CSRF cookie pattern excludes `csrf` cookies from `no_http_only`. · **DO NOT:** wire into the run loop; that's T15.

### Task v0.5-T13 — Resource-id extractor (Q7 step 1)
**Assignee:** @coder · **Depends on:** T01 · **Files to create:** `packages/cli/src/security/resource-id-extractor.ts`, `*.test.ts` · **Done when:** `extractIds(jsonBody, hints)` returns `{ field, value, resourceHint }[]`; handles arrays, nested objects, slug-shaped strings; tested with TraiderJo-shaped fixtures (`{ data: { id: "abc", trades: [{ tradeId: "..." }] } }`).

### Task v0.5-T14 — Cross-user phase
**Assignee:** @coder · **Depends on:** T01, T02, T13 · **Files to create:** `packages/cli/src/phases/cross-user.ts`, `*.test.ts` · **Files to modify:** `packages/cli/src/cli/index.ts` (wire phase between execute and classify) · **Test:** `npm test -- phases/cross-user` · **Done when:** integration test with stub SurfaceMCP and 3 fake roles correctly emits `idor_horizontal` for a 200 cross-user replay; emits `idor_vertical_role_escalate` for a 200 admin-route replay as non-admin; emits `auth_bypass_via_unauthed_route` for a 200 anonymous replay; suppresses 401/403/404 (correct gates).

### Task v0.5-T15 — Wire header probe into execute
**Assignee:** @coder · **Depends on:** T12 · **Files to modify:** `packages/cli/src/phases/execute.ts` (add per-page header-probe hook with origin-cache) · **Done when:** every unique origin is probed once per run; detections flow into `TestResult.bugs`; cache key is `<origin>` not `<page>`.

### Task v0.5-T16 — Rate-limit discovery (Q5 pre-flight)
**Assignee:** @coder · **Depends on:** T01 · **Files to create:** `packages/cli/src/security/rate-limit-discovery.ts`, `*.test.ts` · **Done when:** parses `RateLimit-*`, `X-RateLimit-*`, `Retry-After` headers correctly; falls back to `{ source: 'fallback', concurrency: 1, delayBetweenAttemptsMs: 200 }` when absent; never exceeds `maxAttempts`.

### Task v0.5-T17 — Auth probes (no-rate-limit)
**Assignee:** @coder · **Depends on:** T16 · **Files to create:** `packages/cli/src/security/auth-probes.ts`, `*.test.ts` · **Files to modify:** `packages/cli/src/cli/index.ts` (wire `--enable-auth-probes`) · **Done when:** opt-in only; rate-limit-discovery feeds the throttle; `no_rate_limit_on_login` fires only when cap reached without 429/423; integration test against TraiderJo's known-rate-limited login route does NOT fire (gate works).

### Task v0.5-T18 — Synthetic scenario: race-double-submit
**Assignee:** @coder · **Depends on:** T01 · **Files to create:** `packages/cli/src/synthetic/runner.ts`, `packages/cli/src/synthetic/scenarios/race-double-submit.ts`, `*.test.ts` · **Done when:** scenario fires only on `synthetic.enabled === true` AND mutator-shaped action; correctly counts duplicate POSTs; suppresses when 409/422/425 returned.

### Task v0.5-T19 — Synthetic scenario: optimistic-update-divergence
**Assignee:** @coder · **Depends on:** T18, vision (existing) · **Files to create:** `packages/cli/src/synthetic/scenarios/optimistic-update-divergence.ts`, `*.test.ts` · **Done when:** detects vision-success + HAR-failure dual signal; cluster signature includes endpoint + status.

### Task v0.5-T20 — Hydration-mismatch refinement
**Assignee:** @coder · **Depends on:** T01, T02 · **Files to modify:** `packages/cli/src/classify/react.ts`, `*.test.ts` · **Done when:** the three hydration patterns from §4.18 emit `hydration_mismatch` instead of `react_error`; existing `react_error` for non-hydration patterns continues unchanged.

### Task v0.5-T21 — Hallucinated-route detector (TS-AST)
**Assignee:** @coder · **Depends on:** T01, T06 · **Files to create:** `packages/cli/src/static/native/hallucinated-route.ts`, `*.test.ts` · **Done when:** `ts-morph` reads the project's frontend source; extracts `fetch(...)`/`axios.<verb>(...)` string-literal route args; cross-references SurfaceMCP catalog; emits one detection per non-cataloged call site; relative paths only; third-party hosts excluded.

### Task v0.5-T22 — Suppression CLI + filter
**Assignee:** @coder · **Depends on:** T01, T02 · **Files to create:** `packages/cli/src/cli/commands/suppress.ts`, `*.test.ts` · **Files to modify:** `packages/cli/src/phases/cluster.ts` (add suppression filter pass before emit) · **Done when:** `bughunter suppress <clusterId> --reason "..."` writes to `.bughunter/suppressions.json`; subsequent runs filter matching cluster signatures and increment `RunSummary.suppressedClusters`.

### Task v0.5-T23 — RunSummary additions
**Assignee:** @coder · **Depends on:** T01, T22 · **Files to modify:** `packages/cli/src/types.ts`, `packages/cli/src/phases/emit.ts` · **Done when:** `RunSummary` includes `suppressedClusters: number`, `vision.authMode: 'apiKey' | 'claudeCli'`, and `byKind` updated to count the 16 new kinds; existing summary fields unchanged.

### Task v0.5-T24 — Killer-demo runbook (TraiderJo)
**Assignee:** @qa · **Depends on:** T01–T23 · **Files to create:** `tests/e2e/v05-traiderjo.test.ts` (or extend an existing e2e harness) · **Done when:** end-to-end run against a local TraiderJo dev server produces at least three of the five §10 expected findings; failures are attached to the spec for triage; the run completes within 30 minutes at default concurrency.

### Task v0.5-T25 — Documentation pass
**Assignee:** @architect · **Depends on:** T01–T24 · **Files to modify:** `packages/cli/bughunt.md` (the skill file at `dist-skill/bughunt-host.md`'s source), `README.md` · **Done when:** v0.5 BugKinds are listed; `bughunter list-detectors` (if present, else doc only) describes each; the `--enable-auth-probes` flag is documented; the suppress flow is documented.

---

## 9. Acceptance + done-when matrix

The phase is "done" when every row of this matrix is green. The matrix is the canonical exit criterion; bug-of-the-day after this is a v0.5.x patch, not a v0.5 blocker.

| Row | Statement | Verifier | Pass condition |
|---|---|---|---|
| A1 | Types compile | `npx tsc --noEmit` | zero errors |
| A2 | Lint clean | `npx eslint .` | zero errors, zero warnings |
| A3 | Unit tests pass | `npx vitest run` | all green |
| A4 | New BugKind union has 16 new entries | `cat packages/cli/src/types.ts` + grep | exact list from §1 present |
| A5 | Cross-user phase emits IDOR clusters in stub-fixture run | T14 integration test | passes |
| A6 | Header probe emits CSP / CORS / cookie / CSRF / redirect / sensitive-URL / stack-trace clusters in stub-fixture run | T12, T15 tests | all six rule classes verified |
| A7 | Static analysis emits gitleaks / npm-audit / semgrep / eslint-no-empty findings on a planted-bad fixture project | T07–T10 fixture tests | each produces at least one detection |
| A8 | sqlmap skeleton compiles, pre-filter selects expected routes, actual run returns `not_implemented` | T11 test | passes |
| A9 | Auth probes opt-in only; gated by `--enable-auth-probes` | T17 + manual run | flag-off run does not call sacrificial endpoint |
| A10 | Rate-limit discovery falls back correctly when no headers present | T16 test | both branches covered |
| A11 | Synthetic scenarios (race-double-submit, optimistic-divergence) gated by `synthetic.enabled === true` | T18, T19 tests | flag-off, no scenario runs |
| A12 | Hydration patterns emit `hydration_mismatch`; non-hydration React errors still emit `react_error` | T20 test | both paths covered |
| A13 | Hallucinated-route detector finds planted fake route in fixture frontend | T21 test | passes |
| A14 | Vision auth detection: claudeCli when binary present; apiKey when env set; unavailable otherwise | T03–T05 tests | all three branches |
| A15 | Existing API-key vision tests pass unchanged | regression | all green |
| A16 | `bughunter suppress` writes the file and the next run filters | T22 integration test | suppressed cluster does not emit |
| A17 | RunSummary has `suppressedClusters` and `vision.authMode` | T23 test | passes |
| A18 | TraiderJo killer-demo run produces at least 3 of 5 expected findings | T24 e2e | passes |
| A19 | Re-entrancy: two concurrent runs in one process do not corrupt each other's state | new test | passes |
| A20 | No `as any` introduced anywhere | grep | zero hits in new files |
| A21 | All new files under 300 lines | wc | zero violations |
| A22 | All exported functions max 40 lines | tooling (`complexity-report` or eslint `max-lines-per-function: 40`) | zero violations |
| A23 | No `child_process.spawn` outside the two allowlisted directories | grep | zero violations |
| A24 | No commercial Semgrep references | grep `pro\|paid\|commercial` in semgrep config | zero hits |
| A25 | API responses follow `{ data, error }` convention | review | every new HTTP surface complies |

---

## 10. Killer-demo runbook (TraiderJo)

This is the demo @architect runs at end-of-phase to declare v0.5 done.

### 10.1 Setup

```bash
cd /tmp/TraiderJo
npm install
npm run db:reset && npm run db:seed
npm run dev:server &  # listens on configured port
npm run dev:client &  # vite dev
```

In a separate shell:

```bash
cd /root/BugHunter
npm install
npm run build
node packages/cli/dist/cli/index.js \
  --project /tmp/TraiderJo \
  --surface-mcp http://127.0.0.1:3104 \
  --enable-auth-probes \
  --vision \
  --static-analysis \
  --synthetic \
  --max-runtime-ms 1800000
```

### 10.2 Expected findings (the demo passes if at least 3 fire)

1. **`idor_horizontal` on `GET /api/trades/:tradeId/mistakes`** (`/tmp/TraiderJo/server/src/index.js:5004`) — fires when a non-shared user tries to read another user's mistakes; suppressed when shared-account access is correctly enforced. Either result is a passing demo: a fired finding is real; a suppressed one confirms the gate works.
2. **`missing_csp_header` (informational, weakness sub-kind) on `script-src 'unsafe-inline'`** (`index.js:397`) — fires reliably; `bughunter suppress` demonstrates the calibration UX.
3. **`vulnerable_dependency_high`** — at least one transitive high in the lockfile.
4. **`stack_trace_leak_in_response` on a known-faulty endpoint** — synthetic fault injection on a route that throws; if Express's default handler leaks, fires.
5. **`optimistic_update_divergence` on the trade-save flow** — synthetic scenario triggers a save with intentionally invalid payload; vision sees a success-shaped UI; HAR shows non-2xx; fires.

### 10.3 Demo recording protocol

- One terminal recording (asciinema or a screen capture) of the run start to the `RunSummary` print.
- Save the run's `runs/<runId>/` directory as the demo artifact.
- Update `README.md` with the demo result.

---

## 11. Process for using this spec

1. @architect assigns tasks T01–T25 in dependency order; T01 starts immediately.
2. @coder/@designer implement per task; no task spans more than 3 files.
3. After each task, the assignee runs the verification suite from the project CLAUDE.md (`tsc --noEmit`, `eslint --max-warnings 0`, `vitest run`, `build`); commits only on green.
4. @architect reviews each commit for §7 negative-requirement compliance and §9 row coverage.
5. T24 + T25 are the closing tasks; on green, v0.5 is shipped, the `spec/v05-security-hygiene` branch merges, and `SPEC_COMPREHENSIVE_ROADMAP.md` §6.v0.5 entry gets a "shipped 2026-MM-DD" annotation in a follow-up doc commit.

This spec is a contract. Any deviation requires a spec-edit commit, not a code-only fix.
