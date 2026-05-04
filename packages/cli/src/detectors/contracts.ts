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
};

/** Cluster assertion line (one entry in expected-clusters.jsonl). */
export type ClusterAssertion =
  | {
      kind: BugKind;
      expect: 'fires';
      minClusterSize: number;
      match: { page?: string; role?: string; signaturePrefix?: string };
      severity: 'critical' | 'major' | 'minor' | 'info';
      /** Optional label for edge-case variants (e.g. "stripe-test-key-in-comment"). */
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
      /** Harness skips this assertion entirely when preconditions are unmet. */
      kind: BugKind;
      expect: 'skipped';
      reason:
        | 'insufficient_roles'
        | 'missing_tool'
        | 'missing_surface'
        | 'fixture_not_built'
        | 'no_pages_to_probe'
        | 'fixture_unreachable'
        | 'no_response'
        | 'fixture_db_missing'
        | 'fixture_uploads_missing'
        | 'no_anonymous_role'
        | 'tool_not_found:npm-audit'
        | (string & {});
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
      pageContext: { kind: 'specific-routes', routes: ['/api/admin/health'] },
    },
    fixture: {
      path: 'command-injection-mini',
      servesKinds: ['command_injection'],
    },
    defaultBudgetMs: 30_000,
    note: 'Detects direct shell string concatenation in POST body fields (target, domain) via nonce echo-back from exec output.',
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
];
