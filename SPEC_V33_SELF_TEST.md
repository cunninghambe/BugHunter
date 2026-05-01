# SPEC — v0.33 "BugHunter-on-BugHunter self-test"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** V26 `DETECTOR_REGISTRY` (`packages/cli/src/detectors/registry.ts`), V21 `fixtures/idor-bad/`, V19 `fixtures/race-bad/`, V24 `fixtures/v24-deferred-bugs/`, existing `fixtures/{a11y-bad,seo-bad,pen-bad,heap-leak,vision-broken-page,stack-trace-clustering}/` · **Phase:** C (Trust) of `SPEC_PATH_TO_EXHAUSTIVE.md` §6.2.

This spec adds the `bughunter self-test` subcommand and a deliberately-buggy fixture app that exercises one production-input path per **wired** BugKind in `DETECTOR_REGISTRY`. The command is the gold-standard regression gate: BugHunter must continue to find what it claims to find, must continue to NOT false-positive on what it explicitly defers, and must continue to do so within a known time budget.

---

## 1. Status / Author / Date / Depends on

| Field | Value |
|---|---|
| Status | Draft 1 |
| Author | `@architect` (Opus, ultrathink) |
| Date | 2026-04-30 |
| Predecessor specs | V26 (`DETECTOR_REGISTRY`), V19 (race), V21 (IDOR), V24 (deferred-perf fixture) |
| Phase | `SPEC_PATH_TO_EXHAUSTIVE.md` §9 Phase C — Trust |
| Source motivation | `SPEC_PATH_TO_EXHAUSTIVE.md` §6.2 BugHunter-on-BugHunter self-test |
| Out-of-tree dependencies | none — fixture is local node + vite, no SurfaceMCP external host |

---

## 2. Problem statement

We have ~60 declared `BugKind`s. Of those, V26's `DETECTOR_REGISTRY` partitions them into `wired` (have a real detector site, file:line known), `deferred` (acknowledged gaps; SPEC_PATH_TO_EXHAUSTIVE §3, §9 Phase A backlog), and `dead` (kind exists in union but no detector and no plan). PR #53 (audit-cleanup) plus V26 introspection make those statuses observable. What we DO NOT have is a regression gate that runs BugHunter end-to-end against a fixture and asserts:

1. **Every wired kind still fires.** A regression that quietly breaks the `xss_dom` detector should fail the next CI run, not surface six weeks later when a customer reports a missed XSS.
2. **Every deferred kind stays deferred.** If we ship a detector for `csrf_missing_on_mutating_route` we want a celebratory failure of the self-test telling us to flip the registry status. Until then, the absence of a cluster on a deliberate CSRF-vulnerable route is the ground truth that the gap is still real.
3. **Total run time within budget.** Performance creep (more detectors → slower run) is silent today. The self-test is the only synthetic workload that exercises every detector simultaneously, so a wallclock regression here is the strongest leading indicator of customer-side latency drift.

Concretely: `bughunter self-test` runs BugHunter against `fixtures/bughunter-self-deliberate-bugs/`, compares the resulting `bugs.jsonl` against `golden-bugs.jsonl`, and exits 0 only when wired-kind expectations are met, deferred-kind expectations are met, and wallclock ≤ budget.

This is the second leg of Phase C trust — alongside V32 deterministic mode (frozen-clock + frozen-network + seed) and the V34 coverage report. Without these three, "comprehensive" is asserted, not demonstrated.

---

## 3. Boundaries

### 3.1 In scope

- New CLI subcommand `bughunter self-test` registered in `packages/cli/src/cli/main.ts`.
- New module `packages/cli/src/cli/self-test.ts` implementing the command.
- New fixture root `fixtures/bughunter-self-deliberate-bugs/` — a **composite coordinator** fixture that:
  - Reuses existing fixtures (`race-bad`, `idor-bad`, `v24-deferred-bugs`, `a11y-bad`, `seo-bad`, `pen-bad`, `heap-leak`, `vision-broken-page`, `stack-trace-clustering`) by referencing them — does NOT duplicate their server code.
  - Adds **only** the deliberate bugs that no existing fixture covers (small Vite SPA + minimal Node API server with one route per uncovered wired kind).
- New `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` — one line per expected cluster, with the assertion shape defined in §5.
- New `fixtures/bughunter-self-deliberate-bugs/.bughunter/config.json` (committed) — pre-baked BugHunter project config so `self-test` runs without `init`.
- New `fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json` (committed) — pre-baked SurfaceMCP config covering all sub-fixture surfaces.
- New `fixtures/bughunter-self-deliberate-bugs/bin/up.sh` and `down.sh` — start/stop coordinator that brings every required sub-fixture port up before the run.
- Integration test `tests/integration/self-test.smoke.test.ts` exercising the command in CI.

### 3.2 Out of scope (deferred)

- **Public BugHunter-bench corpus** (`SPEC_PATH_TO_EXHAUSTIVE.md` §6.3, Phase F). The self-test is the *internal* gate; the public benchmark is a downstream multi-app calibration suite. Different artifact, different repo.
- **Per-kind precision/recall numbers** — `bughunter calibrate` (Phase F). Self-test is binary (pass/fail per kind), not numeric.
- **Severity assertions** — V35 will add severity to detector metadata; self-test today only asserts presence/absence.
- **Cross-run identity (bugIdentity)** — Phase D. Self-test compares cluster signatures, not stable identities.
- **Auto-fix loop assertions** — self-test does not run the architect/coder fix dispatch.
- **Full vision-MCP path on every kind** — vision is opt-in (cost), only `vision-broken-page` exercises it; the self-test asserts vision availability but does not gate on every BugKind triggering a vision call.
- **Multi-viewport, multi-tab, multi-context coordinator runs** — self-test runs on one viewport, one tab, one role per fixture (except IDOR which is inherently 2-role).
- **Determinism enforcement** — V32 owns `--seed` / `--frozen-clock` / `--frozen-network`. Self-test will *consume* those flags once V32 ships, but does not implement them.

### 3.3 External dependencies

- Node ≥ 20 (existing CLI requirement).
- Each sub-fixture's existing `package.json` deps (already vendored in repo).
- `vitest` for the integration test (already a dev dep).
- No new npm dependencies introduced by V33 itself.

---

## 4. Fixture-app design

### 4.1 Coordinator structure

