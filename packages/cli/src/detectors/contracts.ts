// V56: Per-detector contract type system.
// One DetectorContract per wired BugKind that has harness: true in DETECTOR_REGISTRY.
// DETECTOR_CONTRACTS is empty in V56.1 — populated incrementally in V56.2+.

import type { BugKind } from '../types.js';

/** Phases the harness will run for this detector. Must be a subset of the existing phase set. */
export type RequiredPhase =
  | 'validate'
  | 'discover'
  | 'plan'
  | 'execute'
  | 'classify'
  | 'cluster'
  | 'emit';

/** Tools the executor needs available. Used to gate execution if absent. */
export type RequiredTool = 'browser-mcp' | 'surface-mcp' | 'cdp' | 'static-analysis';

/** Surface scoping. */
export type RequiredSurface = 'web' | 'api' | 'static-source';

/** What auth shape the detector needs to do its work. */
export type RequiredRole =
  | { kind: 'none' }
  | { kind: 'any-authenticated' }
  | { kind: 'specific'; roles: string[] };

/** What page context the detector needs (parallel to RequiredSurface but at finer grain). */
export type RequiredPageContext =
  | { kind: 'any-route' }
  | { kind: 'route-pattern'; pattern: string }
  | { kind: 'specific-routes'; routes: string[] };

/** Input contract the harness checks before running. */
export type DetectorRequires = {
  phases: RequiredPhase[];
  tools: RequiredTool[];
  surface: RequiredSurface;
  role: RequiredRole;
  pageContext: RequiredPageContext;
  /**
   * V56.4: settle time in ms after the bootstrap script installs but before the
   * browser harness reads the harvest envelope. Default 1500ms. Perf detectors
   * that wait for LCP / INP may set 3000–5000ms. Capped at defaultBudgetMs / 4.
   * Ignored by the static-fixture runner.
   */
  observationWindowMs?: number;
};

/** Cluster assertion line (one entry in expected-clusters.jsonl). */
export type ClusterAssertion =
  | {
      kind: BugKind;
      expect: 'fires';
      minClusterSize: number;
      match: { page?: string; role?: string; signaturePrefix?: string };
      severity: 'critical' | 'major' | 'minor' | 'info';
      /** Optional label for edge-case variants (e.g. "shell-metachar-direct", "command-substitution"). */
      edgeLabel?: string;
    }
  | {
      kind: BugKind;
      expect: 'silent';
      reason: string;
      match?: { page?: string; role?: string };
      /** Optional label for edge-case variants. */
      edgeLabel?: string;
    }
  | {
      /** Harness skips this assertion when the fixture is unreachable or a precondition is unmet. */
      kind: BugKind;
      expect: 'skipped';
      reason:
        | 'fixture_unreachable'
        | 'insufficient_roles'
        | 'missing_tool'
        | 'missing_surface'
        | 'no_response'
        | 'fixture_not_built'
        // V56.4: browser-harness-specific skip reasons
        | 'browser_mcp_unavailable'
        | 'camofox_tab_failure'
        | 'observation_window_exceeded';
    };

/** Fixture pointer for this detector. May be shared across N detectors. */
export type DetectorFixture = {
  /** Relative path under fixtures/detector-calibration/, e.g. "xss-mini" or shared "v21-idor-mini". */
  path: string;
  /** Which kinds this fixture serves. The harness asserts every kind appears in the fixture's
   *  expected-clusters.jsonl as either a 'fires' or 'silent' line. */
  servesKinds: BugKind[];
};

/** The contract. One per wired BugKind. Linked from DETECTOR_REGISTRY via the `harness` field. */
export type DetectorContract = {
  kind: BugKind;
  requires: DetectorRequires;
  fixture: DetectorFixture;
  /** Default budget for a single-detector run against this fixture (ms). Tier 1 hard cap is 30_000. */
  defaultBudgetMs: number;
  /** Human-readable note (one sentence). What this detector watches for. */
  note: string;
};

/** Frozen registry of contracts. Lockstep test enforces 1:1 with `harness: true` rows in DETECTOR_REGISTRY.
 *  V56.1 ships empty — V56.2 populates the first 10 detectors. */
