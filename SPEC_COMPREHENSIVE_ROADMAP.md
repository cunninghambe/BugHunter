# BugHunter — Comprehensive Bug Detection Roadmap (v0.5 → v1.0)

**Status:** Strategic spec, draft 1 · **Author:** @architect (Opus, ultrathink) · **Date:** 2026-04-27 · **Audience:** the user (drives prioritization), future @architect specs (one per phase), future @coder/@designer implementing per spec.

This is the master roadmap. It is **not** an implementation spec. Each phase below produces one or more focused specs of the kind already shipping in this repo (`SPEC_VISION_DETECTION.md`, `SPEC_CRAWLER.md`, `SPEC_BROWSER_LOGIN.md`). The taxonomy is the source of truth for "what counts as a bug we want to detect"; the phased plan is the source of truth for "what we build next."

Nothing in this document blocks current work. v0.4 (vision) ships first. The rest queues behind it.

---

## 1. Vision

> The most comprehensive bug-detection scanner for web applications on the planet, with no use case too subtle.

That is the user's directive, verbatim. This roadmap takes it literally. The taxonomy in §3 catalogs every bug class we can think of — functional, performance, accessibility, security, data integrity, internationalization, SEO, privacy, observability, code quality, browser-specific, network resilience, state persistence, workflow/UX, and the LLM-era class that arose from vibe-coded apps. Each class is triaged honestly: detection technique, signal-to-noise, effort, and priority bucket.

The roadmap groups detection capabilities into **shippable phases (v0.5 → v1.0)**, each with a coherent theme, one or more new `BugKind`s, the infrastructure required, an effort estimate, and a killer demo target. Every phase is independently valuable — a user adopting BugHunter at v0.6 gets the full v0.5 + v0.6 detection set, not a half-built abstraction tower.

The honest framing: today (v0.4) we cover ~20-30% of detectable bug classes. By v1.0 we plan to cover ~70-80% — the long tail (novel attack chains, business-logic-specific behaviors) genuinely belongs to other tools or to humans, and we say so explicitly in §7 (Anti-goals). "No use case too subtle" means we **catalog** every use case; it does not mean we ship a low-precision detector for every use case. Precision matters; a noisy detector is worse than a missing one.

---

## 2. Current State Inventory (v0.4 baseline)

### 2.1 What v0.4 detects

The `BugKind` union in `packages/cli/src/types.ts:23-34`:

| Kind | Source | Coverage | False-positive profile |
|---|---|---|---|
| `console_error` | DevTools console (browser MCP) | JS errors that reach the console | Low; React noise stripped |
| `react_error` | DevTools console + heuristic strings | "Cannot update during render", hydration mismatches | Low |
| `unhandled_exception` | `window.onerror` | Top-level uncaught throws | Very low |
| `network_5xx` | Network observation per-action | All 5xx responses | Very low |
| `network_4xx_unexpected` | Network + `expectedOutcome` | 4xx where success was expected | Medium; `expectedOutcome` calibration matters |
| `404_for_linked_route` | Crawler + page-link cross-ref | Anchor tags pointing at 404s | Low |
| `surface_call_failed` | SurfaceMCP probe | API rejected a happy-palette mutating call | Very low |
| `dom_error_text` | Post-state regex on visible text | "Something went wrong" / "Error 500" | Medium; per-app calibration helps |
| `missing_state_change` | MutationObserver after action | Click that should have mutated didn't | Medium-high; needs better intent detection |
| `accessibility_critical` | axe-core delta vs pre-state, `--a11y` flag | axe-core "critical" / "serious" violations | Low (axe-core is well-calibrated) |
| `visual_anomaly` | Claude-vision over post-action screenshot | Layout, content, state, and error visuals | Medium; severity gating + dedup carry the precision |

### 2.2 Coverage gaps (what v0.4 misses, by construction)

These become §3's taxonomy targets:

1. **Performance** — Web Vitals (LCP/INP/CLS), bundle size, memory leaks, N+1 calls, render thrashing. We capture timing per request but do not classify on it.
2. **Security** — IDOR, CSRF presence, auth bypass, open redirect, header hygiene, dependency CVEs. Zero coverage today.
3. **Code-level static analysis** — hardcoded credentials, swallowed errors, debug logs left in, dead code, hardcoded English. Zero coverage today.
4. **Data integrity** — duplicate records, orphans, money-math precision, lost updates. Out of scope for "click-and-observe"; needs DB inspection or invariant probing.
5. **Internationalization** — RTL layout, UTF-8 handling, hardcoded strings, date format ambiguity. Zero coverage.
6. **SEO/metadata** — `<title>`/meta/OG/canonical/robots/sitemap. Zero coverage; cheap to add.
7. **Privacy/compliance** — cookie consent, tracking disclosures, data-export endpoint presence. Zero coverage.
8. **Cross-browser** — Chrome only via camofox; Firefox/Safari unmapped.
9. **Multi-viewport** — desktop only; mobile-specific bugs (touch targets, 100vh, hover affordances) unmapped.
10. **Authenticated cross-user (IDOR)** — we have role context but never probe role A's resources as role B.
11. **Network resilience** — timeouts, retry, rate-limit, token refresh. Not exercised; we do not slow down the network or inject failures.
12. **State persistence** — localStorage quota, reload survival, stale-session behavior. Not exercised.
13. **Workflow/UX** — multi-step form back-button, destructive-action confirmation, generic error copy. Partly visible to vision; not detected explicitly.
14. **LLM-era** — phantom imports, hallucinated routes, schema drift, inconsistent error patterns within one codebase. Adjacent to v0.4 (`surface_call_failed` catches some), but no systematic detector.

### 2.3 Existing infrastructure assets

What is already built that we will lean on heavily:

- **Phase pipeline** (`validate → discover → plan → execute → classify → cluster → emit`). Stable. New detectors plug into `classify`.
- **Cluster signature normalization** (`packages/cli/src/cluster/`). Stable across kinds; only requires per-kind branches.
- **Action log + replay** (`packages/cli/src/repro/`). Reproducibility primitive — every new detector should produce a replayable action.
- **Same-shape collapsing**. Keeps the test matrix tractable.
- **SurfaceMCP integration**. The API catalog is a goldmine for IDOR, auth-bypass, and rate-limit probing.
- **Browser MCP (camofox)**. CDP-adjacent (Chromium underneath); we can extend it for Web Vitals and HAR if camofox-mcp gains the surface, or run a parallel real-CDP path.
- **JSONL artifact format**. Stable; new detection kinds add fields under namespaced prefixes (e.g. `perf*`, `security*`).
- **Vision pipeline** (v0.4). Generalizable to other LLM-of-output passes (LLM-of-source, LLM-of-response).

### 2.4 Existing infrastructure stubs / gaps

- **HAR capture** — stub at `packages/cli/src/phases/execute.ts:190` ("real network capture deferred to camofox-mcp v0.2"). Empty HAR is written. Real HAR is a v0.5 prerequisite.
- **CDP integration** — none. We use camofox MCP's high-level surface; raw CDP for performance/coverage/heap is a v0.6 prerequisite.
- **Static-analysis pipeline** — none. v0.7 builds it.
- **Multi-viewport** — none. Tests run at the camofox default. v0.8 adds viewport matrices.
- **Multi-browser** — Chromium only. v0.9 considers Firefox + WebKit.
- **Authenticated cross-user matrix** — roles exist but BugHunter runs each role in isolation; cross-role probing (role A's session viewing role B's resources) is the IDOR primitive. v0.5 adds it.

---

## 3. Master Taxonomy

### 3.1 Reading guide

For each class:

| Column | Meaning |
|---|---|
| Class | Stable identifier; becomes a `BugKind` if "Native". |
| Detection technique | HTTP probe / browser runtime / static-analysis / vision / LLM-of-source / LLM-of-response / network observation / cross-reference / synthetic interaction / external tool. |
| Stack-dep | Universal / framework-specific (Next.js, Express, Vite, Prisma…). |
| S/N | Signal-to-noise on a vibe-coded SaaS. **High** = false-positive rate <10%. **Medium** = 10-30%. **Low** = >30% without per-app calibration. |
| Effort | S (<1 day) / M (1-3 days) / L (1-2 weeks) / XL (>2 weeks). |
| Cost | $ (negligible CPU only) / $$ (LLM-bounded, <$1/run) / $$$ (LLM-heavy, multi-$ runs). |
| Existing tools | Wrap (use external as-is, ingest output) / Hybrid (external surfaces candidates, BugHunter classifies/clusters/dedupes) / Native (BugHunter own classifier, no external dep) / N/A. |
| Priority | P0 must-have / P1 high-value / P2 nice / P3 deferred. |
| Phase | Targeted release. |