```
fixtures/bughunter-self-deliberate-bugs/
├── README.md                    # NEW — what this is, how to run, do NOT deploy
├── package.json                 # NEW — deps for new-route SPA only
├── golden-bugs.jsonl            # NEW — one line per expected cluster
├── .bughunter/
│   └── config.json              # NEW — pre-baked BugHunter project config
├── surfacemcp.config.json       # NEW — points SurfaceMCP at composite surfaces
├── bin/
│   ├── up.sh                    # NEW — boots all required sub-fixture ports
│   └── down.sh                  # NEW — graceful teardown
├── api/
│   └── server.js                # NEW — minimal Node API for kinds NOT covered by existing fixtures (see §4.3)
├── web/
│   ├── index.html               # NEW — SPA entry
│   ├── vite.config.ts           # NEW
│   └── src/
│       ├── main.tsx             # NEW
│       ├── App.tsx              # NEW — router
│       └── pages/
│           ├── ConsoleError.tsx       # NEW
│           ├── ReactError.tsx         # NEW
│           ├── HydrationMismatch.tsx  # NEW (delegates to v24-deferred-bugs/Hydration if reachable)
│           ├── MissingStateChange.tsx # NEW
│           ├── DomErrorText.tsx       # NEW
│           ├── ClickAccessibleName.tsx # NEW (interactive_element_missing_accessible_name)
│           ├── VisualAnomaly.tsx      # NEW (delegates to vision-broken-page if reachable)
│           ├── XssReflected.tsx       # NEW
│           ├── XssDom.tsx             # NEW
│           └── (one page per remaining wired kind not covered elsewhere)
└── reuse-manifest.json          # NEW — declarative list: for each wired kind, which sub-fixture covers it
```

### 4.2 Reuse manifest

`reuse-manifest.json` tells the coordinator (and future maintainers) which existing fixture covers each wired kind. The manifest is the source of truth; `bin/up.sh` reads it and starts only the sub-fixtures referenced.

```json
{
  "comment": "DO NOT EDIT WITHOUT UPDATING golden-bugs.jsonl. One entry per wired kind in DETECTOR_REGISTRY.",
  "kinds": {
    "race_condition_double_submit":      { "fixture": "race-bad",            "port": 9994, "route": "/double-submit"   },
    "race_condition_click_navigate":     { "fixture": "race-bad",            "port": 9994, "route": "/click-then-nav"  },
    "race_condition_optimistic_revert":  { "fixture": "race-bad",            "port": 9994, "route": "/optimistic"      },
    "race_condition_interleaved_mutations": { "fixture": "race-bad",         "port": 9994, "route": "/counter"         },
    "race_condition_cross_tab":          { "fixture": "race-bad",            "port": 9994, "route": "/vote"            },
    "idor_horizontal":                   { "fixture": "idor-bad",            "port": 4090, "route": "/api/orders/:id"  },
    "idor_vertical_role_escalate":       { "fixture": "idor-bad",            "port": 4090, "route": "/api/admin/reports" },
    "auth_bypass_via_unauthed_route":    { "fixture": "idor-bad",            "port": 4090, "route": "/api/admin/reports" },
    "no_rate_limit_on_login":            { "fixture": "idor-bad",            "port": 4090, "route": "/api/login"       },
    "unbounded_list_render":             { "fixture": "v24-deferred-bugs",   "port": 5780, "route": "/long-list"       },
    "request_cancellation_missing":      { "fixture": "v24-deferred-bugs",   "port": 5780, "route": "/cancel"          },
    "dom_error_text":                    { "fixture": "v24-deferred-bugs",   "port": 5780, "route": "/error-toast"     },
    "hydration_mismatch":                { "fixture": "v24-deferred-bugs",   "port": 5780, "route": "/hydration"       },
    "accessibility_critical":            { "fixture": "v24-deferred-bugs",   "port": 5780, "route": "/a11y"            },
    "axe_color_contrast_strong":         { "fixture": "a11y-bad",            "port": 5781, "route": "/contrast"        },
    "keyboard_trap":                     { "fixture": "a11y-bad",            "port": 5781, "route": "/trap"            },
    "focus_lost_after_action":           { "fixture": "a11y-bad",            "port": 5781, "route": "/focus-lost"      },
    "image_missing_alt":                 { "fixture": "a11y-bad",            "port": 5781, "route": "/no-alt"          },
    "form_input_unlabeled":              { "fixture": "a11y-bad",            "port": 5781, "route": "/no-label"        },
    "seo_title_missing":                 { "fixture": "seo-bad",             "port": 5782, "route": "/no-title"        },
    "seo_title_duplicate_across_routes": { "fixture": "seo-bad",             "port": 5782, "route": "/duplicate-titles" },
    "seo_meta_description_missing":      { "fixture": "seo-bad",             "port": 5782, "route": "/no-meta-description" },
    "seo_canonical_missing":             { "fixture": "seo-bad",             "port": 5782, "route": "/no-canonical"    },
    "seo_h1_missing_or_multiple":        { "fixture": "seo-bad",             "port": 5782, "route": "/h1-issues"       },
    "seo_robots_blocking_crawl":         { "fixture": "seo-bad",             "port": 5782, "route": "/robots-block"    },
    "sql_injection":                     { "fixture": "pen-bad",             "port": 4091, "route": "/api/search"      },
    "command_injection":                 { "fixture": "pen-bad",             "port": 4091, "route": "/api/ping"        },
    "path_traversal":                    { "fixture": "pen-bad",             "port": 4091, "route": "/api/file"        },
    "jwt_weak_alg":                      { "fixture": "pen-bad",             "port": 4091, "route": "/api/login"       },
    "memory_leak_suspected":             { "fixture": "heap-leak",           "port": 5783, "route": "/"                },
    "memory_leak_attributed":            { "fixture": "heap-leak",           "port": 5783, "route": "/"                },
    "visual_anomaly":                    { "fixture": "vision-broken-page",  "port": 5784, "route": "/"                },
    "console_error":                     { "fixture": "self",                "port": 5790, "route": "/console-error"   },
    "react_error":                       { "fixture": "self",                "port": 5790, "route": "/react-error"     },
    "unhandled_exception":               { "fixture": "self",                "port": 5790, "route": "/unhandled"       },
    "missing_state_change":              { "fixture": "self",                "port": 5790, "route": "/no-state-change" },
    "interactive_element_missing_accessible_name": { "fixture": "self",      "port": 5790, "route": "/click-no-name"   },
    "network_5xx":                       { "fixture": "self",                "port": 5791, "route": "/api/boom"        },
    "network_4xx_unexpected":            { "fixture": "self",                "port": 5791, "route": "/api/teapot"      },
    "404_for_linked_route":              { "fixture": "self",                "port": 5790, "route": "/dead-link"       },
    "surface_call_failed":               { "fixture": "self",                "port": 5791, "route": "/api/refuse"      },
    "xss_reflected":                     { "fixture": "self",                "port": 5791, "route": "/api/echo"        },
    "xss_dom":                           { "fixture": "self",                "port": 5790, "route": "/xss-dom"         },
    "auth_session_fixation":             { "fixture": "self",                "port": 5791, "route": "/api/login-fixation" },
    "password_reset_token_reuse":        { "fixture": "self",                "port": 5791, "route": "/api/reset"       },
    "missing_csp_header":                { "fixture": "self",                "port": 5791, "route": "/headers/no-csp"  },
    "permissive_cors":                   { "fixture": "self",                "port": 5791, "route": "/headers/wide-cors" },
    "cookie_security_flags":             { "fixture": "self",                "port": 5791, "route": "/headers/bad-cookie" },
    "open_redirect":                     { "fixture": "self",                "port": 5791, "route": "/redirect"        },
    "sensitive_data_in_url":             { "fixture": "self",                "port": 5791, "route": "/api/transfer"    },
    "stack_trace_leak_in_response":      { "fixture": "self",                "port": 5791, "route": "/api/throw"       },
    "vulnerable_dependency_high":        { "fixture": "self",                "port": null, "route": "package.json"     },
    "hardcoded_credentials_in_source":   { "fixture": "self",                "port": null, "route": "src/leaked.ts"    },
    "swallowed_error_empty_catch":       { "fixture": "self",                "port": null, "route": "src/swallow.ts"   },
    "slow_lcp":                          { "fixture": "self",                "port": 5790, "route": "/slow-lcp"        },
    "slow_inp":                          { "fixture": "self",                "port": 5790, "route": "/slow-inp"        },
    "high_cls":                          { "fixture": "self",                "port": 5790, "route": "/cls"             },
    "n_plus_one_api_calls":              { "fixture": "self",                "port": 5790, "route": "/n-plus-one"      },
    "request_dedup_missing":             { "fixture": "self",                "port": 5790, "route": "/dedup"           },
    "main_thread_blocked":               { "fixture": "self",                "port": 5790, "route": "/long-task"       },
    "oversized_bundle":                  { "fixture": "self",                "port": 5790, "route": "/"                },
    "excessive_re_renders":              { "fixture": "self",                "port": 5790, "route": "/rerender"        }
  },
  "deferred": [
    "csrf_missing_on_mutating_route",
    "race_double_submit",
    "optimistic_update_divergence",
    "hallucinated_route",
    "xss_stored"
  ]
}
```

