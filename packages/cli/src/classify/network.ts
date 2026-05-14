// Network error classification (§ 3.5).

import type { NetworkRequest, BugDetection, ExpectedOutcome } from '../types.js';

/** Roles that aren't expected to access admin endpoints — 401/403 is correct, not a bug. */
const ANONYMOUS_ROLES: ReadonlySet<string> = new Set(['anon', 'anonymous']);

/**
 * Patterns that identify mutator-synthesized paths. A 404 on these is expected
 * by design — not a linked-route bug (fixes false-positive class #112).
 *
 * Covers:
 *   - All-zero UUIDs (fuzz.ts boundary case for uuid format)
 *   - __bughunter_* sentinels (palette.ts out_of_bounds / fuzz.ts extra_key)
 *   - -nonexistent suffix (palette.ts foreignIdCases edge variant)
 *   - fake-id and synthetic-test-id (documented in issue #112 mutator pool)
 */
const MUTATOR_SYNTHETIC_PATTERNS = [
  '00000000-0000-0000-0000-000000000000',
  '__bughunter_',
  '-nonexistent',
  'fake-id',
  'synthetic-test-id',
] as const;

/**
 * Dev-server URL patterns that should never fire network_5xx — these are
 * Vite/Next.js HMR and build-artifact paths with no production equivalent
 * (fixes false-positive class #145; 70/126 FPs on Aspectv3 smoke run).
 */
const DEV_SERVER_URL_PATTERNS: RegExp[] = [
  /^\/@vite\//,
  /^\/@fs\//,
  /^\/node_modules\/\.vite\//,
  /^\/__vite_ping/,
  /^\/__nuxt\//,
  /^\/_next\/static\/development\//,
];

export function isMutatorSyntheticPath(path: string): boolean {
  return MUTATOR_SYNTHETIC_PATTERNS.some(p => path.includes(p));
}

export function isDevServerPath(path: string): boolean {
  return DEV_SERVER_URL_PATTERNS.some(re => re.test(path));
}

export function classifyNetworkRequests(
  requests: NetworkRequest[],
  expectedOutcome: ExpectedOutcome,
  authorizedRole: boolean,
  role?: string,
): BugDetection[] {
  const bugs: BugDetection[] = [];
  const isAnonymousRole = role !== undefined && ANONYMOUS_ROLES.has(role);

  for (const req of requests) {
    // Status 0 is the canonical signal for "request never completed" (network
    // failure, CORS rejection, abort). Classify as a connectivity failure bug.
    if (req.status === 0 && !isDevServerPath(req.path)) {
      bugs.push({
        kind: 'network_5xx',
        rootCause: `Connectivity failure (status 0) from ${req.method} ${req.path}`,
        status: 0,
        endpoint: `${req.method} ${normalizePath(req.path)}`,
        responseBodyShape: req.responseBodySnippet,
      });
      continue;
    }

    if (req.status >= 500 && !isDevServerPath(req.path)) {
      bugs.push({
        kind: 'network_5xx',
        rootCause: `HTTP ${req.status} from ${req.method} ${req.path}`,
        status: req.status,
        endpoint: `${req.method} ${normalizePath(req.path)}`,
        responseBodyShape: req.responseBodySnippet,
      });
      continue;
    }

    if (req.status >= 400) {
      // Anon/anonymous role hitting an auth-gated endpoint and getting 401/403
      // is the correct security response, not an "unexpected" 4xx. Spoonworks
      // calibration (May 2026): 50/52 surfaced 4xxs were anon-on-admin 401s.
      const anonAuthBlock = (req.status === 401 || req.status === 403) && isAnonymousRole;
      // 429 = rate-limited; that's correct app behavior triggered BY our scan
      // load, not an app bug. Same suppression as surface_call_failed.
      const rateLimited = req.status === 429;

      // v0.51: 422 ("Unprocessable Entity") is by HTTP spec a validation failure.
      // For happy-palette probes (expectedOutcome === 'success'), a 422 almost
      // always means BugHunter synthesised input that the server's schema
      // (Zod, Joi, class-validator, etc.) correctly rejected — i.e. the mutator
      // couldn't satisfy the server's schema, NOT an app bug. The earlier
      // "downgrade 422 to confidence=low" rule (PR #262) still produced 15/15
      // FPs on the spoonworks benchmark because they all landed in
      // bugs-low-confidence.jsonl and cluttered triage. Drop them entirely for
      // happy palette. For non-happy palettes 422 is expected_failure anyway,
      // so this is a no-op there. Tradeoff: a real regression that newly
      // rejects previously-valid input is now a false-negative; that case is
      // expected to surface via other detectors (functional, contract).
      // Documented in docs/benchmarks/BENCHMARK_SPOONWORKS.md.
      const happyPaletteValidationFailure = req.status === 422 && expectedOutcome === 'success';

      const isUnexpected =
        !anonAuthBlock && !rateLimited && !happyPaletteValidationFailure && (
          (expectedOutcome === 'success') ||
          ((req.status === 401 || req.status === 403) && authorizedRole)
        );

      if (isUnexpected) {
        // Suppress when the response body is a Zod / validation-rejection shape.
        const snippet = req.responseBodySnippet ?? '';
        const isValidationRejection =
          snippet.includes('"fieldErrors"') ||
          snippet.includes('"formErrors"') ||
          snippet.includes('"issues"') ||
          /\b(invalid|required|expected.+received|zod)\b/i.test(snippet);
        if (!isValidationRejection) {
          bugs.push({
            kind: 'network_4xx_unexpected',
            rootCause: `Unexpected HTTP ${req.status} from ${req.method} ${req.path}`,
            status: req.status,
            endpoint: `${req.method} ${normalizePath(req.path)}`,
            responseBodyShape: req.responseBodySnippet,
            confidence: 'medium',
          });
        }
      }
    }

    // Suppress 404_for_linked_route when the test deliberately injects a probe
    // expected to fail (edge / null / fuzz / out_of_bounds palettes set
    // expectedOutcome='expected_failure'). The 404 IS the expected response
    // there — not a real broken link. Spoonworks calibration (May 2026)
    // surfaced two such FPs.
    if (
      req.status === 404
      && expectedOutcome !== 'expected_failure'
      && !isMutatorSyntheticPath(req.path)
      && !isDevServerPath(req.path)
    ) {
      bugs.push({
        kind: '404_for_linked_route',
        rootCause: `Page links to ${req.path} which returned 404`,
        targetPath: req.path,
        // High confidence: a real page-emitted link returning 404 is a
        // deterministic broken link.
        confidence: 'high',
      });
    }
  }

  return bugs;
}

/** Normalize dynamic path segments: /api/products/123 -> /api/products/:id */
export function normalizePath(p: string): string {
  return p.replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}