Priority calibration rule (§5 expands): **P0 = high S/N + low cost + clear value**. P1 = high S/N but expensive, OR medium S/N with calibration knobs. P3 = low S/N, business-rule dependent, or covered better elsewhere.

---

### 3.2 Functional / behavioral

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `stale_data_after_mutation` | Synthetic: mutation-action then re-fetch list view; compare DOM/network. | Universal | Med | M | $ | None matching | P1 | v0.6 |
| `optimistic_update_divergence` | Browser runtime + network: action shows success in UI but underlying mutation API returned non-2xx. | Universal | High | M | $ | None | P0 | v0.5 |
| `race_double_submit` | Synthetic: rapid double-click → check for duplicate POST request or duplicate row. | Universal | High | S | $ | Native | P0 | v0.5 |
| `loading_state_stuck` | Browser runtime: spinner present > N seconds without DOM mutation completion. (Adjacent to vision.) | Universal | Med | S | $ | Native (heuristic) | P1 | v0.6 |
| `pagination_off_by_one` | Synthetic: navigate page1→page2; check that visible item set actually differs. | Universal | High | M | $ | Native | P1 | v0.6 |
| `sort_filter_state_corruption` | Synthetic: apply filter, sort, paginate, reverse; assert state survives or returns clean. | Universal | Low (per-app calibration) | L | $ | Native | P3 | v0.9 |
| `search_edge_cases` | Synthetic: empty / unicode / overlong / SQL-quoted / regex-meta inputs to search; observe 500s, blank results, console errors. | Universal | Med | M | $ | Native (extends mutation palette) | P1 | v0.5 |
| `autosave_vs_manual_conflict` | Synthetic: type, wait for autosave, click save; observe API conflict / lost data. | App-dep | Low | L | $ | Native | P3 | defer |
| `offline_behavior` | Synthetic: action under simulated offline (CDP `Network.emulateNetworkConditions`); observe error UX vs silent failure. | Universal | Med | M | $ | Native (CDP-based) | P2 | v0.7 |
| `timezone_handling` | LLM-of-response + heuristic: dates rendered in API response vs UI; assert UTC/local consistency. | App-dep | Low | L | $$ | Hybrid | P3 | v0.9 |
| `decimal_precision` | LLM-of-response: numeric fields with >2 decimal-place rendering on a "money" surface; static-analysis: float arithmetic on price-typed fields. | App-dep (Prisma/SurfaceMCP gives type hints) | Med | M | $$ | Hybrid (LLM-flagged → BugHunter clusters) | P1 | v0.7 |
| `currency_formatting_inconsistency` | LLM-of-output: per-page sweep of money-shaped strings; flag mixing `$1,234.50` and `1234.5`. | App-dep | Med | S | $$ | Native (LLM pass) | P2 | v0.8 |

**Phase-anchor rationale:** v0.5 is "bugs we already almost catch" — `optimistic_update_divergence` is a 1-line addition once we cross-reference the success-toast (vision) with the network request status. `race_double_submit` is the cheapest valuable addition to the mutation palette. `search_edge_cases` extends the existing palette to `<input type=search>` and search forms.

---

### 3.3 Performance (Web Vitals + budgets)

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `slow_lcp` | CDP `Performance.metrics` + `web-vitals` package injection. | Universal | High | M | $ | Wrap (Lighthouse/web-vitals) | P0 | v0.6 |
| `slow_inp` | `web-vitals` runtime measurement during action execution. | Universal | High | M | $ | Wrap | P0 | v0.6 |
| `slow_cls` | `web-vitals`; observe layout-shift events during page life. | Universal | Med (acceptable shifts during transitions are common) | M | $ | Wrap | P1 | v0.6 |
| `memory_leak` | CDP heap snapshots before/after N action repetitions; flag monotonic growth. | Universal | Med | L | $ | Hybrid (CDP raw) | P2 | v0.8 |
| `unbounded_list_render` | Static-analysis: `.map(...)` over a paginated/infinite source without virtualization library import; OR runtime: DOM node count > 5000 on a list page. | React/Vue/Svelte | Med | M | $ | Native | P2 | v0.7 |
| `n_plus_one_api_calls` | HAR analysis post-action: same endpoint family hit >N times within action window. | Universal | High (when N>=10) | M | $ | Native (HAR-based) | P0 | v0.6 |
| `no_request_dedup` | HAR: identical concurrent requests during one action window. | Universal | High | S | $ | Native | P1 | v0.6 |
| `no_request_cancel_on_nav` | HAR + URL events: requests in flight after navigation away, completing into nothing. | Universal | Med | M | $ | Native | P2 | v0.7 |
| `main_thread_blocking` | CDP `Performance` long-tasks > 50ms during action. | Universal | Med | M | $ | Wrap (Lighthouse) | P1 | v0.7 |
| `bundle_size_exceeded` | Static: gzipped JS bundle size on initial load vs configurable threshold; default 500KB JS, 200KB CSS. | Build-tool dep (reads `dist/`/`.next/static/`) | High | S | $ | Wrap (`size-limit`, `webpack-bundle-analyzer`) | P0 | v0.6 |
| `excessive_rerender` | React DevTools Profiler API via injected hook; flag components rendering >10x per action. | React-only | Low (very noisy) | L | $ | Hybrid | P3 | v0.9 |
| `cache_miss_no_strategy` | HAR: GET responses without `Cache-Control` / `ETag` on idempotent routes. | Universal | Low (false-positive heavy) | M | $ | Hybrid | P3 | defer |
| `hydration_mismatch` | Console-error pattern (already in v0.4 `react_error`); promote to dedicated kind with diagnosis. | Next.js / Remix / Nuxt | High | S | $ | Native (extends `react_error`) | P0 | v0.5 |

**Anchor rationale:** Web Vitals (LCP/INP/CLS) is solved-problem territory; `web-vitals` is 7KB and battle-tested. We **wrap**, we don't reimplement. Bundle size is the cheapest performance win — read the build output, compare to threshold, done. N+1 detection is high-signal but requires real HAR (v0.5 prerequisite) before it can ship.

---

### 3.4 Accessibility (beyond axe-core)

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `axe_critical` (existing) | axe-core delta. | Universal | High | — | $ | Wrap (already shipped) | — | shipped |
| `color_contrast_failure` | axe-core handles structural; vision cross-check for layered/translucent cases axe misses. | Universal | High (axe) / Med (vision) | M | $$ | Hybrid | P1 | v0.6 |
| `keyboard_trap` | Synthetic: tab through page; if focus ring loops without escape after N tabs, flag. | Universal | High | M | $ | Wrap (Pa11y-CI has primitives) | P1 | v0.6 |
| `focus_management_modal` | Synthetic: open modal; assert focus moves into modal; close modal; assert focus returns to trigger. | Universal | High | M | $ | Native | P1 | v0.6 |
| `live_region_missing` | DOM: dynamic content updates without `aria-live`/`role=status`/`role=alert` on or above the changed region. | Universal | Med | L | $ | Native (heuristic) | P2 | v0.7 |
| `aria_misuse` | axe-core covers most; supplement with static-analysis: `aria-label` on `<div>` with no role. | Universal | High | S | $ | Wrap | P1 | v0.7 |
| `dynamic_content_not_announced` | Like `live_region_missing`; specific to toasts/notifications. | Universal | Med | M | $ | Native | P2 | v0.7 |
| `touch_target_too_small` | Multi-viewport: at mobile viewport, interactive elements with bounding box <44px. | Universal | High | M | $ | Wrap (axe-core has rules) | P1 | v0.8 |
| `hover_only_affordance` | Static-analysis: `:hover` styles without `:focus-visible`/`:focus`; runtime: element with hover-revealed UX has no equivalent on touch. | Universal | Med | L | $ | Native | P3 | defer |
| `heading_hierarchy_skip` | axe-core covers; promote to its own kind with structural fix-hint (h1→h3 without h2). | Universal | High | S | $ | Wrap | P1 | v0.6 |

**Anchor:** axe-core does most of this; we **wrap, ingest, and dedupe** rather than reinvent. The new value BugHunter adds is the **delta-based + per-action context** — axe alone says "page X has problem Y"; BugHunter says "action Z on page X introduced problem Y" with action-log replay.

---

### 3.5 Security (OWASP Top 10 + adjacents)