### 4.3 New SPA + API server (kinds NOT covered by existing fixtures)

The fixture introduces TWO new processes (ports `5790` for the SPA, `5791` for the API server). Total fixture surface area: ~30 new pages and ~15 new API endpoints, plus the three static-analysis files. **No new dependencies beyond the v24-deferred-bugs Vite + React stack.**

For each `"fixture": "self"` entry in §4.2, the corresponding page or endpoint:

- Uses **plain React + plain Node**; no extra libraries.
- Is **deliberately and obviously buggy** with a 1-2-line `// SELF-TEST: triggers <kind>` comment immediately above the bug.
- Exposes the bug on a **stable URL/selector** referenced by `golden-bugs.jsonl`.

Examples:

| Kind | Implementation sketch |
|---|---|
| `console_error` | `useEffect(() => { console.error('SELF-TEST CONSOLE ERROR ' + Math.random()); }, []);` |
| `react_error` | A child component that throws on render: `throw new Error('SELF-TEST RENDER FAIL')` (no error boundary). |
| `unhandled_exception` | `setTimeout(() => { throw new Error('SELF-TEST UNCAUGHT ASYNC') }, 50);` |
| `missing_state_change` | A button `<button id="ghost-btn">Save</button>` with no click handler at all. |
| `network_5xx` | Page makes `fetch('/api/boom')` on load; API responds 500. |
| `network_4xx_unexpected` | Page makes `fetch('/api/teapot')`; API responds 418. |
| `404_for_linked_route` | `<a href="/dead-link">x</a>` linking to a route that does not exist. |
| `surface_call_failed` | API `/api/refuse` always returns ECONNRESET (or 503 with error JSON the surface adapter rejects). |
| `xss_reflected` | API `/api/echo?q=<input>` returns `<html><body>${q}</body></html>` un-escaped. |
| `xss_dom` | Page reads `location.hash`, sets `document.body.innerHTML = hash` — direct DOM XSS. |
| `interactive_element_missing_accessible_name` | `<button id="x"></button>` — empty button, no aria-label, no children. |
| `slow_lcp` | LCP image is a 6 MB sleep-served PNG (`/slow.png`). |
| `slow_inp` | Click handler runs `for (let i=0; i<5e8; i++) {}`. |
| `high_cls` | `<img>` with no width/height + late-mounting card pushes content down 400px. |
| `n_plus_one_api_calls` | List of 12 items, each `useEffect`s `fetch('/api/item/' + id)`. |
| `request_dedup_missing` | Same effect fires `fetch('/api/foo')` 4 times in 100ms. |
| `main_thread_blocked` | Synthetic 250ms blocking work on mount. |
| `excessive_re_renders` | `setState` in `useEffect` with no deps — infinite-ish loop. |
| `oversized_bundle` | Vite build emits a >500KB initial JS chunk (forced via `import * as bigLib from './bloat.ts'` where bloat.ts is 600KB of generated string constants). |
| `auth_session_fixation` | API `/api/login-fixation` accepts a client-supplied session id. |
| `password_reset_token_reuse` | API `/api/reset` accepts the same token twice. |
| `missing_csp_header` | API responses omit `Content-Security-Policy`. |
| `permissive_cors` | API responds with `Access-Control-Allow-Origin: *` AND `Access-Control-Allow-Credentials: true`. |
| `cookie_security_flags` | Sets `Set-Cookie: sid=foo` (no Secure, no HttpOnly, no SameSite). |
| `open_redirect` | `/redirect?to=...` follows arbitrary `to`. |
| `sensitive_data_in_url` | `/api/transfer?ssn=123456789&token=xxx` — leaks secrets via query string. |
| `stack_trace_leak_in_response` | `/api/throw` returns 500 with a Node stack trace in the body. |
| `vulnerable_dependency_high` | `package.json` declares `"left-pad": "0.0.3"` — a known-bad pin (or a synthetic devDependency aligned with current `npm audit` data). |
| `hardcoded_credentials_in_source` | `src/leaked.ts` contains `export const API_KEY = 'AKIA...';`. |
| `swallowed_error_empty_catch` | `src/swallow.ts` contains `try { riskyOp(); } catch (e) {}`. |