export const DETECTOR_CONTRACTS: ReadonlyArray<DetectorContract> = [
  {
    kind: 'sensitive_data_in_url',
    requires: {
      phases: ['discover', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'sensitive-data-url-mini',
      servesKinds: ['sensitive_data_in_url'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects sensitive parameters (token, api_key, password, etc.) present in observed URLs during crawl.',
  },
  {
    kind: 'hardcoded_credentials_in_source',
    requires: {
      phases: ['execute', 'classify', 'cluster'],
      tools: ['static-analysis'],
      surface: 'static-source',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'hardcoded-creds-mini',
      servesKinds: ['hardcoded_credentials_in_source'],
    },
    defaultBudgetMs: 30_000,
    note: 'Runs gitleaks against the target source tree to detect hardcoded secrets and API keys.',
  },
  {
    kind: 'path_traversal',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'path-traversal-mini',
      servesKinds: ['path_traversal'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects file read via unsanitized user-controlled path segments (route param and query-string variants).',
  },
  {
    kind: 'missing_csp_header',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'csp-mini',
      servesKinds: ['missing_csp_header'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects absence of enforced Content-Security-Policy header (including routes that only set CSP-Report-Only).',
  },
  {
    kind: 'xss_reflected',
    requires: {
      phases: ['validate', 'discover', 'plan', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'xss-mini',
      servesKinds: ['xss_reflected'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects reflected XSS by injecting payloads into GET params and POST bodies and observing unescaped reflection in HTML responses.',
  },
  {
    kind: 'sql_injection',
    requires: {
      phases: ['validate', 'discover', 'plan', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'sqli-mini',
      servesKinds: ['sql_injection'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects SQL injection by sending error-eliciting payloads and observing database error messages or anomalous response behaviour.',
  },
  {
    kind: 'idor_horizontal_read',
    requires: {
      phases: ['discover', 'plan', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'specific', roles: ['alice', 'bob'] },
      pageContext: { kind: 'specific-routes', routes: ['/api/orders/:id', '/api/users/:id/profile', '/api/orders/uuid/:id', '/api/orders/protected/:id'] },
    },
    fixture: {
      path: 'idor-mini',
      servesKinds: ['idor_horizontal_read'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects read-only IDOR: authenticated user reads another user\'s resource without a 403 (bearer-token auth, 2 seed roles).',
  },
  {
    kind: 'command_injection',
    requires: {
      phases: ['plan', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'specific-routes', routes: ['/api/admin/health', '/api/admin/health-safe'] },
    },
    fixture: {
      path: 'command-injection-mini',
      servesKinds: ['command_injection'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects shell string concatenation via nonce echo-back; /api/admin/health-safe uses execFile and must stay silent.',
  },
  {
    kind: 'vulnerable_dependency_high',
    requires: {
      phases: ['execute', 'classify', 'cluster'],
      tools: ['static-analysis'],
      surface: 'static-source',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'vuln-dep-mini',
      servesKinds: ['vulnerable_dependency_high'],
    },
    defaultBudgetMs: 30_000,
    note: 'Runs npm audit against the target package.json to detect high/critical severity CVE advisories.',
  },
  {
    kind: 'auth_bypass_via_unauthed_route',
    requires: {
      phases: ['discover', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'specific', roles: ['anonymous', 'admin'] },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'auth-bypass-mini',
      servesKinds: ['auth_bypass_via_unauthed_route'],
    },
    defaultBudgetMs: 30_000,
    note: 'Replays API routes as anonymous to detect endpoints that should require auth but return 200 with non-empty bodies.',
  },
  {
    kind: 'seo_title_missing',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_title_missing'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects HTML pages with no <title> element or empty/whitespace-only title text.',
  },
  {
    kind: 'seo_meta_description_missing',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_meta_description_missing'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects HTML pages with no <meta name="description"> element or empty/whitespace content attribute.',
  },
  {
    kind: 'seo_canonical_missing',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_canonical_missing'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects HTML pages without <link rel="canonical"> when at least one other page in the corpus has one.',
  },
  {
    kind: 'seo_h1_missing_or_multiple',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_h1_missing_or_multiple'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects HTML pages with zero or multiple <h1> elements. Exactly one is required for proper page hierarchy.',
  },
  {
    kind: 'seo_robots_blocking_crawl',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_robots_blocking_crawl'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects pages disagreeing with crawl policy: meta name="robots" noindex on a crawled page, or robots.txt Disallow:/ blocking the homepage.',
  },
  {
    kind: 'seo_title_duplicate_across_routes',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'seo-mini',
      servesKinds: ['seo_title_duplicate_across_routes'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects ≥2 distinct routes that share the same (case-insensitive, trim-normalised) <title> text.',
  },
  {
    kind: 'image_missing_alt',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'a11y-mini',
      servesKinds: ['image_missing_alt'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects <img> elements lacking an accessible name (no alt, no aria-label, no aria-labelledby). alt="" is allowed (decorative-image convention).',
  },
  {
    kind: 'form_input_unlabeled',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'a11y-mini',
      servesKinds: ['form_input_unlabeled'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects <input> elements without an associated label (for-attribute, wrapped <label>, aria-label, aria-labelledby, or title). type=hidden and submit/button/reset with value are skipped.',
  },
  {
    kind: 'interactive_element_missing_accessible_name',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'a11y-mini',
      servesKinds: ['interactive_element_missing_accessible_name'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects <button> and <a href> elements with no accessible name (empty text content and no aria-label, aria-labelledby, title, or <img alt> inside).',
  },
  {
    kind: 'i18n_hardcoded_string',
    requires: {
      phases: ['execute', 'classify', 'cluster'],
      tools: ['static-analysis'],
      surface: 'static-source',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'i18n-hardcoded-strings-mini',
      servesKinds: ['i18n_hardcoded_string'],
    },
    defaultBudgetMs: 30_000,
    note: 'Runs the heuristic hardcoded-string scanner against the fixture\'s generated source tree. Detects user-facing strings not wrapped in t() / <Trans>.',
  },
  {
    kind: 'permissive_cors',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'cors-mini',
      servesKinds: ['permissive_cors'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects routes returning Access-Control-Allow-Origin: * combined with Access-Control-Allow-Credentials: true — credentialed wildcard CORS exposes session data to any origin.',
  },
  {
    kind: 'cookie_security_flags',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'cookie-flags-mini',
      servesKinds: ['cookie_security_flags'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects session-shaped Set-Cookie values missing Secure / HttpOnly / SameSite flags. CSRF cookies are exempt from HttpOnly check; Secure check skipped on localhost.',
  },
  {
    kind: 'stack_trace_leak_in_response',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'stack-trace-leak-mini',
      servesKinds: ['stack_trace_leak_in_response'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects 5xx responses whose body matches Error/at-frame patterns indicative of a leaked server-side stack trace.',
  },
  {
    kind: 'open_redirect',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'open-redirect-mini',
      servesKinds: ['open_redirect'],
    },
    defaultBudgetMs: 30_000,
    note: 'Probes routes with redirect-param synonyms (?redirect=, ?next=, ?return_to=, etc.) pointed at evil.test. Fires when a 3xx Location header echoes the attacker-controlled URL.',
  },
  {
    kind: 'csrf_missing_on_mutating_route',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'csrf-missing-mini',
      servesKinds: ['csrf_missing_on_mutating_route'],
    },
    defaultBudgetMs: 30_000,
    note: 'Probes mutating routes (POST/PUT/PATCH/DELETE) with cookie/header/auth contexts. Fires when no CSRF token is present and detector exemptions (Bearer auth, SameSite=Strict on session cookie) do not apply.',
  },
  {
    kind: '404_for_linked_route',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'linked-404-mini',
      servesKinds: ['404_for_linked_route'],
    },
    defaultBudgetMs: 30_000,
    note: 'Extracts internal <a href="/path"> links from each page, probes each, fires per page with ≥1 broken link.',
  },
  {
    kind: 'network_5xx',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'network-status-mini',
      servesKinds: ['network_5xx'],
    },
    defaultBudgetMs: 30_000,
    note: 'Probes each route, fires when status >= 500 or status === 0 (connectivity failure).',
  },
  {
    kind: 'network_4xx_unexpected',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'network-status-mini',
      servesKinds: ['network_4xx_unexpected'],
    },
    defaultBudgetMs: 30_000,
    note: 'Probes each route, fires on 4xx status. Expected-vs-unexpected distinction is encoded in the fixture\'s expected-clusters.jsonl per route.',
  },
  {
    kind: 'subresource_integrity_violation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'browser-platform-headers-mini',
      servesKinds: ['subresource_integrity_violation'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness path. Scans response HTML for external <script src> / <link rel=stylesheet href> elements without an integrity attribute. (Production path uses runtime browser observation.)',
  },
  {
    kind: 'coop_coep_violation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'browser-platform-headers-mini',
      servesKinds: ['coop_coep_violation'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Detects pages with `new SharedArrayBuffer(...)` instantiation that lack COOP: same-origin + COEP: require-corp / credentialless headers.',
  },
  {
    kind: 'trusted_types_violation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'browser-platform-headers-mini',
      servesKinds: ['trusted_types_violation'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Detects CSP that has `require-trusted-types-for` directive but no `trusted-types <policy>` declaration — every DOM-XSS sink will throw at runtime.',
  },
  {
    kind: 'iframe_postmessage_unguarded',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'script-checks-mini',
      servesKinds: ['iframe_postmessage_unguarded'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Scans response HTML for window.addEventListener("message", ...) handlers that do not check event.origin.',
  },
  {
    kind: 'xss_dom',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'script-checks-mini',
      servesKinds: ['xss_dom'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Scans response HTML for DOM XSS sinks (innerHTML, document.write, etc.) assigning non-literal values.',
  },
  {
    kind: 'swallowed_error_empty_catch',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'script-checks-mini',
      servesKinds: ['swallowed_error_empty_catch'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Scans response HTML for empty catch (e) {} blocks that silently swallow errors.',
  },
  {
    kind: 'jwt_weak_alg',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'script-checks-mini',
      servesKinds: ['jwt_weak_alg'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Decodes JWT-shaped tokens found in response bodies and fires when alg is "none" or HS-family symmetric.',
  },
  {
    kind: 'no_rate_limit_on_login',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'rate-limit-mini',
      servesKinds: ['no_rate_limit_on_login'],
    },
    defaultBudgetMs: 30_000,
    note: 'Sends N bogus-credential POSTs to each login route. Fires when no 429/423 status is observed within the cap (15).',
  },
  {
    kind: 'i18n_date_format_ambiguous',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'i18n-text-checks-mini',
      servesKinds: ['i18n_date_format_ambiguous'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires when response body contains ambiguous slash-separated date (MM/DD/YYYY or DD/MM/YYYY) without an ISO 8601 or month-name disambiguator.',
  },
  {
    kind: 'i18n_pluralization_broken',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'i18n-text-checks-mini',
      servesKinds: ['i18n_pluralization_broken'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires on "1 <plural-noun>" patterns where the noun ends in s but is not a known singular-s noun (boss, glass, etc.).',
  },
  {
    kind: 'i18n_currency_format_broken',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'i18n-text-checks-mini',
      servesKinds: ['i18n_currency_format_broken'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires when currency-amount string ($USD/€EUR/£GBP/¥JPY) renders with decimals not matching the currency convention (USD/EUR/GBP=2; JPY=0).',
  },
  {
    kind: 'hallucinated_route',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'hallucinated-route-mini',
      servesKinds: ['hallucinated_route'],
    },
    defaultBudgetMs: 30_000,
    note: 'Fetches /sitemap.xml, probes each <loc>-claimed route, fires when a claimed route returns 404.',
  },
  {
    kind: 'cache_staleness',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'cache-staleness-mini',
      servesKinds: ['cache_staleness'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires on JSON API responses (Content-Type: application/json) with Cache-Control max-age >60s and no must-revalidate / no-cache / private directive — high stale-data risk.',
  },
  {
    kind: 'money_math_precision',
    requires: {
      phases: ['execute', 'classify', 'cluster'],
      tools: ['static-analysis'],
      surface: 'static-source',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'money-math-mini',
      servesKinds: ['money_math_precision'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-source scanner. Fires on parseFloat(...money...) and float arithmetic ops (* / +) on money-named identifiers (price, amount, total, refund, etc.). Skips identifiers ending in cents/bps and Decimal usage.',
  },
  {
    kind: 'audit_log_missing_for_mutation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'audit-log-mini',
      servesKinds: ['audit_log_missing_for_mutation'],
    },
    defaultBudgetMs: 30_000,
    note: 'Per-route test plan controls method. For each mutating route, GETs /audit/recent before and after; fires when audit-log size does not increase post-mutation.',
  },
  {
    kind: 'data_integrity_orphan',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'data-integrity-mini',
      servesKinds: ['data_integrity_orphan'],
    },
    defaultBudgetMs: 30_000,
    note: 'Triggers a parent-delete mutation, then GETs the parent\'s read endpoint and fires when the response includes orphans[] with length > 0.',
  },
  {
    kind: 'soft_delete_consistency',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'data-integrity-mini',
      servesKinds: ['soft_delete_consistency'],
    },
    defaultBudgetMs: 30_000,
    note: 'Triggers a soft-delete mutation, then GETs the corresponding /list endpoint; fires when the response still contains items whose deletedAt is set.',
  },
  {
    kind: 'auth_session_fixation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'session-fixation-mini',
      servesKinds: ['auth_session_fixation'],
    },
    defaultBudgetMs: 30_000,
    note: 'Two-step probe: GET login route (pre-login cookie), POST creds (post-login cookie). Fires when the primary session cookie value is unchanged across the login boundary.',
  },
  {
    kind: 'password_reset_token_reuse',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'password-reset-mini',
      servesKinds: ['password_reset_token_reuse'],
    },
    defaultBudgetMs: 30_000,
    note: 'Three-step probe per /<route>/consume endpoint: request → consume → consume. Fires when the second consume succeeds (status 2xx, body not flagged as failure).',
  },
  {
    kind: 'touch_target_too_small',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'css-heuristics-mini',
      servesKinds: ['touch_target_too_small'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires when <button>/<a> has inline style width or height <24px (axe target-size minimum).',
  },
  {
    kind: 'hover_only_affordance',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'css-heuristics-mini',
      servesKinds: ['hover_only_affordance'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires when CSS has :hover rules without a corresponding :focus / :focus-visible — keyboard-only users miss the affordance.',
  },
  {
    kind: 'i18n_long_string_overflow',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'css-heuristics-mini',
      servesKinds: ['i18n_long_string_overflow'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires on fixed-pixel width + overflow:hidden + text-overflow:ellipsis combo without flex-grow accommodation — translatable text will be truncated.',
  },
  {
    kind: 'i18n_timezone_display_wrong',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['surface-mcp'],
      surface: 'api',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    },
    fixture: {
      path: 'css-heuristics-mini',
      servesKinds: ['i18n_timezone_display_wrong'],
    },
    defaultBudgetMs: 30_000,
    note: 'Static-heuristic harness. Fires when a single page renders multiple timestamps with conflicting timezone suffixes (UTC + EST, etc.).',
  },
  {
    kind: 'console_error',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'console-error-mini',
      servesKinds: ['console_error'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness — fixture HTML pages embed the bootstrap inline as the first <head> script so console-override is in the page world (camofox evaluate is isolated-world). Fires when the harvested envelope contains any console event with level==="error".',
  },
  {
    kind: 'unhandled_exception',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'unhandled-exception-mini',
      servesKinds: ['unhandled_exception'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when the harvested envelope contains any uncaughtError (window.error) or unhandledRejection (window.unhandledrejection) event.',
  },
  {
    kind: 'react_error',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'react-error-mini',
      servesKinds: ['react_error'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when console.error text matches React patterns (Warning:, Cannot update during render, Invalid hook call, etc.). Hydration-specific errors take precedence and fire hydration_mismatch instead.',
  },
  {
    kind: 'hydration_mismatch',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'react-error-mini',
      servesKinds: ['hydration_mismatch'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when console.error text matches hydration-mismatch patterns (Hydration failed, Text content does not match, etc.).',
  },
  {
    kind: 'dom_error_text',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'dom-error-text-mini',
      servesKinds: ['dom_error_text'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Scans envelope.domState.bodyTextSample for "something went wrong" / "an error occurred" / "unable to" / "failed to" patterns.',
  },
  {
    kind: 'accessibility_critical',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'a11y-axe-mini',
      servesKinds: ['accessibility_critical'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture injects axe-shaped violations directly into window.__bh.axeViolations; classifier fires on impact === critical/serious. Production injects real axe-core via classify/accessibility.ts.',
  },
  {
    kind: 'axe_color_contrast_strong',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: {
      path: 'a11y-axe-mini',
      servesKinds: ['axe_color_contrast_strong'],
    },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Filters envelope.axeViolations to id === "color-contrast"; calibration fixture provides shaped violations.',
  },
  {
    kind: 'slow_lcp',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['slow_lcp'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when any largest-contentful-paint entry has value > 4000ms.',
  },
  {
    kind: 'slow_inp',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['slow_inp'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when any first-input entry duration/value > 200ms.',
  },
  {
    kind: 'high_cls',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['high_cls'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Sums layout-shift entry values; fires when cumulative > 0.25.',
  },
  {
    kind: 'main_thread_blocked',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['main_thread_blocked'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when any longtask entry duration > 50ms.',
  },
  {
    kind: 'n_plus_one_api_calls',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['n_plus_one_api_calls'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Groups resource requests by method + path family (trailing /:id collapsed); fires when any family >= 5 calls.',
  },
  {
    kind: 'request_dedup_missing',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['request_dedup_missing'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when >= 3 identical (method+url) resource requests are observed in the same envelope.',
  },
  {
    kind: 'request_cancellation_missing',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'perf-mini', servesKinds: ['request_cancellation_missing'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires on resource entries marked inflightOnNav=true; calibration uses the marker, production sets it from observed nav-vs-resource timing.',
  },
  {
    kind: 'nav_state_corruption',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'nav-state-mini', servesKinds: ['nav_state_corruption'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes pre/interim/post snapshots via window.__bh.pushNavInput; harness dispatches each through production classifyNavTransition() and filters detections to nav_state_corruption.',
  },
  {
    kind: 'nav_resubmit_on_back',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'nav-state-mini', servesKinds: ['nav_resubmit_on_back'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when classifyNavTransition emits nav_resubmit_on_back for an injected back-transition with an in-flight write request reappearing in post.',
  },
  {
    kind: 'nav_refresh_double_mutation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'nav-state-mini', servesKinds: ['nav_refresh_double_mutation'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when classifyNavTransition emits nav_refresh_double_mutation for an injected refresh-transition with still-pending mutation that doubled.',
  },
  {
    kind: 'nav_form_state_lost',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'nav-state-mini', servesKinds: ['nav_form_state_lost'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when classifyBackAfterFormFill emits nav_form_state_lost; calibration fixture sets bh.backAfterFormFill with form snapshot collapsed in post state.',
  },
  {
    kind: 'nav_form_state_stale',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'nav-state-mini', servesKinds: ['nav_form_state_stale'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fires when classifyBackAfterFormFill emits nav_form_state_stale; calibration fixture sets bh.backAfterFormFill with form snapshot whose post-fill values diverge from interim-fill values.',
  },
  {
    kind: 'keyboard_trap',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'interaction-state-mini', servesKinds: ['keyboard_trap'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes a KeyboardTrapResult via window.__bh.setKeyboardTrap; harness dispatches through production classifyA11yBaseline and filters detections to keyboard_trap. Production produces the result via Tab-press loop in the executor.',
  },
  {
    kind: 'focus_lost_after_action',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'interaction-state-mini', servesKinds: ['focus_lost_after_action'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes a FocusAfterActionResult via window.__bh.setFocusAfterAction; harness dispatches through production classifyA11yBaseline and filters detections to focus_lost_after_action.',
  },
  {
    kind: 'shadow_dom_a11y_violation',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'interaction-state-mini', servesKinds: ['shadow_dom_a11y_violation'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes synthesised shadow-axe violations via window.__bh.pushShadowAxe (id, host, impact); classifier filters to critical/serious. Production runs axe.run inside each open shadow root.',
  },
  {
    kind: 'visibility_change_state_loss',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'interaction-state-mini', servesKinds: ['visibility_change_state_loss'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes a HarvestVisibilityChangeLoss payload via window.__bh.setVisibilityChangeStateLoss matching the production multi-context detection shape (lifecycle event + proof + tool path + evidence). Production requires multi-context coordination across two browser contexts.',
  },
  {
    kind: 'missing_state_change',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'state-change-mini', servesKinds: ['missing_state_change'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes (PreState, PostState, Action) via window.__bh.setMissingStateChangeInput; harness dispatches through production classifyMissingStateChange. Production captures pre/post via execute-phase MutationObserver + ARIA snapshots.',
  },
  {
    kind: 'surface_call_failed',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'state-change-mini', servesKinds: ['surface_call_failed'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Calibration fixture pushes synthesized SurfaceCallResult via window.__bh.pushSurfaceCallResult; harness mirrors the production rule (status 4xx + happy palette + not a mutator-validation-rejection).',
  },
  // V56.4.13 (Bucket F)
  ...(['idor_horizontal', 'idor_horizontal_mutate', 'idor_vertical_role_escalate', 'idor_vertical_suspicious'] as const).map(kind => ({
    kind,
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'] as RequiredPhase[],
      tools: ['browser-mcp'] as ('browser-mcp')[],
      surface: 'web' as const,
      role: { kind: 'none' as const },
      pageContext: { kind: 'any-route' as const },
      observationWindowMs: 1500,
    },
    fixture: { path: 'cross-role-mini', servesKinds: [kind] },
    defaultBudgetMs: 30_000,
    note: `V56.4 browser harness. Calibration fixture pushes IDOR replay via window.__bh.pushIdorReplay; harness dispatches modern V21 kinds through production classifyIdorOutcome and applies the V05 inline rule for legacy kinds. Production drives this from cross-user.ts cross-role replays.`,
  })),
  ...(['race_condition_double_submit', 'race_condition_click_navigate', 'race_condition_optimistic_revert', 'race_condition_interleaved_mutations', 'race_condition_cross_tab'] as const).map(kind => ({
    kind,
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'] as RequiredPhase[],
      tools: ['browser-mcp'] as ('browser-mcp')[],
      surface: 'web' as const,
      role: { kind: 'none' as const },
      pageContext: { kind: 'any-route' as const },
      observationWindowMs: 1500,
    },
    fixture: { path: 'race-mini', servesKinds: [kind] },
    defaultBudgetMs: 30_000,
    note: `V56.4 browser harness. Calibration fixture pushes (variant, plan, observations) via window.__bh.pushRacePlan; harness dispatches through production race-detectors.ts (detect${kind === 'race_condition_double_submit' ? 'DoubleSubmit' : kind === 'race_condition_click_navigate' ? 'ClickThenNavigate' : kind === 'race_condition_optimistic_revert' ? 'OptimisticRevert' : kind === 'race_condition_interleaved_mutations' ? 'InterleavedMutations' : 'CrossTab'}). Production drives via race-runner against real timing.`,
  })),
  {
    kind: 'multi_context_state_divergence',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 1500,
    },
    fixture: { path: 'multi-context-mini', servesKinds: ['multi_context_state_divergence'] },
    defaultBudgetMs: 30_000,
    note: 'V56.4 browser harness. Fixture pushes (StateDivergencePlan, observationsByContext) via window.__bh.setMultiContextDivergence; harness dispatches through production detectMultiContextStateDivergence. Production drives across N coordinated browser contexts.',
  },
];
