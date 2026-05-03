// Network error classification (§ 3.5).

import type { NetworkRequest, BugDetection, ExpectedOutcome } from '../types.js';

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
  authorizedRole: boolean
): BugDetection[] {
  const bugs: BugDetection[] = [];

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
      const isUnexpected =
        (expectedOutcome === 'success') ||
        ((req.status === 401 || req.status === 403) && authorizedRole);

      if (isUnexpected) {
        bugs.push({
          kind: 'network_4xx_unexpected',
          rootCause: `Unexpected HTTP ${req.status} from ${req.method} ${req.path}`,
          status: req.status,
          endpoint: `${req.method} ${normalizePath(req.path)}`,
          responseBodyShape: req.responseBodySnippet,
        });
      }
    }

    if (req.status === 404 && !isMutatorSyntheticPath(req.path) && !isDevServerPath(req.path)) {
      bugs.push({
        kind: '404_for_linked_route',
        rootCause: `Page links to ${req.path} which returned 404`,
        targetPath: req.path,
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