### 4.4 Reuse, do not duplicate

For every `"fixture": "<name>"` reference in §4.2 where `<name> !== "self"`:

- The coordinator runs **the existing sub-fixture's `start` script as-is** (`bin/up.sh` calls `npm start --prefix fixtures/<name>` or `npm run dev --prefix fixtures/<name>` depending on which the existing fixture exposes).
- The coordinator does NOT copy or fork sub-fixture code.
- The golden-bugs file references the sub-fixture's existing routes (which are already deliberately broken in known ways).
- If a sub-fixture's port collides with another, it is the **sub-fixture's** maintainer's job to expose a `PORT` env var; coordinator passes one. (race-bad already does — `RACE_BAD_PORT`. idor-bad already does — `PORT`. v24-deferred-bugs is Vite — `--port`. Existing pattern.)

### 4.5 Why not one mega-app?

Open question 3 in `SPEC_PATH_TO_EXHAUSTIVE.md` §11 asks: "one mega-app or one fixture per BugKind?" — answer: **per-kind, coordinated**. Per-kind isolation diagnoses regressions cleanly: when `xss_dom` self-test fails, the failure points at one route, one selector, one detector. A mega-app where everything is tangled means a regression in cluster-signature derivation can mask a regression in a detector. Per-kind also means we already had 80% of the fixtures (existing sub-fixtures from V07/V12/V19/V21/V24/V08/V15) — we ship the gate by writing only the missing 20%.

---

## 5. Golden bugs.jsonl format

### 5.1 One line per expected cluster

`fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` — newline-delimited JSON. Each line:

```ts
type GoldenExpectation = {
  // The wired BugKind that MUST appear in the run's bugs.jsonl with ≥ minClusterSize cluster size.
  kind: BugKind;

  // Stable cluster signature substring. We do NOT match the full signature (which includes
  // run-specific path normalization); we assert containment for stability across runs.
  // Example: 'xss_reflected|/api/echo' (the cluster signature must START with this prefix).
  signaturePrefix: string;

  // Expected cluster count >= this number. Default 1.
  minClusterSize?: number;

  // Optional: a substring that must appear in cluster.rootCause (case-insensitive).
  // Used to disambiguate when one route triggers multiple kinds.
  rootCauseSubstring?: string;

  // Optional: which existing fixture is responsible. 'self' for the V33 fixture itself.
  fixture: 'self' | 'race-bad' | 'idor-bad' | 'v24-deferred-bugs' | 'a11y-bad' | 'seo-bad' | 'pen-bad' | 'heap-leak' | 'vision-broken-page';

  // Optional: spec source for traceability.
  specReference: string;

  // Optional flake budget. If a kind is observed to be flaky in CI, set acceptableMisses=1
  // (out of 3 reruns). DEFAULT IS 0 — flake budget is opt-in per kind, not global.
  acceptableMisses?: 0 | 1;
};
```

Example lines:

```jsonl
{"kind":"xss_reflected","signaturePrefix":"xss_reflected|/api/echo","fixture":"self","specReference":"SPEC_V07_XSS.md"}
{"kind":"console_error","signaturePrefix":"console_error|self_test_console_error","rootCauseSubstring":"SELF-TEST CONSOLE ERROR","fixture":"self","specReference":"SPEC.md"}
{"kind":"idor_horizontal","signaturePrefix":"idor_horizontal","minClusterSize":1,"fixture":"idor-bad","specReference":"SPEC_V05_SECURITY_HYGIENE.md"}
{"kind":"axe_color_contrast_strong","signaturePrefix":"axe_color_contrast_strong|/contrast","fixture":"a11y-bad","specReference":"SPEC_V06_A11Y_SEO.md"}
{"kind":"slow_lcp","signaturePrefix":"slow_lcp|/slow-lcp","fixture":"self","specReference":"SPEC_V06_PERFORMANCE.md","acceptableMisses":1}
```

### 5.2 Negative expectations (deferred kinds)

The same file optionally contains "must-NOT-appear" lines (separate type-tag for parser disambiguation):

```ts
type NegativeExpectation = {
  expect: 'absent';
  kind: BugKind;          // a deferred or dead kind
  // No signature prefix needed — any cluster of this kind in the run fails the assertion.
  reason: string;          // e.g. "Phase A backlog (csrf detector unwired)"
};
```

Example:

```jsonl
{"expect":"absent","kind":"csrf_missing_on_mutating_route","reason":"Phase A backlog (SPEC_V05_SECURITY_HYGIENE.md, registry status=deferred)"}
{"expect":"absent","kind":"hallucinated_route","reason":"Phase A backlog; planner-vs-served comparison not implemented"}
{"expect":"absent","kind":"xss_stored","reason":"placeholder kind; v0.8 deliverable, registry status=deferred"}
```

### 5.3 Rule of three: registry, manifest, golden file

Three files MUST stay in lockstep, enforced by a unit test:

- `packages/cli/src/detectors/registry.ts` — V26 source of truth (status: wired | deferred | dead)
- `fixtures/bughunter-self-deliberate-bugs/reuse-manifest.json` — coordinator's view: which fixture covers which kind
- `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` — assertion source

Test: for every `wired` kind in the registry, there MUST be:
- exactly one entry in `reuse-manifest.json.kinds`, AND
- ≥ 1 positive expectation in `golden-bugs.jsonl`.

For every `deferred` kind in the registry, there MUST be:
- a `{ "expect": "absent" }` entry in `golden-bugs.jsonl`, OR
- explicit listing under `reuse-manifest.json.deferred`.

If a future PR adds a `BugKind` to `types.ts`, V26's `_ExhaustivenessCheck` forces a registry entry, and this self-test's lockstep assertion forces a golden-bugs entry. Drift is impossible at compile + test time.

---

## 6. Acceptance check algorithm

`packages/cli/src/cli/self-test.ts` exports `selfTestCommand(opts: SelfTestOptions): Promise<void>`. Pseudocode:

```ts
type SelfTestOptions = {
  projectDir: string;            // resolves to fixtures/bughunter-self-deliberate-bugs/
  budgetMs?: number;             // default 1_800_000 (30 min)
  maxBugs?: number;              // default 400
  jsonOutput?: boolean;          // when true, prints machine-parsable result + exits
  failOnFlake?: boolean;         // default true; setting to false honors acceptableMisses
  // V32-future: seed?: number; frozenClock?: string; frozenNetworkFixturePath?: string
};

async function selfTestCommand(opts: SelfTestOptions): Promise<void> {
  // 1. Verify fixture exists
  const fixtureRoot = path.join(opts.projectDir, 'fixtures', 'bughunter-self-deliberate-bugs');
  // (If invoked via `bughunter self-test` from anywhere, locate the fixture relative to the package root.)
  assertFixturePresent(fixtureRoot);

  // 2. Load contracts
  const registry = DETECTOR_REGISTRY;
  const manifest = readManifest(fixtureRoot);
  const expectations = readGolden(fixtureRoot);
  assertLockstep(registry, manifest, expectations);  // §5.3 — fail fast on drift

  // 3. Boot sub-fixtures
  const startedPorts = await runUpScript(fixtureRoot);  // bin/up.sh
  try {
    // 4. Run BugHunter
    const startedAt = Date.now();
    await runCommand({
      projectDir: fixtureRoot,
      maxBugs: opts.maxBugs ?? 400,
      budget: opts.budgetMs ?? 1_800_000,
      a11y: true, a11yStrict: true, seoEnabled: true,
      enablePerf: true, enableBundleProbe: true, enableMemoryProfile: true,
      raceConditions: true, raceCrossTab: true,
      // pen-test palette is config-driven: .bughunter/config.json sets enabled=true
      // idor: same, set in config.json
    });
    const elapsedMs = Date.now() - startedAt;

    // 5. Read produced bugs
    const runId = readLatestRunId(fixtureRoot);
    const clusters = readBugsJsonl(fixtureRoot, runId);

    // 6. Evaluate expectations
    const result = evaluateExpectations(clusters, expectations, registry);

    // 7. Evaluate budget
    const budgetOk = elapsedMs <= (opts.budgetMs ?? 1_800_000);

    // 8. Emit result
    emitResult({ ...result, elapsedMs, budgetOk, opts });
    if (!result.allPositivesMet || !result.allNegativesMet || !budgetOk) {
      process.exitCode = 1;
    }
  } finally {
    await runDownScript(fixtureRoot);
  }
}
```

### 6.1 `evaluateExpectations` rules

For each positive expectation:
- Find clusters where `cluster.kind === expectation.kind` AND `cluster.signatureKey?.startsWith(expectation.signaturePrefix)` AND (if set) `cluster.rootCause.toLowerCase().includes(expectation.rootCauseSubstring.toLowerCase())`.
- Pass if `matchedClusters.reduce((n, c) => n + c.clusterSize, 0) >= (expectation.minClusterSize ?? 1)`.
- Otherwise: record a `MISSED` line with kind, expected prefix, observed kinds at that prefix.
- If `failOnFlake === false` and `acceptableMisses === 1`, allow up to 1 MISSED across the whole golden file.

For each negative expectation:
- Find clusters where `cluster.kind === expectation.kind`. Pass if 0; fail (record `FALSE_POSITIVE` line) otherwise.

For each wired kind in registry that has NO positive expectation: lockstep test (§5.3) already failed earlier — this branch is unreachable but `evaluateExpectations` still records it for diagnostic completeness.

### 6.2 Result shape

```ts
type SelfTestResult = {
  passed: boolean;
  elapsedMs: number;
  budgetMs: number;
  budgetOk: boolean;
  positives: Array<{ kind: BugKind; expected: number; matched: number; status: 'PASS' | 'MISS' | 'FLAKED' }>;
  negatives: Array<{ kind: BugKind; observed: number; status: 'PASS' | 'FALSE_POSITIVE' }>;
  unexpectedKinds: BugKind[];      // wired clusters of kinds not in golden — informational, not gating
};
```

JSON output is the result shape verbatim. Human output is a table with per-kind PASS/MISS/FALSE_POSITIVE/FLAKED, total elapsedMs vs budget, and a one-line summary.

---

## 7. CLI

### 7.1 Subcommand registration

```
bughunter self-test [options]

Options:
  --budget <ms>           Wallclock budget (default 1800000 = 30 min)
  --max-bugs <n>          Stop-and-emit threshold (default 400)
  --json                  Emit machine-parsable result to stdout instead of human table
  --no-fail-on-flake      Honor acceptableMisses in golden-bugs.jsonl
  --keep-run              Don't prune run dir on success (debug aid)
  --skip-fixture-up       Assume fixture ports already up (CI optimization)
```

### 7.2 Exit codes

- `0` — all positive expectations matched, all negative expectations held, wallclock within budget.
- `1` — at least one MISS, FALSE_POSITIVE, or budget violation.
- `2` — fixture or registry drift (lockstep test failed, fixture not present, etc.) — distinguishable from `1` by the operator.
- `>2` — reserved for future.

### 7.3 USAGE update

Add to `packages/cli/src/cli/main.ts` USAGE constant:

```
  bughunter self-test [--budget <ms>] [--max-bugs <n>] [--json] [--no-fail-on-flake] [--keep-run]
```

Group under "Diagnostics" alongside V26's `doctor` / `detectors` / `scope` / `inputs` / `config`.

---

## 8. Edge cases

### EC-1. Deferred kind quietly becomes wired

