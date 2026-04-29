# SPEC — v0.16 "Active pen-testing palette"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-28 · **Sibling specs:** `SPEC_V07_XSS.md`, `SPEC_V07_AUTH_FLOWS.md`, `SPEC_V08_MEMORY_LEAK.md` · **Predecessor:** v0.5 security & hygiene cluster (PR A + PR B), v0.7 XSS (concurrent).

This spec adds an active **pen-testing palette** — four new BugKinds for the OWASP Top-10 injection classes that BugHunter does NOT currently exercise: server-side SQL injection, OS command injection, path traversal, and JWT misconfiguration. The detectors plant cryptographically-tagged canary payloads into form fields and URL parameters and observe the response for proof-of-injection signals. Each detection requires a **unique-tagged response signal** (no heuristic findings) — a finding fires only when a payload's nonce appears in a position that proves the payload was parsed/executed, mirroring the XSS spec's discipline.

---

## 1. Objective

Add four detectors that drive existing test surfaces (forms + URL params + JSON request bodies) with active probes:

| Kind | Invariant tested |
|---|---|
| `sql_injection` | Server input parsing does NOT interpolate user input into a SQL statement (error-based + boolean-based proofs). |
| `command_injection` | Server input parsing does NOT pass user input to a shell or `exec`-family call (output-marker proof). |
| `path_traversal` | Server file-path handlers do NOT resolve user input above the configured root (file-content proof OR known-marker proof). |
| `jwt_weak_alg` | Server's JWT verification rejects `alg: none` AND rejects HMAC-tampered tokens (response-status proof). |

**In scope:**
- Active probing of every form + URL-param + JSON-body slot already discovered by SurfaceMCP.
- Five canary payload variants per BugKind (per `injectionPalette` extension).
- Per-finding cluster signature: `kind|toolId|<param>|<variant>`.
- Telemetry on `summary.json.penTesting` showing probes attempted, succeeded, throttled (rate-limited), and skipped.
- Rate-limit awareness: respect the v0.5 rate-limit-discovery profile so we don't trigger lockouts.
- Opt-in via `config.penTesting?.enabled` (default **false** because some endpoints are mutating).

**Out of scope (deferred):**
- SSRF (Server-Side Request Forgery) — needs an exfiltration callback channel (DNS or HTTP). v0.17.
- Blind SQL injection (time-based) — requires baseline-timing measurement infra. v0.17.
- LDAP injection, NoSQL injection, XXE, SSTI, HTTP-smuggling — v0.18+.
- Authenticated-only privilege-escalation paths (covered by v0.5 IDOR cluster).
- Mass assignment — partly covered by IDOR vertical-role escalate; v0.18 if telemetry shows a real gap.
- Active fuzzing of file uploads / multipart bodies — v0.17.

**Acceptance target on a synthetic vulnerable fixture:**
Add a test fixture (`fixtures/pen-bad/`) that has one route per BugKind with a known vulnerability. Smoke run produces ≥1 finding per BugKind with the correct `injectionContext.nonce` AND `proof` field. On TraiderJo / Aspectv3 production paths: zero findings expected; both apps use parameterized queries and have no shell-call surface.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/security/injection-palette.ts` | Existing XSS canary palette (v0.7). **Extend** — do not duplicate. New variants under `kind: 'sql' \| 'cmd' \| 'path' \| 'jwt'` discriminated union. |
| `packages/cli/src/security/injection-palette.test.ts` | Pattern for unit-testing palette generation. Mirror. |
| `packages/cli/src/types.ts` | `BugKind` union. Add the four new variants. Add `injectionContext` field on `BugDetection` if not already extended for XSS. |
| `packages/cli/src/cluster/signature.ts` | Cluster-signature derivation. Add four new cases. |
| `packages/cli/src/phases/classify.ts` | `KIND_PRIORITY` array. Inject the four new kinds **above** `idor_horizontal` (they are unconditionally critical when a tagged proof fires). |
| `packages/cli/src/phases/execute.ts` | API and form execution paths. Both call sites of the existing XSS observer must be extended to invoke the pen-test observers. |
| `packages/cli/src/mutation/apply.ts` | Test-case minting for each palette variant. Mirror the XSS path. |
| `packages/cli/src/security/rate-limit-discovery.ts` | Rate-limit profile. The pen-test runner reads this and inserts inter-attempt sleeps. |
| `packages/cli/src/static/sqlmap-runner.ts` | Existing TODO stub for sqlmap. **Do NOT** wire sqlmap; this spec ships native detection so we don't add a 50MB Python dep. Remove the stub or leave the TODO comment in place. |

### 2.2 Patterns to follow

- **Active proof, never heuristic.** Every finding requires a unique-tagged response signal: a SQL error string mentioning our nonce, a shell-exec output marker carrying our nonce, a file-content marker, or a JWT-validation proof. Never report on a "looks like" pattern.
- **Cluster-signature normalization.** Every kind defines its `clusterSignature` deterministically.
- **Rate-limit honoring.** Each probe waits at least `rateLimitProfile.minDelayMs` between attempts on the same endpoint. Default 200ms when no profile is available.
- **Discriminated-union returns** for the runner: `{ ok: true; finding: BugDetection } | { ok: false; reason: string }`.
- **Re-entrancy.** Zero global mutable state. RunState read exclusively from `runs/<runId>/`.

### 2.3 DO NOT

- Do **not** depend on `sqlmap`, `commix`, `nuclei`, or any external pen-test binary.
- Do **not** plant payloads that can leave permanent destructive state (DROP TABLE, DELETE FROM, `rm -rf`, `:(){ :|:& };:`). Whitelist the canary payloads in code; reject anything matching a destructive-pattern denylist.
- Do **not** run pen-tests against `https://*` without explicit `--allow-external` flag (already enforced by SurfaceMCP).
- Do **not** treat a 500 alone as proof. SQL injection requires the response body to contain the canary nonce inside a SQL-error fingerprint.
- Do **not** plant JWTs against endpoints that aren't using JWT auth (read auth config to gate).

