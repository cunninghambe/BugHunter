# BugHunter Spoonworks Benchmark

**Run:** `yg0qspnwqe8egeqdv7rrsd9l` (2026-05-11, spoonworks @ localhost:3456)
**Target:** spoonworks (Next.js 15 e-commerce, Healthy Spoon), 32 pages probed
**Audit by:** Claude (background agent, 2026-05-13)
**Bug count:** 77 clusters (42 high-conf in `bugs.jsonl`, 35 low-conf in `bugs-low-confidence.jsonl`)
**Existing suppressions:** 36 `bugIdentity` matches in `/root/spoonworks/.bughunter/suppressions.json`

---

## Headline numbers

| Metric | Value |
|---|---|
| Total clusters emitted | 77 |
| Real bugs | 6 |
| Known FPs (already in suppressions.json) | 36 |
| New FPs (not yet suppressed) | 35 |
| Out-of-scope | 0 |
| **Overall precision** | **6 / 77 = 7.8 %** |
| **High-confidence precision** | **6 / 42 = 14.3 %** |
| **Low-confidence precision** | **0 / 35 = 0.0 %** |
| Unsuppressed high-conf precision | 6 / 6 = 100 % (after Brad's hand-curated suppressions) |
| Post-suppression yield | 6 real + 35 fp-new = 41 unsuppressed clusters; 6 / 41 = 14.6 % |

The 6 real bugs are all `vulnerable_dependency_high` — confirmed against `npm audit`. Every other emitted cluster (71 / 77 = 92.2 %) is a false positive.

---

## Per-cluster triage

### High-confidence (`bugs.jsonl`, 42 clusters)

| # | kind | conf | sev | rootCause (short) | route/page | classification | reasoning |
|---|------|------|-----|-------------------|------------|----------------|-----------|
| 1 | vulnerable_dependency_high | high | critical | @sentry/nextjs: high vulnerability | (static) | **real-bug** | npm audit confirms `@sentry/nextjs ^8.55.0` → high via `rollup` |
| 2 | vulnerable_dependency_high | high | critical | fast-uri: high vulnerability | (static) | **real-bug** | npm audit confirms (transitive via `ajv` ← `@modelcontextprotocol/sdk`) |
| 3 | vulnerable_dependency_high | high | critical | glob: high vulnerability | (static) | **real-bug** | npm audit confirms (transitive via `@sentry/nextjs` & `react-email`) |
| 4 | vulnerable_dependency_high | high | critical | next: critical vulnerability | (static) | **real-bug** | npm audit confirms `next ^16.2.2` direct dep with critical advisories |
| 5 | vulnerable_dependency_high | high | critical | react-email: high vulnerability | (static) | **real-bug** | npm audit confirms `react-email ^3.0.7` direct dep |
| 6 | vulnerable_dependency_high | high | critical | rollup: high vulnerability | (static) | **real-bug** | npm audit confirms (transitive via `@sentry/nextjs` & `vitest`) |
| 7 | dom_error_text | high | major | "an order has shipped. Once a shipping label is created…" | / | **fp-known** | shipping policy body text; suppression `eecaebda6e1b3a51` |
| 8 | dom_error_text | high | major | "an order has shipped…" | /about | **fp-known** | same policy text; suppression `19b793d9c19c3d7d` |
| 9 | dom_error_text | high | major | "an order has shipped…" | /admin/accounting/cash-flow | **fp-known** | same policy text; suppression `86d55ec2d377e7ad` |
| 10 | dom_error_text | high | major | "an order has shipped…" | /admin/accounting/ledger | **fp-known** | same policy text; suppression `4fc30caca184fad9` |
| 11 | dom_error_text | high | major | "an order has shipped…" | /admin/accounting/new-entry | **fp-known** | same policy text; suppression `7e7d680ccb31f273` |
| 12 | dom_error_text | high | major | "an order has shipped…" | /admin/accounting/pl | **fp-known** | same policy text; suppression `6159b1676b72ef7c` |
| 13 | dom_error_text | high | major | "an order has shipped…" | /admin/accounting/sales-tax | **fp-known** | same policy text; suppression `fa587de1fdf4eb2d` |
| 14 | dom_error_text | high | major | "an order has shipped…" | /admin/alerts/oversell | **fp-known** | same policy text; suppression `0f9e8f3e7b0435b7` |
| 15 | dom_error_text | high | major | "an order has shipped…" | /admin/inventory/batches | **fp-known** | same policy text; suppression `8266126cd97f31c3` |
| 16 | dom_error_text | high | major | "an order has shipped…" | /admin/inventory/ingredients | **fp-known** | same policy text; suppression `76a32bf14e407f2e` |
| 17 | dom_error_text | high | major | "an order has shipped…" | /admin/inventory/products | **fp-known** | same policy text; suppression `aac5f5d47bd8b73f` |
| 18 | dom_error_text | high | major | "an order has shipped…" | /admin/inventory/recipes | **fp-known** | same policy text; suppression `4e3a5132cce6fa75` |
| 19 | dom_error_text | high | major | "an order has shipped…" | /admin/inventory | **fp-known** | same policy text; suppression `5b556de6f366b127` |
| 20 | dom_error_text | high | major | "an order has shipped…" | /admin/login | **fp-known** | same policy text; suppression `371d3831ca916b5a` |
| 21 | dom_error_text | high | major | "an order has shipped…" | /admin/messages | **fp-known** | same policy text; suppression `bde1f5b0143f9690` |
| 22 | dom_error_text | high | major | "an order has shipped…" | /admin/orders | **fp-known** | same policy text; suppression `26a99d2c20cad1c2` |
| 23 | dom_error_text | high | major | "an order has shipped…" | /admin/promo-codes/new | **fp-known** | same policy text; suppression `a8e9357b18006c1e` |
| 24 | dom_error_text | high | major | "an order has shipped…" | /admin/promo-codes | **fp-known** | same policy text; suppression `4822405242fa8083` |
| 25 | dom_error_text | high | major | "an order has shipped…" | /admin/settings | **fp-known** | same policy text; suppression `d93c14038502b9e2` |
| 26 | dom_error_text | high | major | "an order has shipped…" | /admin/tax | **fp-known** | same policy text; suppression `2814f16f3e9c6be3` |
| 27 | dom_error_text | high | major | "an order has shipped…" | /admin | **fp-known** | same policy text; suppression `a08007335f6d04de` |
| 28 | dom_error_text | high | major | "an order has shipped…" | /contact | **fp-known** | same policy text; suppression `9d157b448b3715cd` |
| 29 | dom_error_text | high | major | "an order has shipped…" | /order-confirmation | **fp-known** | same policy text; suppression `af1d9c605b385768` |
| 30 | dom_error_text | high | major | "We will endeavor to address your grievance…" | /policies/privacy | **fp-known** | privacy-policy body text; suppression `b0ee5e2185afc4af` |
| 31 | dom_error_text | high | major | "an order has shipped…" | /policies/returns | **fp-known** | same policy text; suppression `c4009fbe7b06591d` |
| 32 | dom_error_text | high | major | "an order has shipped…" | /policies/terms | **fp-known** | same policy text; suppression `641b520f6b7bc5e9` |
| 33 | dom_error_text | high | major | "an order has shipped…" | /products/ginger-and-seamoss-soap | **fp-known** | same policy text; suppression `336ca3c9d8e75df2` |
| 34 | dom_error_text | high | major | "an order has shipped…" | /products/glacial-marine-clay | **fp-known** | same policy text; suppression `f4085430889e5c94` |
| 35 | dom_error_text | high | major | "an order has shipped…" | /products/tallow-activated-charcoal-beer-soap | **fp-known** | same policy text; suppression `02554a59e1750b75` |
| 36 | dom_error_text | high | major | "an order has shipped…" | /products | **fp-known** | same policy text; suppression `ecd9cb384dbe328b` |
| 37 | missing_state_change | high | major | click on `button:nth-of-type(1)` (header cart) | / | **fp-known** | cart button opens Radix Portal outside observed root; suppression `366b3358962787ef` |
| 38 | missing_state_change | high | major | click on `button[aria-label="Switch to light mode"]` | / | **fp-known** | theme toggle updates `<html class>` outside observed subtree; suppression `e4c8a6f190bfe154` |
| 39 | missing_state_change | high | major | click on `button[aria-label="Switch to dark mode"]` | /admin/messages | **fp-known** | same theme-toggle root-class issue; suppression `f6234ef83ed5909e` |
| 40 | missing_state_change | high | major | submit on `form:nth-of-type(1)` | /contact | **fp-known** | server-action / fetch landing on success view; mutation window too short; suppression `bded3ed05d77a214` |
| 41 | missing_state_change | high | major | click on `button[aria-label="View image 1"]` | /products/tallow-… | **fp-known** | gallery thumb 1 = activeIndex 0 (already selected); no observable change is *intentional*; suppression `50aac3d14096765e` |
| 42 | xss_reflected | high | critical | nonce `50f6dec652e5b939` appeared as `reflected_script` | /contact | **fp-known** | nonce found inside `<input value="<script>…">` — attribute reflection, not executable JS; suppression `8d646f1f89570259` |

### Low-confidence (`bugs-low-confidence.jsonl`, 35 clusters)

#### `network_4xx_unexpected` (15 — all 422)

All 15 are POST/PUT to API routes where BugHunter's happy-palette fuzzer sent placeholder strings like `{"name":"test value","description":"test value","category":"test value"}`. Every spoonworks route uses `zod.safeParse(body)` and returns 422 with `parsed.error.flatten()` on validation failure. 422 is the correct, intentional response for malformed input — not a bug.

| # | kind | conf | sev | rootCause | tool | classification | reasoning |
|---|------|------|-----|-----------|------|----------------|-----------|
| 43 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_products | **fp-new** | `category` enum rejection; route returns 422 by design |
| 44 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_products_id_adjust-stock | **fp-new** | adjust-stock schema requires numeric `quantity`; fuzz sent strings |
| 45 | network_4xx_unexpected | low | unset | 422 from POST | post_api_checkout_session | **fp-new** | `items: "test value"` fails `z.array(...).min(1)`; 422 by design |
| 46 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_orders_id_shipping_return | **fp-new** | `labelFormat` enum + missing order context; 422 by design |
| 47 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_tax-deadlines | **fp-new** | `year`/`quarter` numeric schema; 422 by design |
| 48 | network_4xx_unexpected | low | unset | 422 from POST | post_api_contact | **fp-new** | `email: "test value"` fails `z.string().email()`; 422 by design |
| 49 | network_4xx_unexpected | low | unset | 422 from POST | post_api_checkout_validate-promo | **fp-new** | `subtotalCents` integer schema; 422 by design |
| 50 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_ingredients_id_restock | **fp-new** | numeric fields fail string-input fuzz; 422 by design |
| 51 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_promo-codes | **fp-new** | `discountType` enum + numeric value; 422 by design |
| 52 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_orders_id_shipping_rates | **fp-new** | numeric+enum schema; 422 by design |
| 53 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_ingredients | **fp-new** | `unit` enum + numeric `costPerUnit`; 422 by design |
| 54 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_batches | **fp-new** | `productId` must be real Prisma id + numeric qty; 422 by design |
| 55 | network_4xx_unexpected | low | unset | 422 from PUT | put_api_admin_shipping_settings | **fp-new** | EasyPost-compatible address schema; 422 by design |
| 56 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_orders_id_shipping_buy | **fp-new** | EasyPost rate-id + numeric cents; 422 by design |
| 57 | network_4xx_unexpected | low | unset | 422 from POST | post_api_admin_tax-deadlines_generate | **fp-new** | numeric `year`; 422 by design |

#### `surface_call_failed` (20 — all 404)

All 20 are API calls dispatched to literal template URLs (`/api/admin/orders/:id`, `/api/admin/products/:id`, …) where `:id` / `:productId` / `:index` were never substituted. The 404s are because no Prisma row has the literal string `":id"` as a primary key. The infra is working correctly; BugHunter (or its SurfaceMCP catalogue) is mis-driving it. `state.json` shows `discoveryFixtures` were configured for the UI side (`/products/[slug]` etc.) but the API surface had no fixture-substitution table.

| # | kind | conf | sev | rootCause | tool | classification | reasoning |
|---|------|------|-----|-----------|------|----------------|-----------|
| 58 | surface_call_failed | low | unset | 404 from GET | get_api_admin_orders_id | **fp-new** | URL kept literal `:id`; Prisma findUnique returns null → 404 by design |
| 59 | surface_call_failed | low | unset | 404 from PUT | put_api_admin_promo-codes_id | **fp-new** | same template-URL issue |
| 60 | surface_call_failed | low | unset | 404 from DELETE | delete_api_admin_products_id_images_index | **fp-new** | `:id` + `:index` both unsubstituted |
| 61 | surface_call_failed | low | unset | 404 from GET | get_api_admin_products_id | **fp-new** | template-URL issue |
| 62 | surface_call_failed | low | unset | 404 from POST | post_api_admin_products_id_images | **fp-new** | template-URL issue |
| 63 | surface_call_failed | low | unset | 404 from GET | get_api_admin_promo-codes_id | **fp-new** | template-URL issue |
| 64 | surface_call_failed | low | unset | 404 from GET | get_api_admin_batches_id | **fp-new** | template-URL issue |
| 65 | surface_call_failed | low | unset | 404 from GET | get_api_admin_promo-codes_id_stats | **fp-new** | template-URL issue |
| 66 | surface_call_failed | low | unset | 404 from POST | post_api_admin_shipping_labels_id_void | **fp-new** | template-URL issue |
| 67 | surface_call_failed | low | unset | 404 from GET | get_api_admin_shipping_labels_id_download | **fp-new** | template-URL issue |
| 68 | surface_call_failed | low | unset | 404 from DELETE | delete_api_admin_ingredients_id | **fp-new** | template-URL issue |
| 69 | surface_call_failed | low | unset | 404 from PUT | put_api_admin_products_id | **fp-new** | template-URL issue |
| 70 | surface_call_failed | low | unset | 404 from DELETE | delete_api_admin_products_id | **fp-new** | template-URL issue |
| 71 | surface_call_failed | low | unset | 404 from DELETE | delete_api_admin_promo-codes_id | **fp-new** | template-URL issue |
| 72 | surface_call_failed | low | unset | 404 from PUT | put_api_admin_ingredients_id | **fp-new** | template-URL issue |
| 73 | surface_call_failed | low | unset | 404 from GET | get_api_admin_recipes_productId | **fp-new** | template-URL issue (`:productId` unsubstituted) |
| 74 | surface_call_failed | low | unset | 404 from POST | post_api_admin_alerts_oversell_id_resolve | **fp-new** | template-URL issue |
| 75 | surface_call_failed | low | unset | 404 from GET | get_api_admin_ingredients_id | **fp-new** | template-URL issue |
| 76 | surface_call_failed | low | unset | 404 from POST | post_api_admin_tax-deadlines_id_pay | **fp-new** | template-URL issue |
| 77 | surface_call_failed | low | unset | 404 from PUT | put_api_admin_recipes_productId | **fp-new** | template-URL issue |

---

## Real-bug detail: `vulnerable_dependency_high`

All 6 are confirmed by `npm audit --json` (run 2026-05-13):

| package | severity | direct? | parent chain |
|---|---|---|---|
| `@sentry/nextjs` 8.55.1 | high | yes | direct → `rollup` advisory |
| `next` 16.2.2 | critical | yes | direct → multiple Next.js advisories |
| `react-email` 3.0.7 | high | yes | direct → `esbuild`, `glob`, `next` |
| `fast-uri` 3.1.0 | high | no | `@modelcontextprotocol/sdk` → `ajv-formats` → `ajv` |
| `glob` 9.3.5 / 10.3.4 | high | no | `@sentry/nextjs` & `react-email` |
| `rollup` 3.29.5 / 4.60.1 | high | no | `@sentry/nextjs` & `vitest` |

Actionable as a unit (`npm audit fix`, then bump direct deps) but **transitive packages have redundant clusters per parent** — BugHunter emits one cluster per package name, not per dependency-tree position. This is OK for action; not OK for cluster count. Recommend either (a) dedupe by signature or (b) collapse-into-direct-dep with chain in `fixHints`.

---

## Recall framing — kinds detected, kinds likely missed

BugHunter wired 59 detectors that observed input in this run, but only 4 emitted clusters. The rest (visual anomaly, accessibility, performance, race conditions, SEO, …) saw input but emitted nothing — either because spoonworks is genuinely clean on those axes, or because the detectors didn't see what they needed.

| kind | clusters emitted | real bugs found | likely-caught vs missed | reasoning |
|---|---|---|---|---|
| `vulnerable_dependency_high` | 6 | 6 | **likely caught most** | static `npm audit` parse; same answer as direct `npm audit`. Caveat: 4 of 6 are transitive — no dedup |
| `dom_error_text` | 30 | 0 | **caught zero real ones; likely no real ones to catch** | spoonworks pages are static & policy-heavy; the heuristic matches policy text as "error". Genuine in-page error banners are styled with `role="alert"` (e.g. contact `<p class="bg-red-50">…`) and weren't matched |
| `missing_state_change` | 5 | 0 | **likely missed many** | mutation observer doesn't watch `<html>` class swap, Portal-rendered content, or server-action redirects. Genuine missing-state-change bugs (e.g. broken cart-add, broken admin save) would not have been caught either |
| `xss_reflected` | 1 | 0 | **likely caught zero real ones** | the only firing cluster matched on attribute reflection; React's JSX escaping plus zod input rejection means real reflected XSS in spoonworks is highly unlikely |
| `network_4xx_unexpected` | 15 | 0 | **caught zero; likely missed legitimate 4xx misfires** | every emitted cluster is a 422 from happy-path fuzz; an authenticated user accidentally triggering an unhandled 400/404/409 on a working button would not be in this list |
| `surface_call_failed` | 20 | 0 | **caught zero; can't measure recall** | path-template bug means none of the *real* admin endpoints were exercised; we don't know whether any of them would have surfaced bugs |
| **detectors that saw input but emitted nothing** (55 total) | 0 | 0 | **unknown** | clean run is plausible but unverified; needs targeted fixture probes |
| **detectors with `input-absent`** (68 total) | 0 | 0 | n/a | infrastructure for race/perf/a11y/i18n probes didn't activate on this target — these were `enableA11y:false`, `enableNavState:false` per `state.json`. Re-running with them on might unlock 30+ more detectors |

**Summary:** Of 4 kinds that emitted clusters, only `vulnerable_dependency_high` produced real bugs. The other 3 (`dom_error_text`, `missing_state_change`, `xss_reflected`) had 100 % FP rate. The `network_4xx_unexpected` and `surface_call_failed` detectors are fundamentally mis-driving the system on this target (sending invalid inputs to happy paths; sending un-substituted templates). Bench recall on the kinds BugHunter is *aimed* at is unmeasured here — we caught one category (vuln deps) and missed everything else by virtue of not actually exercising the real surface area.

---

## FP categories observed

Grouping the 35 `fp-new` clusters by reasoning (each group = one suppression-rule candidate):

### FP-Category A — Happy-path fuzz with placeholder strings triggers schema 422s (15 clusters)

**Pattern:** `network_4xx_unexpected` where response is **422 with `parsed.error.flatten()`** in the body, and request body contains the literal string `"test value"`.

**Why it's an FP:** Zod-style schema rejection is the *intended* response to invalid input. A 422 from happy-fuzz against a typed input is "input contract working as designed."

**Suppression-rule candidate:**
- Treat HTTP **422** as expected-failure for any happy-palette fuzz when the response body matches `{"error": {fieldErrors|formErrors}}` (zod flatten shape) — or, more broadly, when *all* happy-fuzz inputs to the same endpoint produce the same status.
- Alternatively: only emit `network_4xx_unexpected` for **400/500/502/503**, never 422 (422 is "unprocessable entity" — semantically "your input is invalid", not "server bug").

### FP-Category B — Unsubstituted `:id`-template URLs hit 404 (20 clusters)

**Pattern:** `surface_call_failed` where `action.url` contains a literal `:id`, `:productId`, `:index`, etc. The Prisma lookup for that literal returns null → API returns 404.

**Why it's an FP:** The 404 is correct behaviour. The bug is in the *driver*, not the target.

**Suppression-rule candidate:**
- Detector should **not file** when the request URL contains an `:id`-style placeholder segment. Treat as **infrastructure failure** instead (matches the existing `browser_element_not_found` infra-failure pattern in `infrastructure.jsonl`).
- Independent fix: extend `discoveryFixtures` substitution to API surface URLs, not just UI routes — the run config had `cmo8njs7x002r6ksdr062vvvp` etc. listed for `/admin/inventory/products/[id]` but they weren't applied to `get_api_admin_products_id` calls.

### FP-Category C — Policy / body text matches "error" word stems (30 clusters, ALL fp-known)

**Pattern:** `dom_error_text` matching strings like `"an order has shipped. Once a shipping label is created, we are unable to redirect…"` or `"We will endeavor to address your grievance within a reasonable period"`.

**Why it's an FP:** These are paragraph text on `/policies/shipping`, `/policies/privacy`, `/policies/returns`, `/policies/terms`. The detector is matching on word stems like "unable", "endeavor", "grievance" — none of which indicate an actual error UI.

**Suppression-rule candidate (already applied per-cluster; should be promoted to detector logic):**
- Exclude DOM text that appears under a `<main>` / `<article>` containing more than N consecutive `<p>` tags (= a body content page).
- Exclude DOM text on routes matching `/policies/*`, `/legal/*`, `/terms*`, `/privacy*`, `/about*`.
- Require the matched text to be inside an element with one of: `role="alert"`, `role="status"`, `aria-live`, classnames containing `error`/`alert`/`danger`, or attribute `data-error`. Plain paragraph text in a content page is not an error indicator.

### FP-Category D — Mutation observer too narrow to catch real state changes (5 clusters, ALL fp-known)

**Pattern:** `missing_state_change` on theme toggle (mutates `<html class>`), Radix Portal mounts (cart drawer outside subtree), server-action form submit (redirect / out-of-tree mutation), and gallery thumb 1 (idempotent — already active).

**Why it's an FP:** The DOM *did* change, just not where the observer was watching.

**Suppression-rule candidate (more like detector improvements):**
- Watch `<html>` and `<body>` class/attribute mutations explicitly for theme-style toggles.
- Watch all attached `Portal` roots, not just the active page subtree.
- For form submits: also watch URL changes, document.title, and the network response (HAR delta).
- For thumb-1-already-active style buttons: detect `aria-pressed` mismatch in pre-state vs post-state, OR require a *different* selector to be clicked before re-firing on the same one.

### FP-Category E — Input-attribute reflection misclassified as reflected XSS (1 cluster, fp-known)

**Pattern:** `xss_reflected` matching nonce `50f6dec652e5b939` in `<input value="<script>…">`. The script string is preserved in the input's *value attribute*, not as executable script. React's JSX escaping and the browser's attribute parsing mean this cannot execute.

**Why it's an FP:** Nonce-canary detector is checking presence of nonce string in the rendered DOM but not whether the position is execution-capable.

**Suppression-rule candidate:**
- Reflected XSS detector must verify the nonce reflection is **outside** of: input `value` attribute, textarea text content, contenteditable inert text, JSON-encoded strings in `<script type="application/json">` blocks, or alt/title attribute. Only emit if the nonce ends up in: an inline `<script>` body, an `on*` event handler, an inline `style` `expression()`, or an `href="javascript:"` URL.
- Cheaper signal: confirm `window.__bh_xss_<nonce>` is actually set after navigation — i.e. did the payload execute? The current detector finds the string but doesn't verify execution.

### FP-Category F — Transitive vulnerable deps emitted as separate clusters (informational, not a true FP)

**Pattern:** `glob`, `rollup`, `fast-uri` are reported as independent vuln_dep clusters when they are transitive deps of `next`, `@sentry/nextjs`, `react-email`, `vitest`. Fixing the parent often resolves all transitives.

**Suppression-rule candidate (or detector improvement):**
- Compute `npm ls <pkg>` parent chains during the run. If a vulnerable transitive's parent is also flagged, collapse the child into the parent's `fixHints` and don't emit a separate cluster.
- If the transitive is reachable from *unflagged* parents only (e.g. `fast-uri` via `@modelcontextprotocol/sdk` which itself has no advisories), keep it as its own cluster.

---

## Recommended actions (detector-side)

Ranked by likely impact on real-app precision:

1. **`dom_error_text`: require error-indicator container.** Match only inside elements with `role="alert"`, `role="status"`, `aria-live`, or classnames matching `/\b(error|alert|danger|warning|toast)\b/i`. Skip routes under `/policies/*`, `/legal/*`, `/terms*`, `/privacy*`. Spoonworks alone got 30 FPs from one heuristic; this fix would have caught all 30. Brad already hand-suppressed every single one — the rule is obvious.

2. **`network_4xx_unexpected`: never fire on 422 from happy-fuzz.** 422 = "your input doesn't match the schema." Sending `"test value"` strings to typed inputs intentionally produces this. Either (a) drop 422 from the "unexpected" set entirely for happy palette, or (b) only fire if *some* happy-path inputs succeed and others fail (asymmetric behaviour signals a bug). All 15 low-conf network 4xx clusters are this exact pattern.

3. **`surface_call_failed`: refuse to send to template URLs.** Pre-flight every API request and reject if the URL still contains `:foo` placeholder segments — emit `infrastructure_failure: unsubstituted_path_param` to `infrastructure.jsonl` instead. Independently, extend the `discoveryFixtures` substitution table to API tool URLs (it currently only fires for UI navigation). All 20 low-conf surface-call clusters fall to this fix.

4. **`xss_reflected`: confirm execution, not just reflection.** Either verify `window.__bh_xss_<nonce>` is set post-action, or only emit when the reflection is inside an executable context (inline `<script>` body, event-handler attribute, `javascript:` URL). Attribute reflection in `<input value>` and text content is not exploitable. Single FP in this run, but high-conf critical → severe noise per cluster.

5. **`missing_state_change`: broaden the observer scope.** Watch `<html>`/`<body>` mutations (theme), Portal roots (Radix/HeadlessUI cart drawer), URL/title (server-action redirect), and HAR network deltas. Also: skip when post-state `aria-pressed` matches pre-state — the action was already in the "on" state, so producing no change is intentional.

6. **`vulnerable_dependency_high`: dedupe transitives against direct-dep parents.** Run `npm ls <pkg> --json` and collapse transitive vuln packages into their direct-dep parent's `fixHints`. Reduces 6-cluster spoonworks finding to 3 (next, @sentry/nextjs, react-email) without losing any info — and the fix command (`npm audit fix`) is the same.

7. **(Smaller) Add `route` field to vuln-dep occurrences.** Coverage report shows `route=?` and `selector=?`. Page/selector is meaningless for static deps; use `static` literal in `page` and `package:<name>` in selector for grep-ability.

8. **Re-run with `enableA11y:true` and `enableNavState:true`.** 68 of 127 wired detectors were `input-absent` because their probes weren't activated. The current spoonworks run has no signal at all on accessibility, race conditions, performance, or nav-state, so we cannot claim the app is clean on those axes.

---

## Cross-run context

`summary.json.crossRun` reports:
- previousRunId: `f3cr9tog2yb95t3ko77ichxs`
- newBugs: 4
- persistent: 38
- goneSinceLast: 7
- regressed: 0

So this is the *second* run on spoonworks; 38 of the 42 high-conf clusters have persisted across runs without action, and only 4 are new since last time. 7 went away (likely Brad's per-cluster suppression entries). Cross-run stability is fine; the volume of persistent suppressed FPs suggests suppression-by-rule (FP-Categories A–E) would replace 35–36 per-cluster suppression entries with five reusable rules.

---

## Artifacts referenced

- Run dir: `/root/spoonworks/.bughunter/runs/yg0qspnwqe8egeqdv7rrsd9l/`
- Suppressions: `/root/spoonworks/.bughunter/suppressions.json` (36 entries)
- npm audit verified 2026-05-13 in `/root/spoonworks`
- Spec for spoonworks under audit: `/root/spoonworks/SPEC.md`, `SPEC_ADDENDUM.md`
- Key code paths inspected:
  - `/root/spoonworks/app/api/contact/route.ts` — zod 422 example
  - `/root/spoonworks/app/api/admin/products/route.ts` — zod 422 example
  - `/root/spoonworks/app/api/admin/orders/[id]/route.ts` — `:id` 404 example
  - `/root/spoonworks/app/contact/page.tsx` — xss reflection context
  - `/root/spoonworks/components/storefront/ProductImageGallery.tsx` — gallery state change