A future PR wires `csrf_missing_on_mutating_route` and adds positive coverage. **Until** the PR also flips the registry status to `wired` and adds a positive expectation, the next self-test run produces a `FALSE_POSITIVE` on `csrf_missing_on_mutating_route` (kind we said wouldn't fire is firing).

**Resolution:** the PR author MUST update three files in lockstep — registry, manifest, golden-bugs. The lockstep test (§5.3) catches partial updates *before* the run.

### EC-2. Wired kind silently breaks (regression)

A refactor changes `clusterSignature` for `xss_reflected` such that `signaturePrefix` no longer matches. Self-test reports `MISS`. Operator looks at the `unexpectedKinds` field — if `xss_reflected` shows up there with a different prefix, the regression is in the signature derivation; if it's absent entirely, the regression is in the detector. Different fix paths, both surfaced.

### EC-3. Flaky kind (vitals, vision)

Web-vital detectors depend on browser timing; vision depends on LLM availability. Per-kind `acceptableMisses: 1` lets these tolerate one CI flake without masking a real regression across multiple runs. Default flake budget is **0** — flake tolerance is opt-in per kind.

### EC-4. Sub-fixture port already in use

`bin/up.sh` checks `lsof -iTCP:<port>` before starting. If occupied, fails fast with exit code 2 and a clear message. The `--skip-fixture-up` flag bypasses this for CI environments that pre-stage fixtures via Docker.

### EC-5. Performance creep below regression threshold

A new detector adds 30s to a 25min run — within budget, no failure. To catch this slow drift, the run's `elapsedMs` is **also** appended to `fixtures/bughunter-self-deliberate-bugs/.bughunter/perf-history.jsonl` (one line per CI run, capped at 100 entries). A separate optional check `--perf-regression-pct <n>` (default off) fails if elapsedMs exceeds median(last-30) * (1 + n/100).

### EC-6. Fixture has bugs the registry doesn't know about

If a sub-fixture exhibits a kind not in any golden expectation (e.g., a future v24 maintainer accidentally adds a memory leak to a non-leak page), it shows up under `unexpectedKinds`. Informational only — we do NOT fail on this, because random unrelated detections (e.g. an a11y issue in race-bad's submit button) are fine. Operators inspect the field manually if curious.

### EC-7. Golden file out-of-sync with sub-fixture refactor

A future PR refactors `idor-bad` and renames a route. `signaturePrefix` no longer matches. Self-test reports MISS, the unexpectedKinds field shows `idor_horizontal|/api/orders/:id_NEW_NAME`. Operator updates `golden-bugs.jsonl`. This is correct behavior — we want fixture-route changes to break the gate.

### EC-8. Registry has a wired kind with NO sub-fixture coverage

The lockstep test fails before the run. Either (a) fixture maintainer adds coverage, or (b) registry maintainer downgrades the kind to deferred with a note. Both are spec-traceable changes.

### EC-9. SurfaceMCP unavailable / network sandboxed

`bin/up.sh` will fail to start sub-fixtures. Self-test exits 2 with a clear "fixture-up failed; SurfaceMCP/Vite/Node ports not bindable" message. We do NOT silently skip — silent skip is the worst possible outcome for a regression gate.

### EC-10. Run produces a `BugKind` not in the registry

Impossible at compile time — V26's `_ExhaustivenessCheck` rejects new kinds without registry updates. If somehow encountered at runtime (e.g. JSONL ingested from older run), self-test logs a warning and ignores the cluster.

### EC-11. Two wired kinds collide on the same route (signature dedup)

Some routes legitimately exhibit multiple kinds (e.g. an XSS-reflected response that is ALSO a 500). Cluster collapsing rules in `cluster/signature.ts` make this deterministic. Each expectation is independent; both can pass on the same route.

### EC-12. `bughunter self-test` invoked from outside the BugHunter repo

The fixture lives inside the repo at `fixtures/bughunter-self-deliberate-bugs/`. The command resolves the fixture path relative to the BugHunter package install location (npm root or git checkout), not `process.cwd()`. If installed globally via npm, the command refuses with a clear "self-test must be run from a BugHunter repo checkout" message — this is a contributor tool, not an end-user tool.

### EC-13. CI environment lacks vision MCP

`visual_anomaly` is the only kind that depends on vision. Setting `--no-vision` in the fixture's `.bughunter/config.json` excludes that kind; the matching golden expectation has `acceptableMisses: 1` AND the `--no-fail-on-flake` flag is set in the CI invocation. When vision is available locally, the assertion is enforced strictly.

### EC-14. Self-test discovers a real bug in BugHunter itself

The whole point. Ship the failure as the next priority work item.

---

## 9. Acceptance criteria

| Criterion | Verifier |
|---|---|
| `bughunter self-test` runs to completion against the fixture, exits 0 | `bughunter self-test --budget 1800000` |
| Every wired kind in `DETECTOR_REGISTRY` has ≥1 positive expectation in `golden-bugs.jsonl` | unit test `registry.lockstep.test.ts` |
| Every deferred kind has a corresponding `expect: 'absent'` line | unit test `registry.lockstep.test.ts` |
| `reuse-manifest.json` covers every wired kind | unit test `registry.lockstep.test.ts` |
| New `self-test` subcommand visible in `bughunter --help` USAGE block | smoke test |
| Existing CLI commands unchanged | regression run of all other commands |
| `tsc --noEmit` clean | `tsc` |
| `eslint . --max-warnings 0` clean | `eslint` |
| Vitest integration test `tests/integration/self-test.smoke.test.ts` passes | `npx vitest run tests/integration/self-test.smoke.test.ts` |
| `bughunter self-test --json` output validates against `SelfTestResult` Zod schema | the integration test |
| Fixture ports don't collide with other repo-internal fixtures | `bin/up.sh` lsof check + manual inspection of port table |
| Wallclock at green-path: ≤ 30 min on a 4-vCPU CI runner | CI history |
| If the registry adds a wired kind without golden coverage, the lockstep test fails immediately | adversarial PR run |
| If a detector silently breaks (e.g. `xss_reflected` no longer fires), self-test fails with a `MISS` row pointing to the broken kind | adversarial PR run |

---

## 10. Files to touch

### 10.1 New files

| Path | Reason |
|---|---|
| `packages/cli/src/cli/self-test.ts` | The command implementation per §6 |
| `packages/cli/src/cli/self-test.test.ts` | Unit tests for `evaluateExpectations` (no fixture boot) |
| `packages/cli/src/detectors/registry.lockstep.test.ts` | §5.3 lockstep enforcement |
| `tests/integration/self-test.smoke.test.ts` | End-to-end smoke (boots fixture, runs command) |
| `fixtures/bughunter-self-deliberate-bugs/README.md` | "what this is, do NOT deploy" |
| `fixtures/bughunter-self-deliberate-bugs/package.json` | New SPA + API deps |
| `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl` | §5 |
| `fixtures/bughunter-self-deliberate-bugs/reuse-manifest.json` | §4.2 |
| `fixtures/bughunter-self-deliberate-bugs/.bughunter/config.json` | Pre-baked BugHunter project config |
| `fixtures/bughunter-self-deliberate-bugs/surfacemcp.config.json` | SurfaceMCP composite config |
| `fixtures/bughunter-self-deliberate-bugs/bin/up.sh` | Boot all sub-fixtures |
| `fixtures/bughunter-self-deliberate-bugs/bin/down.sh` | Graceful teardown |
| `fixtures/bughunter-self-deliberate-bugs/api/server.js` | Minimal Node API for self-covered kinds |
| `fixtures/bughunter-self-deliberate-bugs/web/index.html` | SPA entry |
| `fixtures/bughunter-self-deliberate-bugs/web/vite.config.ts` | Vite config |
| `fixtures/bughunter-self-deliberate-bugs/web/src/main.tsx` | SPA bootstrap |
| `fixtures/bughunter-self-deliberate-bugs/web/src/App.tsx` | Router |
| `fixtures/bughunter-self-deliberate-bugs/web/src/pages/*.tsx` | One page per `"fixture": "self"` kind in §4.2 |
| `fixtures/bughunter-self-deliberate-bugs/web/src/leaked.ts` | Hardcoded credential static-analysis target |
| `fixtures/bughunter-self-deliberate-bugs/web/src/swallow.ts` | Empty-catch static-analysis target |

### 10.2 Files to modify

| Path | Change |
|---|---|
| `packages/cli/src/cli/main.ts` | Register `self-test` subcommand; add to USAGE |
| `package.json` (repo root) | Add `"test:self-test": "node packages/cli/dist/cli/main.js self-test"` script for convenience (optional but documented) |

### 10.3 Files NOT to touch

- `packages/cli/src/cli/run.ts` — `self-test.ts` calls `runCommand` as a black box; do NOT modify run-loop internals.
- `packages/cli/src/cluster/signature.ts` — golden expectations match against existing signatures; if signature shape needs to change, that's a separate breaking-change spec.
- Any of the existing fixture sources (`race-bad`, `idor-bad`, `v24-deferred-bugs`, `a11y-bad`, etc.) — coordinator runs them as-is. Touching them is out of scope; see EC-7.
- `packages/cli/src/types.ts` `BugKind` union — V33 adds NO new kinds.
- `packages/cli/src/detectors/registry.ts` — V33 does NOT change registry contents; the lockstep test reads the registry as a constant.

---

## 11. Negative requirements

- Do **not** create any new BugKind. V33 is a regression gate, not a detector spec.
- Do **not** modify `clusterSignature`. The `signaturePrefix` matching in golden expectations is intentionally tolerant (prefix, not equality) so signature derivation can evolve without breaking the gate, but the gate must NEVER drive signature changes.
- Do **not** add runtime dependencies. Fixture uses Vite + React + plain Node, all already in repo.
- Do **not** silently skip checks under any environmental condition (sandbox, CI flake, missing vision). Skips MUST be explicit (`--no-fail-on-flake`, `--skip-fixture-up`) and logged.
- Do **not** make `self-test` part of the default `npm test` invocation. It boots ports, takes minutes, and requires camofox + SurfaceMCP. Run it explicitly in CI behind a separate workflow stage.
- Do **not** copy code from existing sub-fixtures into the coordinator. Reference, don't fork.
- Do **not** introduce per-test cluster.id matching. The matcher uses kind + signature prefix (stable across runs) — `cluster.id` is run-local UUID and MUST NOT appear in golden expectations.
- Do **not** wire static-analysis files (vulnerable_dependency / hardcoded_credentials / swallowed_error) inside `web/src/` if Vite would tree-shake them away. Place at fixture root or in a path the static analyzers explicitly walk; verify by reading static-analysis run paths.
- No `as any`. No `// @ts-ignore`. The lockstep test uses real `BugKind` literal types — drift fails compile, not just runtime.

---

## 12. Task breakdown

Each task is independently completable and individually testable. Assign per the @assignee tag. **Tasks 1-4 are blocking; tasks 5-8 can parallelize once fixture skeleton exists.**

### Task 1 — Coordinator skeleton + manifest
**Assignee:** @coder · **Depends on:** none
**Files:** `fixtures/bughunter-self-deliberate-bugs/{README.md,package.json,reuse-manifest.json,.bughunter/config.json,surfacemcp.config.json}`, `fixtures/bughunter-self-deliberate-bugs/bin/{up.sh,down.sh}`
**Test:** `bash fixtures/bughunter-self-deliberate-bugs/bin/up.sh` boots all referenced sub-fixture ports without collision; `down.sh` cleans up.
**Done when:** every port from `reuse-manifest.json.kinds` resolves to a live HTTP endpoint after `up.sh`; `down.sh` leaves no stray processes.
**DO NOT:** copy sub-fixture code; only orchestrate.

### Task 2 — Lockstep test
**Assignee:** @coder · **Depends on:** Task 1
**Files:** `packages/cli/src/detectors/registry.lockstep.test.ts`
**Test:** `npx vitest run packages/cli/src/detectors/registry.lockstep.test.ts`
**Done when:** test reads registry, manifest, and golden-bugs (allowing empty golden initially); enumerates wired kinds without manifest entry → fail; deferred kinds without `expect: 'absent'` → fail.
**DO NOT:** import non-test runtime code from `self-test.ts`; lockstep is a static contract check.

### Task 3 — `bughunter self-test` command implementation
**Assignee:** @coder · **Depends on:** Task 2
**Files:** `packages/cli/src/cli/self-test.ts`, `packages/cli/src/cli/self-test.test.ts`, `packages/cli/src/cli/main.ts` (registration + USAGE)
**Test:** `npx vitest run packages/cli/src/cli/self-test.test.ts` covers `evaluateExpectations` for: PASS, MISS, FLAKED, FALSE_POSITIVE, unexpectedKinds, budget violation. No fixture boot in unit test.
**Done when:** `bughunter self-test --help` shows usage block; `bughunter self-test` runs `runCommand` against fixture and emits result.
**DO NOT:** modify `run.ts` internals; treat `runCommand` as a callable black box.

### Task 4 — `golden-bugs.jsonl` for sub-fixtures already covered
**Assignee:** @coder · **Depends on:** Task 1, Task 2
**Files:** `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl`
**Test:** lockstep test passes for the kinds covered by `race-bad`, `idor-bad`, `v24-deferred-bugs`, `a11y-bad`, `seo-bad`, `pen-bad`, `heap-leak`, `vision-broken-page`. New `self`-fixture lines added incrementally in tasks 5-7.
**Done when:** every entry in `reuse-manifest.json` whose `fixture !== 'self'` has at least one positive expectation; every deferred kind from registry has an `expect: 'absent'` line.
**DO NOT:** include non-existent signature prefixes; verify each prefix by running BugHunter against the sub-fixture and inspecting `cluster.signatureKey`.

### Task 5 — New SPA pages (Tier-1 kinds)
**Assignee:** @coder · **Depends on:** Task 1
**Files:** `fixtures/bughunter-self-deliberate-bugs/web/{index.html,vite.config.ts,src/main.tsx,src/App.tsx,src/pages/{ConsoleError,ReactError,Unhandled,MissingStateChange,ClickAccessibleName,XssDom,Cls,Rerender,LongTask,SlowInp,SlowLcp,NPlusOne,Dedup}.tsx}`
**Test:** `npm run dev --prefix fixtures/bughunter-self-deliberate-bugs/web` starts; each route returns HTML; manual inspection confirms each page exhibits its bug.
**Done when:** SPA boots on port 5790; each page in §4.3 renders and exhibits the deliberate bug.
**DO NOT:** add routes not in `reuse-manifest.json`; do NOT add an error boundary that suppresses `react_error`.

### Task 6 — New API server + static-analysis files
**Assignee:** @coder · **Depends on:** Task 1
**Files:** `fixtures/bughunter-self-deliberate-bugs/api/server.js`, `fixtures/bughunter-self-deliberate-bugs/web/src/{leaked.ts,swallow.ts}`, `fixtures/bughunter-self-deliberate-bugs/package.json` (vulnerable dep pin)
**Test:** API server boots on port 5791; each endpoint responds with the expected vulnerability shape; `npm audit` against fixture's package.json reports the pinned vulnerability; gitleaks scan flags the hardcoded credential.
**Done when:** all `"fixture":"self"` kinds with `port: 5791` or `port: null` have a verifiable trigger.
**DO NOT:** put real credentials in the leaked.ts file — use canonical AWS test pattern (`AKIAIOSFODNN7EXAMPLE`).

### Task 7 — Add `self`-fixture lines to `golden-bugs.jsonl`
**Assignee:** @coder · **Depends on:** Tasks 4, 5, 6
**Files:** `fixtures/bughunter-self-deliberate-bugs/golden-bugs.jsonl`
**Test:** `bughunter self-test` against the now-fully-built fixture exits 0.
**Done when:** every wired kind has a passing positive expectation; every deferred kind has a passing negative expectation.
**DO NOT:** loosen `signaturePrefix` to make a flaky test pass — file an EC-3 follow-up adding `acceptableMisses: 1` for legitimately flaky kinds.

### Task 8 — Integration smoke test
**Assignee:** @qa · **Depends on:** Task 7
**Files:** `tests/integration/self-test.smoke.test.ts`
**Test:** `npx vitest run tests/integration/self-test.smoke.test.ts`
**Done when:** test invokes `selfTestCommand({ projectDir, jsonOutput: true })` end-to-end; asserts `result.passed === true`; tags as `@slow` so it's opt-in (not part of default `vitest run`).
**DO NOT:** mock the run; this is the gate that catches every regression the unit tests miss.

---

## 13. Definition of Done

- [ ] `bughunter self-test` exits 0 against current `main` (snapshot baseline).
- [ ] All 8 tasks above complete; PRs landed in dependency order.
- [ ] CI runs `bughunter self-test` on every PR that touches `packages/cli/src/{classify,security,phases,detectors,cluster}/**` (path-filtered workflow).
- [ ] `SPEC_PATH_TO_EXHAUSTIVE.md` §6.2 marked `[x] V33 shipped`.
- [ ] `DETECTOR_REGISTRY` lockstep test enforces drift on every PR (path filter not needed — applies to every test run).
- [ ] README of root repo gets a one-paragraph "Self-test" section pointing at this spec and `bughunter self-test --help`.
- [ ] No new top-level `node_modules` for the fixture: it inherits from the repo's npm workspace OR ships a tiny dedicated `package.json` whose `npm install` is part of `bin/up.sh`.
- [ ] Wallclock baseline recorded in `fixtures/bughunter-self-deliberate-bugs/.bughunter/perf-history.jsonl`.
- [ ] Manual smoke: deliberate one-line break in `packages/cli/src/classify/console.ts` (set kind to `'console_warning'` typo) — self-test fails with a MISS row pointing at console_error. Revert the break.

---

## 14. Open questions

1. **Should `self-test` be part of `npm test`?** Spec says no (boots ports, slow). But a guarded `npm run self-test` in `package.json` is reasonable. Decide before Task 8 lands.

2. **Should `acceptableMisses` be 0 or 1 for vision/vital kinds?** Vital detectors are timing-dependent; vision depends on LLM availability. Lean: 1 for `slow_lcp`, `slow_inp`, `high_cls`, `visual_anomaly`; 0 for everything else. Revisit after first month of CI data.

3. **Should `bin/up.sh` use Docker?** Each sub-fixture runs natively today (Node + Vite). Docker would isolate but add ~30s boot time. Lean: native for now; reconsider if cross-OS port pinning becomes painful.

4. **Where do static-analysis fixture files (vulnerable dep, leaked.ts, swallow.ts) live?** §4.3 places them under fixture root + `web/src/`. Static analyzers walk the project root by default. Verify by reading `packages/cli/src/static/tools/{npm-audit,gitleaks,eslint-no-empty}.ts` and confirm paths are walked. If not, adjust.

5. **Should the self-test also assert `summary.json.skippedReasons` is empty?** Currently no — skipped reasons are valid (third-party, forbidden-path). Adding the assertion would catch unintended skips but may flake on PRs that legitimately add skip cases. Lean: defer to V35; add when triage logic stabilizes.

6. **Should `unexpectedKinds` be gating?** Currently informational (§6.2). If a regression introduces `console_error` on the `/no-state-change` route, the unexpectedKinds field shows it but the test passes because `missing_state_change` still fires. Argument for gating: silent kind-leakage is a bug. Argument against: flaky external observations (a sub-fixture's transitive dep emits a console.warn) would fail the gate. Lean: stay informational; add `--strict-unexpected` flag in V35 for tightening once we have run history.

7. **Should the budget be per-kind or total?** Currently total wallclock. Per-kind would diagnose which detector slowed down. But per-kind requires re-running each kind in isolation (~60x slower) or instrumenting BugHunter's internal phase timers (cross-cutting change). Lean: total + run-level phase breakdown via existing `summary.json.phaseDurations`; per-kind via V35 if needed.

8. **Should `golden-bugs.jsonl` be auto-generated from a green run?** Argues against drift-by-typo (good). But auto-generating from any run lets a regression that introduces new false-positives "rebase" the golden file invisibly. Lean: golden file is hand-curated; a `--update-golden` flag exists ONLY in dev, never in CI, and writes a diff for review.

9. **What happens when V32 deterministic mode lands?** V33 will start passing `--seed`, `--frozen-clock`, and `--frozen-network` to the inner `runCommand`. Until then, the self-test tolerates non-determinism via `acceptableMisses`. Once V32 ships, the goal is `acceptableMisses: 0` everywhere — V32+V33 together produce byte-identical bugs.jsonl.

10. **Should the fixture be its own published npm package?** Forces a clean dependency boundary but adds publish overhead. Lean: stays in-tree under `fixtures/`; treat as repo-internal.

---

*End of SPEC v0.33.*