---

## 3. Cross-cutting infrastructure

### 3.1 InjectionPalette extension

Extend `security/injection-palette.ts`. Today's shape (v0.7):

```ts
export type InjectionVariant = {
  kind: 'xss';
  variantName: 'script_inline' | 'img_onerror' | 'svg_onload' | ...;
  template: (nonce: string) => string;
};
```

v0.16 extends to:

```ts
export type InjectionVariant =
  | { kind: 'xss'; variantName: XssVariantName; template: (nonce: string) => string; }
  | { kind: 'sql'; variantName: SqlVariantName; template: (nonce: string) => string; }
  | { kind: 'cmd'; variantName: CmdVariantName; template: (nonce: string) => string; }
  | { kind: 'path'; variantName: PathVariantName; template: (nonce: string) => string; }
  | { kind: 'jwt'; variantName: JwtVariantName; template: (nonce: string) => string; };
```

Variant catalog:

**SQL (5 variants):**
- `error_quote` — `' BUGHUNTER_<nonce> --` (forces a syntax error mentioning the nonce on most DBs).
- `error_double_quote` — `" BUGHUNTER_<nonce> --` (double-quote variant).
- `boolean_true` — `' OR '<nonce>'='<nonce>` (boolean-true tautology). Pair with same-endpoint baseline.
- `boolean_false` — `' AND '<nonce>'='<other_nonce>` (false tautology). Compare row counts.
- `union_select_marker` — `' UNION SELECT '<nonce>' --` (response body should contain `<nonce>` if vulnerable).

**Command injection (5 variants):**
- `shell_pipe_echo` — `; echo BUGHUNTER_<nonce>` (Linux semicolon).
- `shell_amp_echo` — `& echo BUGHUNTER_<nonce>` (Windows ampersand).
- `shell_subshell_echo` — `$(echo BUGHUNTER_<nonce>)` (subshell).
- `shell_backtick_echo` — `` `echo BUGHUNTER_<nonce>` `` (backtick).
- `shell_pipe_uniq_marker` — `| printf 'BUGHUNTER_<nonce>'` (pipe).

**Path traversal (5 variants):**
- `linux_etc_passwd_relative` — `../../../etc/passwd`.
- `linux_etc_passwd_with_marker_segment` — `../../BUGHUNTER_<nonce>/../../etc/passwd` (lets us see the nonce in error messages even if the read is blocked).
- `windows_win_ini` — `..\\..\\..\\windows\\win.ini`.
- `null_byte_termination` — `<base> ` (legacy null-byte bypass).
- `url_encoded_dotdot` — `%2e%2e%2f%2e%2e%2fetc%2fpasswd`.

**JWT (5 variants):**
- `alg_none_unsigned` — header `{"alg":"none","typ":"JWT"}` with admin-claim payload.
- `alg_none_lowercase` — `{"alg":"none"}` lowercase variant.
- `alg_none_mixed_case` — `{"alg":"NoNe"}` (case-insensitive parser bypass).
- `weak_hmac_short_secret` — sign with `HS256` over a known-weak secret list (`"secret"`, `"key"`, `"jwt"`, `"password"`).
- `key_confusion_rs_to_hs` — sign HS256 using the public RSA key as the HMAC secret.

