// Network error classification (§ 3.5).

import type { NetworkRequest, BugDetection, ExpectedOutcome } from '../types.js';

export function classifyNetworkRequests(
  requests: NetworkRequest[],
  expectedOutcome: ExpectedOutcome,
  authorizedRole: boolean
): BugDetection[] {
  const bugs: BugDetection[] = [];

  for (const req of requests) {
    // Status 0 is the canonical signal for "request never completed" (network
    // failure, CORS rejection, abort). Classify as a connectivity failure bug.
    if (req.status === 0) {
      bugs.push({
        kind: 'network_5xx',
        rootCause: `Connectivity failure (status 0) from ${req.method} ${req.path}`,
        status: 0,
        endpoint: `${req.method} ${normalizePath(req.path)}`,
        responseBodyShape: req.responseBodySnippet,
      });
      continue;
    }

    if (req.status >= 500) {
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

    if (req.status === 404) {
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