| OWASP | Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|---|
| A01 | `idor_horizontal` | Cross-role probe: enumerate role A's resource IDs from API responses; replay GET/PUT/DELETE as role B; expect 403/404, flag 200. | Universal | High | L | $ | Native | P0 | v0.5 |
| A01 | `idor_vertical_role_escalate` | Probe admin routes as non-admin role; expect 403, flag 200. | Universal | High | M | $ | Native | P0 | v0.5 |
| A01 | `auth_bypass_via_unauthed_route` | List all SurfaceMCP tools where SurfaceMCP says "auth required"; call without auth; expect 401, flag 200. | Universal | Very High | S | $ | Native | P0 | v0.5 |
| A02 | `missing_https_in_dev_link` | Static-analysis: `http://` URLs in source pointing at non-localhost. | Universal | High | S | $ | Native | P1 | v0.7 |
| A02 | `sensitive_data_in_url` | HAR sweep: URLs with `?password=`, `?token=`, `?email=`, etc. | Universal | High | S | $ | Native | P0 | v0.5 |
| A02 | `weak_password_hashing` | Static-analysis: import of `md5`/`sha1` near user-creation paths. | Node-side | Med | M | $ | Wrap (semgrep ruleset) | P2 | v0.7 |
| A03 | `xss_reflected` | Synthetic: inject `<script>__BH__()</script>`-style canary into every text input; observe DOM execution post-render. | Universal | High | L | $ | Wrap (`zaproxy`/Nikto have this; native is feasible) | P1 | v0.7 |
| A03 | `xss_stored` | Same canary, persisted via mutating endpoint; revisit reading endpoint, observe execution. | Universal | High | L | $ | Native | P1 | v0.7 |
| A03 | `xss_dom` | Static + runtime: `innerHTML`/`dangerouslySetInnerHTML` with non-sanitized expression; or runtime mutation with canary. | Universal | Med | M | $ | Hybrid | P2 | v0.8 |
| A03 | `sql_injection_probe` | Synthetic: classic SQLi payloads (`' OR 1=1--`, etc.) into form fields; observe 500 with DB-trace text in response. | Universal | High | M | $ | Wrap (`sqlmap` is the gold standard; do not reimplement — wrap and ingest output) | P1 | v0.7 |
| A03 | `prompt_injection_llm_route` | Synthetic: known prompt-injection payloads against any SurfaceMCP route returning LLM-generated text; observe leakage. | LLM-routes only | Med | L | $$ | Native | P2 | v0.8 |
| A03 | `command_injection_probe` | Synthetic: shell-meta payloads (`$(whoami)`, `;ls`) on string fields hitting routes that stat-call shell. | Universal | Low (very route-specific) | L | $ | Wrap (semgrep) | P3 | defer |
| A04 | `open_redirect` | Synthetic: locate `?redirect=`/`?return_to=`/etc params; replace with `https://evil.test`; observe Location header. | Universal | Very High | S | $ | Native | P0 | v0.5 |
| A04 | `business_logic_bypass` | Pure heuristic; usually requires per-app rules. | App-dep | Very Low | XL | $ | N/A (humans) | P3 | never |
| A05 | `missing_csp_header` | HTTP probe: request app root; check `Content-Security-Policy` header presence. | Universal | High | S | $ | Wrap (`securityheaders.com` algorithm) | P0 | v0.5 |
| A05 | `permissive_cors` | HTTP probe: `OPTIONS` on API routes; check `Access-Control-Allow-Origin: *` on credentialed endpoints. | Universal | High | S | $ | Native | P0 | v0.5 |
| A05 | `default_creds` | Synthetic: try `admin/admin`, `admin/password`, etc. on login route. | Universal | Very High | S | $ | Wrap (Hydra, but native is fine) | P1 | v0.7 |
| A05 | `debug_mode_in_prod` | HTTP probe: `/__nextjs_original-stack-frame`, `/wp-admin`, `/.env`, `/.git/config`, `/admin`, `/_next/data/...`, `/debug`, etc. (not actually our problem in dev — this is a deploy-time check, but valuable to run pre-merge.) | Framework-dep | Very High | S | $ | Wrap (`feroxbuster`, `gobuster`, but a small list is enough) | P1 | v0.7 |
| A05 | `exposed_dotfiles` | HTTP probe for `.env`, `.git/HEAD`, `.git/config`, `.DS_Store`, `package-lock.json`. | Universal | Very High | S | $ | Native | P1 | v0.7 |
| A06 | `vulnerable_dependency` | Wrap `npm audit --json` / `pnpm audit` / `yarn audit`. Ingest critical/high. | Node-side | High | S | $ | Wrap (`npm audit`, Snyk, Socket) | P0 | v0.5 |
| A06 | `outdated_with_known_cve` | Wrap `osv-scanner` (Google's, OSS, broader than `npm audit`). | Universal | High | S | $ | Wrap | P1 | v0.6 |
| A07 | `no_rate_limit_on_login` | Synthetic: 50 rapid login POSTs from same IP; flag if 50th is still 200/401 not 429. | Universal | Very High | S | $ | Native | P0 | v0.5 |
| A07 | `password_reset_token_reuse` | Synthetic: complete reset flow; replay the same token; expect failure. | Universal | High | M | $ | Native | P1 | v0.7 |
| A07 | `weak_password_accepted` | Synthetic: try `123456`, `password`; flag if signup accepts. | Universal | High | S | $ | Native | P1 | v0.7 |
| A07 | `session_fixation` | Synthetic: capture pre-login session id; login; check id rotated. | Universal | High | M | $ | Native | P2 | v0.8 |
| A08 | `csrf_missing_on_mutating_route` | HTTP probe: state-changing route accepts request without `X-CSRF-Token` / origin check / SameSite cookie. | Universal | High (modern frameworks usually OK; vibe-coded apps frequently bad) | S | $ | Native | P0 | v0.5 |
| A09 | `stack_trace_leak_in_response` | LLM-of-response or regex sweep on 5xx bodies. | Universal | Very High | S | $ | Native (regex is enough) | P0 | v0.5 |
| A09 | `pii_in_client_logs` | LLM-of-response over console-error stream: detect emails, SSN-shaped, CC-shaped strings. | Universal | Med | M | $$ | Native | P2 | v0.8 |
| A10 | `ssrf_user_supplied_url` | Discover routes accepting user-URL params; probe with `http://169.254.169.254/`/`file:///etc/passwd`-style payloads; observe response. | Universal | Med | L | $ | Native | P2 | v0.8 |
| — | `cookie_security_flags` | HTTP probe: `Set-Cookie` headers; check `Secure` / `HttpOnly` / `SameSite`. | Universal | Very High | S | $ | Native | P0 | v0.5 |
| — | `subresource_integrity_missing` | HTML scan: `<script src="https://...">` without `integrity=`. | Universal | High | S | $ | Native | P1 | v0.7 |
| — | `sourcemaps_in_prod` | HTTP probe: `*.js.map` reachable on prod build. | Build-tool dep | High | S | $ | Native | P1 | v0.7 |

**Anchor (and warning):** Security is the area most tempting to expand and hardest to keep precise. The discipline rule: **wrap established tools** (`npm audit`, `osv-scanner`, `sqlmap`, `semgrep`, `Pa11y`) and **ingest their output as BugHunter clusters with replay context**. We add value via the per-action context + clustering + spec-and-fix loop, not by writing a payload database. The handful of natively-implemented checks (IDOR, open redirect, header hygiene, CSRF presence, no-rate-limit) are checks the wrappable tools do not naturally do per-app — they are the checks that benefit most from the SurfaceMCP catalog and BugHunter's role matrix.

---

### 3.6 Data integrity

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `duplicate_records_via_double_submit` | Covered by `race_double_submit` (functional). | — | High | — | $ | Native | P0 | v0.5 |
| `orphaned_records_fk_unenforced` | Static-analysis: Prisma schema; flag relations with `onDelete: NoAction` or no FK declaration where the data model implies one. | Prisma-dep | Med | M | $ | Native | P2 | v0.8 |
| `money_math_precision` | Static-analysis: `*` / `+` on `price`/`amount`/`total` field types in code; flag floats vs decimal. | App-dep (Prisma type hints help) | Med | M | $ | Native | P1 | v0.7 |
| `concurrent_update_lost` | Synthetic: two parallel PUTs to same resource; observe response semantics (last-write-wins vs 409 conflict). | Universal | High | M | $ | Native | P2 | v0.8 |
| `transaction_boundary_wrong` | Static + runtime: route makes two writes; first succeeds, kill the second mid-flight; observe orphan. | App-dep | Low (very tricky) | XL | $ | N/A | P3 | defer |

**Anchor:** Most data-integrity bugs require knowing the app's invariants. We can do the structural checks (FK presence, money types) and the easy concurrency probe; the rest is human territory. State this clearly so we don't promise what we can't deliver.

---

### 3.7 Internationalization

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `hardcoded_strings_no_i18n` | Static-analysis: JSX text nodes with English-letter content not wrapped in i18n function. | i18n-dep (only flag when project uses `react-intl`/`i18next`/`next-intl`) | Med | M | $ | Native | P2 | v0.7 |
| `non_ascii_broken` | Synthetic: input mutation palette adds Cyrillic/CJK/emoji/RTL chars; observe encoding errors in DOM/HAR. | Universal | High | S | $ | Native (palette extension) | P1 | v0.5 |
| `rtl_layout_broken` | Multi-viewport + locale switch: render in RTL locale; vision compare against LTR baseline. | App-dep | Low (high false-positive without RTL-aware check) | L | $$ | Hybrid (vision) | P3 | defer |
| `date_format_ambiguity` | LLM-of-output: page sweep for date strings; flag mixed `MM/DD/YYYY` and `DD/MM/YYYY` on one page. | Universal | Med | M | $$ | Native (LLM pass) | P2 | v0.8 |

---

### 3.8 SEO / metadata

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `missing_or_duplicate_title` | DOM probe per page: `<title>` exists; cross-page uniqueness. | Universal | Very High | S | $ | Wrap (Lighthouse SEO category) | P1 | v0.6 |
| `missing_meta_description` | DOM probe: `<meta name="description">`. | Universal | High | S | $ | Wrap | P1 | v0.6 |
| `broken_open_graph` | DOM probe: `og:title`, `og:image`, `og:url`; image URL HEAD request. | Universal | High | S | $ | Wrap | P1 | v0.6 |
| `missing_robots_txt_or_sitemap` | HTTP probe: `/robots.txt`, `/sitemap.xml`. | Universal | High | S | $ | Wrap | P2 | v0.7 |
| `missing_canonical` | DOM probe per page. | Universal | Med | S | $ | Wrap | P2 | v0.7 |
| `missing_hreflang` | DOM probe; only fires if i18n routes detected. | i18n-dep | Med | M | $ | Wrap | P3 | v0.9 |

**Anchor:** Lighthouse already does all of this. We **wrap Lighthouse's SEO audit** (`npx lighthouse --only-categories=seo --output=json`) and ingest. Cheap, well-calibrated, no reinvention.

---

### 3.9 Privacy / compliance

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `cookie_set_without_consent` | HAR + DOM: cookies set on first page load before any visible consent UI. | EU/CCPA-target apps | Med (false-positive on apps that don't target those regions) | L | $ | Native | P2 | v0.8 |
| `tracking_pixel_undisclosed` | HAR: third-party requests to known tracker domains (Mixpanel, GA, Segment, Posthog…) on first load. | Universal | Med (depends on whether tracking is disclosed) | M | $ | Wrap (`uBlock` filter lists for tracker domain DB) | P3 | v0.9 |
| `pii_in_client_logs` | (Already listed under A09.) | — | — | — | — | — | — | — |
| `no_data_export_endpoint` | SurfaceMCP catalog scan: no `data-export` / `gdpr-export` / `account-export` endpoint detected. | App-dep | Low | S | $ | Native | P3 | defer |
| `no_account_delete_endpoint` | Same, for `delete-account`/`close-account`. | App-dep | Low | S | $ | Native | P3 | defer |

**Anchor:** Compliance detection is per-jurisdiction. P2 only if user opts in via config (`compliance: { gdpr: true }`).

---

### 3.10 DevOps / observability

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `swallowed_error_empty_catch` | Static-analysis: `catch (e) {}` or `catch (e) { /* nothing */ }`. | TS/JS | Very High | S | $ | Wrap (`eslint-plugin-no-empty-catch`, semgrep) | P0 | v0.5 |
| `missing_health_endpoint` | HTTP probe: `/health`, `/healthz`, `/api/health`. | Universal | High | S | $ | Native | P1 | v0.7 |
| `metrics_publicly_exposed` | HTTP probe: `/metrics` (Prometheus) reachable without auth. | Universal | High | S | $ | Native | P1 | v0.7 |
| `console_log_in_prod` | Static-analysis: `console.log` in `app/`, `pages/`, `src/components/`. | TS/JS | Med | S | $ | Wrap (eslint rule) | P1 | v0.7 |
| `stale_todo_fixme` | Static-analysis: `TODO`/`FIXME` with git-blame age >90 days. | Universal | Low (informational) | S | $ | Wrap (`leasot`) | P3 | v0.9 |
| `missing_structured_logging` | Static-analysis: API handlers without observable logging hook. | Per-framework | Low | M | $ | Native | P3 | defer |

---

### 3.11 Code quality (static analysis)

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `unused_dependencies` | Wrap `depcheck` / `knip`. | Node | High | S | $ | Wrap | P1 | v0.7 |
| `dead_code_paths` | Wrap `ts-prune` / `knip`. | TS | Med | S | $ | Wrap | P2 | v0.7 |
| `hardcoded_credentials_in_source` | Wrap `gitleaks` / `trufflehog` / semgrep secrets. | Universal | Very High | S | $ | Wrap | P0 | v0.5 |
| `debug_console_left_in_prod` | (Same as `console_log_in_prod`.) | — | — | — | — | — | — | — |
| `insecure_http_url_in_source` | (Same as `missing_https_in_dev_link`.) | — | — | — | — | — | — | — |
| `eval_or_new_function` | Wrap eslint `no-eval`/`no-new-func`. | TS/JS | Very High | S | $ | Wrap | P1 | v0.7 |
| `magic_number_or_string` | Wrap eslint `no-magic-numbers` (with project-tuned config). | TS/JS | Low (very noisy out of the box) | S | $ | Wrap | P3 | v0.9 |
| `inconsistent_error_handling` | LLM-of-source pass: per-handler error pattern (try/catch vs `.catch()` vs ignore); flag inconsistency within one feature/module. | TS/JS | Med | L | $$$ | Native (LLM-of-source) | P2 | v0.8 |
| `phantom_import` | Static-analysis: imported symbol does not exist in target module. | TS | Very High | S | $ | Wrap (`tsc --noEmit` already catches; we surface as a BugKind) | P1 | v0.6 |

**Anchor:** This whole section is **wrap-and-ingest**. No reason to write a parser when `gitleaks`/`semgrep`/`knip` exist. The LLM-of-source class (`inconsistent_error_handling`) is the only novel piece — it is genuinely hard for static tools because "inconsistent" is a soft constraint.

---

### 3.12 Browser-specific

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `safari_specific_break` | Multi-browser: same test in WebKit; flag delta. | Universal | Med | XL (full Safari/WebKit pipeline) | $ | Wrap (Playwright supports webkit) | P2 | v0.9 |
| `firefox_specific_break` | Multi-browser: same test in Firefox. | Universal | Low | XL | $ | Wrap | P3 | v0.9 |
| `mobile_safari_100vh` | Multi-viewport: capture mobile-Safari viewport; vision flags content cut at viewport bottom. | Universal | Med | L | $$ | Hybrid (vision) | P2 | v0.8 |
| `regex_lookbehind_safari` | Static-analysis: regex literals with `(?<=...)` in source. | TS/JS | High | S | $ | Wrap (eslint `compat/compat`) | P2 | v0.8 |
| `cross_browser_visual_regression` | Multi-browser screenshots; vision compare across browsers. | Universal | Low (very expensive, lots of false-positive layout differences) | XL | $$$ | Hybrid | P3 | v0.9 |

**Anchor:** Multi-browser is XL infrastructure. Defer until v0.9 with eyes open about cost/value.

---

### 3.13 Network resilience

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `no_fetch_timeout` | Static-analysis: `fetch(...)` without `signal: AbortSignal.timeout(...)` or surrounding timeout. | TS/JS | High | S | $ | Native | P1 | v0.7 |
| `no_retry_on_transient` | Static-analysis: `fetch(...)` without retry wrapper; OR runtime synthetic: inject 503; expect retry. | Universal | Med | M | $ | Native | P2 | v0.8 |
| `api_rate_limit_unhandled` | Synthetic: trigger 429; observe UX (does it show "rate-limited" or generic error?). | Universal | High | M | $ | Native | P1 | v0.7 |
| `token_refresh_not_implemented` | Synthetic: clock-skew or expired-token to force 401; observe whether app refreshes vs forces re-login. | Universal | Med | L | $ | Native | P2 | v0.8 |
| `backend_health_check_missing` | (Same as `missing_health_endpoint`.) | — | — | — | — | — | — | — |

---

### 3.14 State persistence

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `localstorage_quota_unhandled` | Synthetic: fill localStorage near quota; trigger app's storage write; observe console error / crash. | Universal | Med | M | $ | Native | P2 | v0.8 |
| `state_not_restored_on_reload` | Synthetic: action sequence; reload; assert observable state matches pre-reload (URL, scroll, expanded states). | App-dep | Low (a lot of state legitimately doesn't persist) | L | $ | Native | P3 | defer |
| `stale_state_from_old_session` | Synthetic: log out; log in as different user; check no leaked state from previous session. | Universal | Med | M | $ | Native | P2 | v0.8 |

---

### 3.15 Workflow / UX

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `multistep_form_loses_progress` | Synthetic: multi-page form; navigate forward then back; assert filled values intact. | Universal | High | M | $ | Native | P1 | v0.7 |
| `destructive_action_no_confirm` | Synthetic: discover delete-shaped buttons (text "Delete" / "Remove"); click; check for confirm modal. | Universal | High | S | $ | Native | P1 | v0.6 |
| `no_undo_on_destructive` | Synthetic: after destructive action, look for "undo" toast or undo affordance within 5s. | Universal | Low (most apps don't have undo by design) | S | $ | Native | P3 | defer |
| `generic_error_message` | LLM-of-output: error toasts/banners that say only "Something went wrong" without context. | Universal | Med | M | $$ | Native (vision pass extension) | P2 | v0.8 |
| `missing_success_feedback` | Synthetic: mutating action → no visible toast/redirect/state-change within 3s of completion. | Universal | Med | M | $ | Native (extends `missing_state_change`) | P2 | v0.8 |
| `confirm_then_refused` | Synthetic: action triggers confirm dialog → confirm → still 4xx. | Universal | Med | M | $ | Native | P3 | defer |

---

### 3.16 LLM-era (vibe-coded apps)

| Class | Detection technique | Stack-dep | S/N | Effort | Cost | Existing tools | Priority | Phase |
|---|---|---|---|---|---|---|---|---|
| `hallucinated_route` | Cross-reference: frontend `fetch('/api/x')` calls vs SurfaceMCP catalog; flag missing endpoints. | App-dep | Very High | S | $ | Native | P0 | v0.5 |
| `phantom_import` | (Same as code-quality `phantom_import`.) | — | — | — | — | — | — | — |
| `schema_drift_frontend_vs_backend` | TypeScript: client-side type for resource X vs backend-generated type for resource X; structural diff. | TS+Prisma/SurfaceMCP | High | L | $ | Native | P1 | v0.7 |
| `ai_boilerplate_happy_path_only` | LLM-of-source: handler covers only 200-path; no error/null/edge handling. | TS/JS | Med | L | $$$ | Native (LLM-of-source) | P2 | v0.8 |
| `magic_constant_no_context` | (Same as code-quality `magic_number_or_string`.) | — | — | — | — | — | — | — |
| `inconsistent_error_handling_within_codebase` | (Same as code-quality `inconsistent_error_handling`.) | — | — | — | — | — | — | — |
| `divergent_type_definitions` | TS-AST: same type name defined in two places with different shapes. | TS | High | M | $ | Native | P1 | v0.7 |
| `dead_route_only_referenced_in_one_file` | Cross-reference: SurfaceMCP-cataloged route never called from frontend nor from another backend handler. | Universal | Med | M | $ | Native | P2 | v0.8 |

**Anchor:** This category is BugHunter's natural advantage. Existing tools don't know about SurfaceMCP; existing tools don't know about the implicit contract between frontend and backend in a vibe-coded app. `hallucinated_route` alone is a P0 demo for any team using AI assistants.

---

### 3.17 Domain-specific (out of scope, by policy)

These belong to the user's own test plans; BugHunter does not attempt them generically. Documented as "user-supplied invariants" — a config block where the user can register pure-function invariants that BugHunter checks across runs. v1.0 may add this; before that, out of scope.

Examples:
- "Sum of trade legs equals trade total."
- "Inventory count equals sum of stock movements."
- "User's outstanding balance equals invoice total minus payments."

---

## 4. Cross-cutting infrastructure

These are the "pickaxe" investments. Each unblocks a cluster of detectors. Sequencing matters; some detectors are blocked behind these.

### 4.1 Real HAR capture (`infra:har`)

**Unblocks:** `n_plus_one_api_calls`, `no_request_dedup`, `no_request_cancel_on_nav`, `cache_miss_no_strategy`, `tracking_pixel_undisclosed`, `pii_in_client_logs`, `sensitive_data_in_url`, `cookie_set_without_consent`, every other HAR-based class.

**Status:** Stubbed. `packages/cli/src/phases/execute.ts:190` writes an empty HAR.

**Approach:** Two routes, pick one:

1. **Camofox-mcp gains HAR** — feature-request the camofox-mcp project; implement once; BugHunter consumes via existing browser-mcp adapter. Best long-term; out-of-band timing.
2. **Direct CDP via Playwright** — spin a parallel Playwright context (`playwright-core` is already a dep) and use `context.newCDPSession()` + `Network.enable` to write our own HAR. Independent of camofox; ships when we ship.

Recommendation: **route 2 in v0.5**. Camofox catches up later; we don't gate v0.5 on an external project.

**Effort:** M.

### 4.2 Real CDP integration (`infra:cdp`)

**Unblocks:** Web Vitals (LCP/INP/CLS), `memory_leak`, `main_thread_blocking`, `excessive_rerender`, `localstorage_quota_unhandled` (programmatically fill quota), offline-emulation (`offline_behavior`).

**Approach:** Same Playwright CDP session as HAR. Same Playwright context can provide:
- `Performance.metrics` for vitals.
- `HeapProfiler.takeHeapSnapshot` for leak detection.
- `Network.emulateNetworkConditions` for offline / slow-3G.
- Long-task / `performance.measureUserAgentSpecificMemory` via runtime eval.

**Effort:** L (the integration is moderate; the surfacing of metrics into `BugDetection` is small per metric).

**Order:** v0.6, after HAR proves the parallel-Playwright pattern.

### 4.3 Static-analysis pipeline (`infra:static`)

**Unblocks:** `swallowed_error_empty_catch`, `console_log_in_prod`, `hardcoded_credentials_in_source`, `phantom_import`, `divergent_type_definitions`, `unused_dependencies`, `dead_code_paths`, `eval_or_new_function`, `regex_lookbehind_safari`, `magic_number_or_string`, `unbounded_list_render` (in part), `no_fetch_timeout`, `weak_password_hashing`, `xss_dom`, `aria_misuse`, `hardcoded_strings_no_i18n`, `orphaned_records_fk_unenforced`, `money_math_precision`, all the LLM-era TS-AST classes.

**Approach:** New phase between `discover` and `plan`, or a parallel pre-discovery sweep. Two sub-pipelines:

1. **Wrap external tools.** A "tool-runner" framework: per project, BugHunter knows how to run `gitleaks`, `semgrep`, `npm audit`, `osv-scanner`, `knip`, `depcheck`, `eslint --format json`, `tsc --noEmit`, `lighthouse --output=json`, `pa11y-ci --json`. Each tool's output is mapped to BugHunter clusters via per-tool adapters in `packages/cli/src/static/`.
2. **Native TS-AST passes.** For the BugHunter-unique classes (phantom-import-vs-SurfaceMCP, divergent-type-definitions, hallucinated-route): use `ts-morph` (already TS-friendly, well-maintained, ~1MB). One small AST module per check.

**Effort:** L for the framework; S per wrapped tool; S-M per native check.

**Order:** v0.5 ships the framework + the cheapest wraps (gitleaks, npm audit, semgrep secrets). v0.6 onward adds checks incrementally.

### 4.4 Multi-viewport (`infra:viewport`)

**Unblocks:** `touch_target_too_small`, `mobile_safari_100vh`, mobile-specific visual anomalies, `hover_only_affordance`.

**Approach:** Configure browser MCP with viewport matrices (default desktop 1280x800; add mobile 375x667 and tablet 768x1024 when `viewportMatrix: 'all'`). Each (role, page, action) test fans out to N viewports in v0.8. Vision baseline per viewport. Not all tests need to run multi-viewport — only the render and click tests do; form fills don't differ.

**Cost concern:** N× test count. Default off; opt in via config.

**Effort:** M.

**Order:** v0.8.

### 4.5 Multi-browser (`infra:multibrowser`)

**Unblocks:** `safari_specific_break`, `firefox_specific_break`, `cross_browser_visual_regression`.

**Approach:** Playwright supports Chromium / Firefox / WebKit via the same API. Reuse the parallel-Playwright path from §4.1; instantiate per browser.

**Cost:** 3× run time at full coverage. Default off. Opt in via `browsers: ['chromium', 'webkit']`.

**Effort:** L.

**Order:** v0.9.

### 4.6 Authenticated cross-user / IDOR matrix (`infra:cross-user`)

**Unblocks:** `idor_horizontal`, `idor_vertical_role_escalate`, `auth_bypass_via_unauthed_route`, `stale_state_from_old_session`.

**Approach:** Today, BugHunter logs in as each role independently. The cross-user matrix runs an additional pass: for each role A, capture the resource IDs owned by A; for each other role B, replay A's GETs/PUTs/DELETEs as B; expect 403/404, flag 200.

**Implementation:** New `phases/cross-user.ts` running after `execute`. Lightweight HTTP via SurfaceMCP; no browser needed. Outputs to `classify` like every other phase.

**Effort:** L (planning the resource-ID extraction + the per-role replay).

**Order:** v0.5. This is one of the highest-value adds.

### 4.7 Header / CSP / CORS probe (`infra:headers`)

**Unblocks:** `missing_csp_header`, `permissive_cors`, `cookie_security_flags`, `subresource_integrity_missing`, `sourcemaps_in_prod`.

**Approach:** A small, single-purpose module that hits the app root + each SurfaceMCP-cataloged route with appropriate methods, captures response headers, and runs a configurable rule set. ~200 lines. Outputs to `classify`.

**Effort:** S.

**Order:** v0.5.

### 4.8 LLM-of-source / LLM-of-response pipeline (`infra:llm-text`)

**Unblocks:** `inconsistent_error_handling_within_codebase`, `ai_boilerplate_happy_path_only`, `pii_in_client_logs`, `currency_formatting_inconsistency`, `date_format_ambiguity`, `generic_error_message`.

**Approach:** Generalize the v0.4 vision adapter. The vision client today takes screenshots; the new client takes either screenshots OR text-blocks (HTML, JSON response, source file content) and calls the same Anthropic API with a swappable prompt template. Same budget controls, same severity gating, same dedup.

**Effort:** M.

**Order:** v0.7. Deliberately later than vision: we want vision's calibration knobs to settle before we build a sibling pipeline that reuses them.

### 4.9 Synthetic-interaction primitives (`infra:synthetic`)

**Unblocks:** `race_double_submit`, `multistep_form_loses_progress`, `destructive_action_no_confirm`, `no_rate_limit_on_login`, `password_reset_token_reuse`, `weak_password_accepted`, `session_fixation`, `concurrent_update_lost`, `localstorage_quota_unhandled`, `state_not_restored_on_reload`, `stale_state_from_old_session`, every flow-based test.

**Approach:** A "scenario library." Each scenario is a small TS module that takes the discovered surface (SurfaceMCP catalog, DOM walk results) and emits a sequence of actions to drive. Scenarios are opt-in via config. The runner is the same `execute` phase; only the action source differs.

**Effort:** L for the framework; S-M per scenario.

**Order:** v0.5 framework + the cheapest scenarios; expand each phase.

### 4.10 SurfaceMCP roles + body-fixture extension for auth probes (`infra:auth-probes`)

**Unblocks:** `auth_bypass_via_unauthed_route`, `default_creds`, `weak_password_accepted`, `password_reset_token_reuse`, `no_rate_limit_on_login`.

**Approach:** A small extension that builds anonymous and synthetic-credential variants of role-pinned calls. SurfaceMCP exposes which routes require auth; BugHunter knows which routes are public. The cross-product is the test set.

**Effort:** S (mostly config + a planner branch).

**Order:** v0.5.

### 4.11 User-supplied invariants (`infra:invariants`)

**Unblocks:** the entire domain-specific category, on user opt-in.

**Approach:** Config block:

```ts
type InvariantsConfig = {
  invariants: Array<{
    id: string;
    description: string;
    fn: (state: ProjectStateAccessor) => Promise<{ ok: boolean; detail?: string }>;
  }>;
}
```

The user writes their own check functions; BugHunter runs them post-`execute` and surfaces failures as a special `BugKind: 'invariant_violation'` with the invariant id.

**Effort:** S.

**Order:** v1.0.

### 4.12 Resource ID extractor (`infra:resource-ids`)

**Unblocks:** Full-fidelity IDOR (`infra:cross-user` works without it but is far more powerful with it).

**Approach:** During `execute`, scrape resource IDs from API responses (matching `id`, `uuid`, `slug` fields); persist to a per-role manifest; the cross-user phase reads them.

**Effort:** S.

**Order:** v0.5 (paired with `infra:cross-user`).

---

## 5. Honest Priority Calibration

The user said "no use case too subtle." Cataloged accordingly. The roadmap's job is to translate that into a shipping order.

### 5.1 P0 criteria (must-have)

A class is P0 only if **all** of:
- Signal-to-noise estimate is High or Very High.
- Effort is S or M.
- Detection technique does not require external infrastructure beyond what we already have or what we can build cheaply.
- Provides an unambiguous, hard-to-dismiss bug report.

### 5.2 P1 criteria (high-value, calibration acceptable)

- High S/N **or** medium S/N with clear calibration knobs (severity gating, threshold config).
- Effort S/M/L acceptable.
- May require new infrastructure (HAR, CDP, static-analysis), provided that infrastructure is on the roadmap and is itself shipping.

### 5.3 P2 criteria (nice to have)

- Medium S/N requiring per-app calibration.
- Cost may be $$ (LLM-bounded).
- Detector is opt-in by default.

### 5.4 P3 criteria (defer / maybe)

- Low S/N without calibration.
- Highly app-specific.
- Better-served by an existing tool we don't ship in-band.
- Effort XL with marginal value.

### 5.5 Classes that REQUIRE per-app calibration

These are P2 or below regardless of attractiveness, because the false-positive rate is the make-or-break dimension:

- `sort_filter_state_corruption` — needs to know which UI state is supposed to survive.
- `autosave_vs_manual_conflict` — autosave behavior is per-app.
- `decimal_precision`, `currency_formatting_inconsistency`, `date_format_ambiguity` — requires knowing the app's locale.
- `business_logic_bypass` — requires knowing the business logic.
- `excessive_rerender` — what counts as "too many" depends on the component.
- `cache_miss_no_strategy` — apps deliberately omit cache headers.
- `magic_number_or_string` — eslint default config is unusably noisy.
- `tracking_pixel_undisclosed` — depends on consent context.
- `cross_browser_visual_regression` — pixel diffs are inherently noisy.

### 5.6 Classes where false-positive rate is make-or-break

These need disciplined severity gating, dedup, and threshold knobs from day one:

- All vision-driven detection. (We already learned this in v0.4; budget + severity threshold + dedup are non-negotiable.)
- All LLM-of-source detection. (Same calibration discipline.)
- `keyboard_trap` — apps with intentional focus-trap modals will trigger naive detectors.
- `loading_state_stuck` — needs robust "stuck" definition (>10s, no network activity).
- `n_plus_one_api_calls` — N=10 default; configurable.
- `state_not_restored_on_reload` — many states legitimately don't persist.

### 5.7 Classes best left to existing tools

Wrap, don't reinvent. These belong as adapters, never as native classifiers:

- Vulnerable dependencies → `npm audit` / `osv-scanner` / Snyk.
- SQL injection → `sqlmap`.
- Pen-test attack chains → human pen-testers; ZAP for the boring 80%.
- Lighthouse SEO + perf → `lighthouse`.
- Accessibility structural → `axe-core` (already wrapped) + `pa11y-ci`.
- Tracker domain database → uBlock filter lists.
- Dependency complexity / dead code → `knip`.
- Hardcoded credentials → `gitleaks` / `trufflehog`.

We add value via per-action context, clustering, replay, and the spec-and-fix loop — not by replicating well-tuned databases.

---

## 6. Phased Roadmap

Each phase is one or more focused implementation specs. Each phase is independently valuable and shippable. Effort estimates are the spec-and-implement total, not infrastructure prerequisites alone.

### v0.5 — "Security & Surface Hygiene"

**Theme:** Catch the bugs vibe-coded apps reliably ship with. High S/N security and code-hygiene wins. Foundations for HAR and static-analysis.

**New BugKinds:**
- `idor_horizontal`, `idor_vertical_role_escalate`, `auth_bypass_via_unauthed_route`
- `open_redirect`
- `missing_csp_header`, `permissive_cors`, `cookie_security_flags`
- `csrf_missing_on_mutating_route`
- `no_rate_limit_on_login`
- `vulnerable_dependency`
- `hardcoded_credentials_in_source`
- `swallowed_error_empty_catch`
- `stack_trace_leak_in_response`
- `sensitive_data_in_url`
- `non_ascii_broken` (palette extension; no new kind)
- `optimistic_update_divergence`
- `race_double_submit`
- `hallucinated_route`
- `hydration_mismatch` (promote from `react_error`)

**New infrastructure:**
- `infra:har` — real HAR capture via parallel Playwright CDP.
- `infra:static` framework + first wraps (`gitleaks`, `npm audit`, `semgrep` secrets ruleset, eslint `no-empty`).
- `infra:cross-user` + `infra:resource-ids` — IDOR primitives.
- `infra:headers` — CSP/CORS/cookie probe.
- `infra:auth-probes` — anonymous + synthetic-credential variants.
- `infra:synthetic` framework + scenarios for `race_double_submit`, `no_rate_limit_on_login`, `optimistic_update_divergence`.

**Effort:** ~6-8 weeks.

**Killer demo:** Run BugHunter against TraiderJo. Find:
1. An IDOR (one user can read another's trade entries).
2. A missing CSP header.
3. A `console.log("user data:", ...)` left in a route handler.
4. A `setTimeout(() => location.reload(), 1000)` in a "save successful" handler that masks an actual API failure (`optimistic_update_divergence`).
5. A `npm audit` high-severity in a transitive dep.

That single demo more than doubles the value of v0.4.

### v0.6 — "Performance & Web Vitals"

**Theme:** Performance budgets. Real CDP. Lighthouse + native checks. SEO basics ride along.

**New BugKinds:**
- `slow_lcp`, `slow_inp`, `slow_cls`
- `bundle_size_exceeded`
- `n_plus_one_api_calls`
- `no_request_dedup`
- `outdated_with_known_cve` (osv-scanner wrap)
- `phantom_import` (TS-AST native)
- `missing_or_duplicate_title`, `missing_meta_description`, `broken_open_graph` (Lighthouse SEO wrap)
- `axe_color_contrast_strong` + `keyboard_trap` + `focus_management_modal` + `heading_hierarchy_skip` (a11y push)
- `destructive_action_no_confirm`
- `loading_state_stuck`
- `pagination_off_by_one`

**New infrastructure:**
- `infra:cdp` — full CDP integration via parallel Playwright.
- Lighthouse wrap (subset: SEO + perf categories).
- Bundle-size analysis (read project's build output).

**Effort:** ~4-6 weeks.

**Killer demo:** Find an LCP of 4.2s on TraiderJo's dashboard caused by the chart library being eagerly loaded; flag a 1.8MB bundle on initial route; surface 3 N+1 API patterns in the trades list (one fetch per row instead of one batch).

### v0.7 — "Static Analysis & Code Hygiene"

**Theme:** The code itself is the source of bugs. Static-analysis pipeline matures; LLM-era checks ship.

**New BugKinds:**
- `console_log_in_prod`, `eval_or_new_function`, `unused_dependencies`, `dead_code_paths`
- `xss_reflected`, `xss_stored`, `sql_injection_probe` (sqlmap wrap)
- `weak_password_accepted`, `default_creds`
- `debug_mode_in_prod`, `exposed_dotfiles`, `subresource_integrity_missing`, `sourcemaps_in_prod`
- `missing_health_endpoint`, `metrics_publicly_exposed`
- `multistep_form_loses_progress`
- `api_rate_limit_unhandled`
- `no_fetch_timeout`
- `schema_drift_frontend_vs_backend`, `divergent_type_definitions`
- `hardcoded_strings_no_i18n` (i18n-aware projects only)
- `money_math_precision`
- `password_reset_token_reuse`
- `aria_misuse`, `live_region_missing`, `dynamic_content_not_announced`
- `missing_robots_txt_or_sitemap`, `missing_canonical`
- `weak_password_hashing`
- `missing_https_in_dev_link`

**New infrastructure:**
- `infra:llm-text` — generalized LLM-of-source / LLM-of-response pipeline.
- Wrap suite: `knip`, `depcheck`, `ts-prune`, `pa11y-ci`, `sqlmap` (carefully gated; only on routes flagged as candidates), `eslint compat/compat`, `osv-scanner` (already in v0.6).

**Effort:** ~6-8 weeks.

**Killer demo:** Find a `setTimeout` token-refresh that fires on its own clock vs server expiry; flag 3 phantom imports introduced by an LLM-generated PR; flag a divergent `User` type defined two ways across the frontend and the API.

### v0.8 — "Mobile, Multi-viewport, and the Long Tail"

**Theme:** Mobile-first detection + the LLM-heavy detectors that need v0.7's pipeline.

**New BugKinds:**
- `touch_target_too_small`, `mobile_safari_100vh`
- `regex_lookbehind_safari`
- `xss_dom`, `prompt_injection_llm_route`, `pii_in_client_logs`, `ssrf_user_supplied_url`
- `session_fixation`, `concurrent_update_lost`, `localstorage_quota_unhandled`, `stale_state_from_old_session`
- `currency_formatting_inconsistency`, `date_format_ambiguity`
- `cookie_set_without_consent`
- `inconsistent_error_handling`, `ai_boilerplate_happy_path_only`
- `unbounded_list_render`
- `dead_route_only_referenced_in_one_file`
- `generic_error_message`, `missing_success_feedback`
- `orphaned_records_fk_unenforced`
- `no_retry_on_transient`, `token_refresh_not_implemented`
- `memory_leak`
- `offline_behavior`

**New infrastructure:**
- `infra:viewport` — multi-viewport runs.
- Prisma-schema parser for FK/data-integrity checks.

**Effort:** ~6-8 weeks.

**Killer demo:** Run BugHunter against TraiderJo at mobile viewport: find 7 touch targets <44px on the trades list; find raw template strings rendering on a settings page; find an `aria-live` missing on a toast region that auto-renders on save.

### v0.9 — "Multi-Browser, Calibration, and the User-Supplied Edge"

**Theme:** Final coverage push — multi-browser, the noisiest detectors gated behind opt-in calibration.

**New BugKinds:**
- `safari_specific_break`, `firefox_specific_break`, `cross_browser_visual_regression`
- `excessive_rerender`
- `tracking_pixel_undisclosed`
- `sort_filter_state_corruption`
- `state_not_restored_on_reload`
- `confirm_then_refused`
- `magic_number_or_string` (project-tuned eslint config)
- `stale_todo_fixme`
- `missing_hreflang`

**New infrastructure:**
- `infra:multibrowser` — Playwright Firefox + WebKit.
- Calibration framework: per-class threshold config, baseline-acceptance flow ("this run's findings; mark which are noise"), false-positive feedback loop.

**Effort:** ~6-8 weeks.

**Killer demo:** Run BugHunter against TraiderJo across Chromium + WebKit: find a date-input rendering bug only in Safari; surface a calendar component that double-renders on Firefox.

### v1.0 — "Vision Realized"

**Theme:** The user-supplied invariants block; full polish; documentation.

**New BugKinds:**
- `invariant_violation` (user-supplied).

**New infrastructure:**
- `infra:invariants` — user-supplied invariants block.
- Calibration UX maturation: dashboard for false-positive feedback that retrains thresholds.

**Effort:** ~3-4 weeks.

**Killer demo:** A user writes 3 domain invariants ("trade legs sum to total", "inventory equals stock movements"); BugHunter runs them across 200 mutations; finds the one that violates after a discount-application action.

---

## 7. Anti-goals (out of scope, by policy)

These are stated explicitly so future-us doesn't waste effort. To bring any of them back into scope requires a deliberate spec change.

1. **Production / staging environment scanning.** BugHunter is a dev-time tool. We do not run probes against live infrastructure. The synthetic interactions (race_double_submit, IDOR, no_rate_limit_on_login) would constitute attacks on production; we explicitly refuse to support that.
2. **Replacing pen-tester human creativity.** Novel attack chains (chained CVEs, social-engineering-adjacent flows, business-logic exploits) belong to humans. We catch the boring 80%; we name the existing tools (ZAP, Burp, sqlmap) for the rest.
3. **Domain-specific business-logic bugs.** "The trade total should equal the sum of legs" requires knowing what a trade leg is. We provide the `infra:invariants` hook for users to specify these; we do not infer them.
4. **Replacing established tools where they're better.** No reimplementing axe-core, Lighthouse, Snyk, gitleaks, semgrep, sqlmap. We wrap. Where the wrapped tool's output needs context (per-action replay, clustering, fix-loop), BugHunter adds that — but the detection itself stays in the proven tool.
5. **Self-fixing without human review.** The auto-fix loop is gated on the architect-orchestrator's spec-then-coder pipeline + forbidden-path gate + retest verification. We never ship an auto-merged PR; we ship a branch that a human reviews. Especially true for security findings — false-positive rate of "is this really an IDOR?" is high enough that auto-applying fixes is a regression risk.
6. **Generative test-case writing without grounding.** We do not ask an LLM to "write tests for this app." Every test is grounded in the discovered surface (DOM walk, SurfaceMCP catalog, static-analysis output). LLMs make decisions on classification and on prompt-driven analysis of explicit text/source/screenshot inputs; they don't make decisions on "what to test."
7. **Continuous monitoring / alerting.** BugHunter runs are explicit, on-demand. We don't monitor a running app. (Sentry / Datadog / PostHog do this better.)
8. **API mocking / contract testing.** Pact, MSW, etc. solve this. We do not.
9. **Load testing / capacity planning.** k6, Locust, Artillery solve this. We do not.
10. **Visual regression diffing across runs.** Out of scope as a primary use case (we tried, in v0.4 we deliberately stopped at vision-anomaly detection per-screenshot, no cross-run pixel-diff). v0.9 may add cross-browser visual diff with strict opt-in; cross-run, no.
11. **Replacing test runners.** We do not replace vitest/jest/playwright-test. We complement them. A team using BugHunter still writes their own unit and integration tests.

---

## 8. Open questions (for the user)

These are real strategic decisions the architect cannot make alone. Each blocks a specific phase or class.

### Q1 — Auth-probe blast radius

`no_rate_limit_on_login` involves making 50+ login attempts. Even in dev, this can lock accounts on apps with account-lockout features. Should the auth-probe phase be **opt-in by default** (require `--enable-auth-probes`)? Recommended yes; user confirms.

### Q2 — sqlmap integration depth

`sqlmap` is the gold standard for SQLi but is **slow** (minutes per endpoint) and **noisy**. Options:

- (a) Run on every text-input field on every form. Slow.
- (b) Run only on fields where the v0.4 search-edge-cases detector got a 500 with DB-trace text in the response. Cheap, high-precision, misses some.
- (c) Don't ship sqlmap; rely on internal canary + 500-pattern detection.

Recommended (b). User confirms.

### Q3 — IDOR resource-id extraction scope

For IDOR, BugHunter scrapes resource IDs from API responses owned by role A and replays them as role B. This requires knowing **which fields are IDs**. Options:

- (a) Heuristic: any field named `id`, `uuid`, `slug`, ending in `Id` / `_id`.
- (b) SurfaceMCP-aware: SurfaceMCP knows the response schema; use the type information.
- (c) Hybrid.

Recommended (b) for accuracy + (a) as fallback. User confirms.

### Q4 — Static-analysis tool licensing

`semgrep` is open core but its better rule-packs are paid. `gitleaks` is fully OSS. Acceptable to require paid Semgrep for some checks, or stick to OSS rule sets only? Recommended: OSS only by default; document `semgrep --config=p/owasp-top-ten` (free pack) and mark paid-pack-dependent checks as opt-in.

### Q5 — Vision budget escalation across phases

Today vision is `maxCalls: 100` per run, default off. v0.7's LLM-of-source / LLM-of-response will reuse the same Anthropic key. Should the budget be **shared** across all LLM passes, or **per-pass**? Recommended **shared** with per-pass concurrency caps. User confirms.

### Q6 — User-supplied invariants — language

The `infra:invariants` block takes user functions. These need a runtime to execute. Options:

- (a) Plain TS — user writes functions in their own project; BugHunter imports them.
- (b) DSL — BugHunter defines a tiny invariant DSL; less flexible but auditable.

Recommended (a). User confirms.

### Q7 — Per-app calibration UX

"Mark this finding as 'expected behavior'" needs a place to live. Options:

- (a) `.bughunter/baseline.json` — user marks ignored cluster signatures; subsequent runs filter.
- (b) Inline `data-bughunter-ignore="reason"` HTML attributes.
- (c) Both.

Recommended (a) primary, (b) for dev-time DOM-element-specific suppressions. User confirms.

### Q8 — Multi-browser priority

Multi-browser is XL effort and the user-base for "vibe-coded SaaS" is heavily Chromium-dominant. Is v0.9's multi-browser actually a P1 user need, or a "nice to have" we should keep as P2/defer? Honest read: P2. User decides.

### Q9 — Production-style probing of dev environments

Several v0.5 probes (CSP/CORS/exposed-dotfiles/sourcemaps-in-prod) detect things that **should** matter in production but **don't** matter in dev. Should we probe the **build output** rather than the dev server? That changes the loop — BugHunter would need to spawn `next build && next start` (or equivalent) and probe that. Effort: M-L; signal goes from medium to high. User decides.

### Q10 — Continuous-mode for the future

Long-term, would the user want BugHunter to run on every commit (CI mode), nightly (cron mode), or only on-demand (current)? Affects the test-budget strategy: CI mode wants fast (subset, smoke); nightly wants comprehensive. v1.0 may add a `--profile fast|deep` flag. Surface this now so the phased plan keeps the option open. User decides.

---

## 9. Success Criteria — when does BugHunter fulfill the vision

The scanner fulfills the user's vision when **all of the following are true**:

### 9.1 Coverage

- 60+ distinct `BugKind`s in the union (today: 11).
- Detection across all 12 categories of §3 (functional, performance, a11y, security, data integrity, i18n, SEO, privacy, observability, code quality, browser-specific, network resilience, state persistence, workflow/UX, LLM-era).
- OWASP Top 10 application coverage at the level a non-attacker dev would expect (every top-10 has at least one detector even if not exhaustive).
- The 5-minute test: pick any P0 class from §3; on a deliberately-broken fixture, BugHunter detects it.

### 9.2 Precision

- Per-class false-positive rate <15% on a calibrated mid-sized SaaS.
- Vision and LLM-of-text detectors hit <20% even uncalibrated; <10% with a baseline file.
- Calibration framework lets users mark false-positives once and have them stick across runs.

### 9.3 Performance

- Full v1.0 run on a mid-sized SaaS (~50 routes, 5 roles) completes within 90 minutes at default concurrency.
- The synthetic-interaction phase does not add more than 3× the v0.4 baseline runtime when enabled.
- LLM costs (vision + text) stay under $5 per full run with default budgets.

### 9.4 Triage

- Every finding includes: action-log replay command, suspected-files list, fix-hint, severity, screenshot (when applicable), HAR (when applicable), a11y/CSP/header context (when applicable).
- The auto-fix loop's verified-fixed rate exceeds 50% on machine-tractable classes.
- Architect-refused rate is honest: clusters BugHunter cannot really diagnose are flagged with a clear reason.

### 9.5 Wrappable-tool discipline

- We wrap and ingest at least the following: axe-core (already), Lighthouse, npm audit, osv-scanner, gitleaks, semgrep, knip, pa11y-ci, sqlmap, eslint compat. None reimplemented in BugHunter.
- For each wrapped tool, BugHunter adds the per-action context, clustering, replay, and fix-loop integration that the bare tool does not provide.

### 9.6 Honesty

- The §7 anti-goals stay enforced. No production scanning, no replacing humans on novel attacks, no replacing established tools.
- Every detector has a documented S/N and known-noise pattern. Users know what to expect.
- `bughunter list-detectors` prints, per kind, "what this catches, what it doesn't, what its known false-positive shapes are."

---

## 10. Appendix — taxonomy summary by phase

| Phase | New BugKinds | New infra | Effort | Headline class |
|---|---|---|---|---|
| v0.5 | 16 | HAR + static-pipeline + cross-user + headers + auth-probes + synthetic | 6-8w | IDOR + open redirect + CSP/CORS + npm audit + secrets + IDOR-related |
| v0.6 | 12 | CDP + Lighthouse wrap | 4-6w | Web Vitals + N+1 + bundle size + SEO basics |
| v0.7 | 22 | LLM-text + extensive wrap suite | 6-8w | XSS/SQLi + schema drift + multi-step form + i18n |
| v0.8 | 18 | Multi-viewport + Prisma parser | 6-8w | Mobile + LLM-of-source + locale-formatting + memory |
| v0.9 | 9 | Multi-browser + calibration | 6-8w | Cross-browser + opt-in noisy detectors |
| v1.0 | 1 | Invariants block | 3-4w | Domain-specific via user functions |

**Total new BugKinds across roadmap: ~78. Plus 11 existing = ~89 distinct kinds at v1.0.** Comfortably exceeds the §9.1 target of 60.

---

## 11. Process for using this roadmap

1. The user reads §8 (Open questions) and answers them. Each answer can change a phase.
2. Per phase, @architect writes a focused implementation spec — one per BugKind cluster or one per infrastructure pickaxe. Existing specs (`SPEC_VISION_DETECTION.md`, `SPEC_CRAWLER.md`) are the format reference.
3. Each spec is implemented by @coder and reviewed by @architect.
4. Each phase ships independently. v0.5 is fully usable; v0.6 layers on top; users can adopt at any version.
5. After each phase ships, this roadmap is revisited: priorities re-calibrated based on real-world S/N data, the next phase's specs written.

The roadmap is a **living document**. New bug classes get added to §3 as the user observes them in the wild. Phases get re-sequenced if a class proves more valuable than expected. The taxonomy is the contract; the phase order is advisory.