JWT probes need a known-target endpoint that accepts a JWT bearer; gated by `config.penTesting.jwtTargets?: string[]` (list of endpoint paths to probe). If unset, JWT probes skip with `skipReason: 'no_jwt_targets'`.

### 3.2 Detection algorithms

#### `detectSqlInjection(probe, response): SqlInjectionDetection | null`
- For `error_quote` / `error_double_quote` / `union_select_marker`: search response body (text + JSON-stringified) for both:
  - The nonce string `BUGHUNTER_<nonce>`.
  - One of the SQL-error fingerprints: `unrecognized token`, `syntax error`, `mismatched input`, `Microsoft OLE DB Provider`, `ORA-`, `PostgreSQL`, `MariaDB`, `MySQL`, `near "BUGHUNTER`, `at line`. (Maintain in a constant; keep concise.)
- For `boolean_true` / `boolean_false`: requires baseline. Send both true and false variants; if `response.body.length` differs by ≥30%, fire.
- Fire kind: `sql_injection` with `injectionContext.nonce`, `injectionContext.variant`, `injectionContext.proof: 'error_string' | 'boolean_difference'`.

#### `detectCommandInjection(probe, response): CommandInjectionDetection | null`
- Search response body for the literal string `BUGHUNTER_<nonce>`.
- If found at all: fire kind `command_injection` with `proof: 'output_marker'`.
- Pure proof — no heuristic. Server execution would have to literally print the nonce in the response.

#### `detectPathTraversal(probe, response): PathTraversalDetection | null`
- Search response body for fingerprints of `/etc/passwd` content: `root:x:0:0`, `nobody:x:`, `daemon:x:`. Or `[fonts]` / `[mail]` for `win.ini`.
- AND the response status is a 2xx (so the file was actually returned, not just blocked).
- Fire kind `path_traversal` with `proof: 'file_content'`.

#### `detectJwtWeakAlg(probe, response): JwtWeakAlgDetection | null`
- For `alg_none_*`: a successful (200) response on a route that REQUIRES auth (per surface meta `requiresAuth: true`) means the unsigned token was accepted. Fire `jwt_weak_alg` with `proof: 'unsigned_accepted'`.
- For `weak_hmac_short_secret`: 200 response with our forged token means the server signed with the weak secret. Fire with `proof: 'weak_secret_<value>'`.
- For `key_confusion_rs_to_hs`: 200 response. Fire with `proof: 'rs_to_hs_confusion'`.

### 3.3 PenTestRunner

New file `packages/cli/src/security/pen-test-runner.ts`:

```ts
export type PenTestRunnerConfig = {
  enabled: boolean;
  targetTools: ToolMeta[];           // from SurfaceMCP catalog
  forms: DiscoveredForm[];
  variants: ('sql' | 'cmd' | 'path' | 'jwt')[];   // default: all four
  rateLimitProfile?: RateLimitProfile;
  jwtTargets?: string[];
  maxProbesPerEndpoint?: number;     // default: 25 (5 variants × 5 kinds)
};

export type PenTestRunnerResult = {
  detections: BugDetection[];
  telemetry: {
    probesAttempted: number;
    probesSucceeded: number;
    probesThrottled: number;
    probesSkipped: { reason: string; count: number }[];
    detectionsByKind: Record<string, number>;
  };
};

export async function runPenTests(
  cfg: PenTestRunnerConfig,
  surface: SurfaceMcpAdapter,
  cookies: CookieEntry[]                 // current authed session
): Promise<PenTestRunnerResult>;
```

Runs **after execute, before classify**, alongside the v0.5 cross-user runner. Iterates targetTools × variants. Honors rate limit. Each probe is one HTTP call; the response is fed to the four detectors. Findings emitted as `BugDetection`s; cross-cluster signature follows §3.4.

### 3.4 Cluster signatures

```ts
case 'sql_injection': {
  return `sql_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}|${detection.injectionContext?.variant ?? ''}`;
}
case 'command_injection':
  return `command_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
case 'path_traversal':
  return `path_traversal|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
case 'jwt_weak_alg':
  return `jwt_weak_alg|${detection.endpoint ?? ''}|${detection.injectionContext?.proof ?? ''}`;
```

### 3.5 Telemetry

Add to `summary.json`:

```ts
penTesting?: {
  enabled: boolean;
  probesAttempted: number;
  probesSucceeded: number;
  probesThrottled: number;
  probesSkipped: { reason: string; count: number }[];
  detectionsByKind: Record<string, number>;
  durationMs: number;
};
```

---

## 4. BugDetection field extension

Add (or extend if XSS already added) `injectionContext` to `BugDetection`:

```ts
injectionContext?: {
  paramName: string;            // form field or URL param
  variant: string;              // e.g. 'error_quote', 'shell_pipe_echo'
  nonce: string;                // tagged value
  proof:
    | 'error_string'
    | 'boolean_difference'
    | 'output_marker'
    | 'file_content'
    | 'unsigned_accepted'
    | 'weak_secret_<value>'
    | 'rs_to_hs_confusion';
  evidence: string;             // 200-char snippet of the matching response substring
};
```

If XSS spec already added an `xssContext` or `injectionContext` field, **extend that field**. Do not create a parallel.

---

## 5. Edge cases

### EC-1. Endpoint requires CSRF token
Pen-test runner reads CSRF from the existing browser-login cookie jar (same path the v0.5 CSRF detector uses). If endpoint requires it and we don't have one, skip with `csrf_required`.

### EC-2. Endpoint responds 429 (rate limited)
Pause for `Retry-After` header value or 30s default. Resume. Counted as `probesThrottled`. Do not count as a finding.

### EC-3. Same nonce appears in TWO different endpoint responses
Two findings, two clusters (different `endpoint` in cluster signature). Possible cross-endpoint contamination — log as a soft warning but emit both findings.

### EC-4. SQL `boolean_true` returns same-size response as baseline
Below the 30% delta threshold → no detection. Document the threshold as tunable via `config.penTesting.booleanDeltaThreshold` (default 0.3).

### EC-5. JWT probe sent to a non-JWT endpoint
Only probe endpoints listed in `config.penTesting.jwtTargets`. If a list isn't provided, skip JWT bucket entirely with `no_jwt_targets`.

### EC-6. Server returns HTML 200 with our nonce echoed in plaintext
That's also XSS. The XSS observer (v0.7) catches it. Pen-test runner does NOT double-count; if a finding's nonce is also found in v0.7's reflected-canary set, we surface only the higher-priority kind (XSS reflected before SQL injection by `KIND_PRIORITY`).

### EC-7. Path-traversal probe returns `/etc/passwd` content but the server is a localhost dev box
Still a real finding — local privilege boundaries matter. Document in the cluster's rootCause: "Path traversal returned /etc/passwd content. Severity: critical even on dev — review filesystem-access guards before deploy."

### EC-8. Probe payload contains characters the framework rejects (e.g., `;` in Express `req.query`)
The probe still goes; if framework returns 400, that's expected non-vulnerable behavior. No finding.

### EC-9. Server caches our probe response
For idempotent (GET) endpoints, send `Cache-Control: no-cache` header to avoid cache poisoning.

### EC-10. Probe causes side effects (DB writes, file changes)
Per §2.3 "do not plant destructive payloads." User opts in via `config.penTesting.enabled = true`. Document the trust boundary in the killer-demo runbook: pen-test against staging/dev only.

---

## 6. Test plan

### 6.1 Unit tests

For each of the 20 variants (5 × 4 BugKinds):
- Palette template renders correctly with a known nonce
- Detector returns a finding when given a synthetic positive response
- Detector returns null on a clean response
- Detector returns null when nonce is absent

Total: 80+ unit tests across `injection-palette.test.ts` and `pen-test-runner.test.ts`.

### 6.2 Synthetic fixture (`fixtures/pen-bad/`)

A minimal Express app with four vulnerable routes:
- `GET /search?q=<sql>` — interpolates `q` into a SQLite query string.
- `GET /lookup?host=<cmd>` — passes `host` to `child_process.exec("ping -c 1 " + host)`.
- `GET /file?name=<path>` — reads `path.join('/var/www', name)` without sanitization.
- `POST /admin/promote` — JWT-protected, accepts `alg=none`.

Smoke against this fixture must produce ≥1 finding per BugKind, with the correct nonce and proof.

### 6.3 Negative smoke (TraiderJo / Aspectv3)

Both target apps use parameterized queries (Drizzle / Prisma) and no shell-call surface. Expected: zero pen-test findings. Acceptance: zero false positives across both targets when `config.penTesting.enabled = true`.

---

## 7. Negative requirements

- Do **not** ship sqlmap or any external pen-test binary.
- Do **not** plant payloads matching the destructive-pattern denylist (DROP, DELETE, TRUNCATE, UPDATE without WHERE, `rm`, `mkfs`, `:(){...}`, etc.).
- Do **not** probe endpoints lacking explicit `requiresAuth` metadata for JWT (skip silently).
- Do **not** double-count findings that overlap with XSS reflection (XSS wins by `KIND_PRIORITY`).
- Do **not** treat 500 alone as proof.
- Do **not** retry on 429 forever — abort after 3 attempts per endpoint.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add four `BugKind` variants + extend `injectionContext` | `types.ts` | none |
| 2 | Extend `injection-palette.ts` with SQL/CMD/PATH/JWT variants (20 templates) + unit tests | `security/injection-palette.ts`, `injection-palette.test.ts` | 1 |
| 3 | Implement detectors (`detectSqlInjection`, `detectCommandInjection`, `detectPathTraversal`, `detectJwtWeakAlg`) as pure functions + unit tests | `security/pen-detectors.ts` (new), `pen-detectors.test.ts` (new) | 1 |
| 4 | Implement `runPenTests` runner | `security/pen-test-runner.ts` (new) | 2, 3 |
| 5 | Add cluster signatures + KIND_PRIORITY slots | `cluster/signature.ts`, `phases/classify.ts` | 1 |
| 6 | Wire `runPenTests` into the orchestrator (after execute, before classify) | `cli/run.ts` | 4, 5 |
| 7 | Add `penTesting` telemetry to summary.json | `phases/emit.ts`, `types.ts` | 4 |
| 8 | Synthetic vulnerable fixture (`fixtures/pen-bad/`) + integration test | `fixtures/pen-bad/`, `tests/integration/pen-test-smoke.test.ts` | 4-7 |
| 9 | Negative smoke against TraiderJo / Aspectv3 (zero findings) | (manual) | 4-8 |

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All 80+ unit tests pass | `npm test` |
| Integration test against `fixtures/pen-bad/` produces ≥1 finding per BugKind with correct nonce + proof | `npm test -- pen-test-smoke` |
| Zero pen-test findings on Aspectv3 with `penTesting.enabled = true` (both apps use parameterized queries) | manual smoke |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| `summary.json.penTesting` block present and correctly populated | `jq` |
| Destructive-pattern denylist enforced (try planting `DROP TABLE` → palette throws at compile time) | unit test |

---

## 10. Risk + escape hatches

- **Risk: probing destroys data on a misconfigured target.** Pen-testing is opt-in (`config.penTesting.enabled`), payloads are read-only, denylist enforced. Document trust model: "stage/dev targets only."
- **Risk: rate-limit lockout from too many probes.** Runner reads `rate-limit-discovery` profile. Default 200ms inter-probe delay when no profile. Aborts on 429-after-3-retries.
- **Risk: false positives on apps that legitimately echo the nonce (e.g., search endpoints).** Mitigated by requiring SQL-error fingerprint AND nonce for `sql_injection`. Plain echo without error → no finding.
- **Risk: JWT probes get the user logged out / session invalidated.** Pen-test runner uses a separate authed session that's discarded after the probe sequence; it does NOT use the main BugHunter session.
- **Escape hatch:** `--no-pen-testing` CLI flag disables the entire phase even if `config.penTesting.enabled = true`. Useful for debugging.

---

## 11. Killer-demo runbook (synthetic + Aspectv3)

```bash
# 1. Synthetic vulnerable fixture
cd packages/cli && npm test -- tests/integration/pen-test-smoke
# Expect ≥1 finding per BugKind with proof field set.

# 2. Negative smoke on Aspectv3 (set penTesting.enabled = true in .bughunter/config.json)
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 100 --budget 2400000

# 3. Verify zero pen findings
jq '.byKind | (.sql_injection // 0) + (.command_injection // 0) + (.path_traversal // 0) + (.jwt_weak_alg // 0)' \
  /root/Aspectv3/.bughunter/runs/$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)/summary.json
# Expect: 0
```

---

## 12. Open questions

1. Should `boolean_true`/`boolean_false` SQL probes share a baseline call to avoid 2x request volume? Spec says yes — fetch baseline once per endpoint, compare both variants against it.
2. Should JWT key-confusion (`rs_to_hs`) require the server's public key in advance? Yes — `config.penTesting.jwtPublicKeyPemPath` is the path to read. If unset, skip that one variant.
3. Should we report `path_traversal` proof when content matches `/etc/passwd` BUT the server appears to be a sandboxed runtime that doesn't actually have that file? Spec says fire — the response confirmed the read attempt landed in a real filesystem.
