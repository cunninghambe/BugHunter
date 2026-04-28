// sqlmap wrapper skeleton (v0.5 T11 — implementation deferred to v0.7).
// Exports the interface + heuristic pre-filter that v0.7 will use.

import type { ToolMeta } from '../types.js';

// Endpoints matching these patterns are candidates for SQL injection probing.
const SQL_INJECTION_PATH_HINTS = ['search', 'filter', 'q', 'order_by', 'sort', 'query', 'find'];

/** Returns true when the tool is a candidate for sqlmap probing. */
export function isSqlmapCandidate(tool: ToolMeta): boolean {
  if (tool.sideEffectClass === 'external') return false;

  const methodUpper = tool.method.toUpperCase();

  // POST/PUT/PATCH endpoints with any body params are candidates.
  if (['POST', 'PUT', 'PATCH'].includes(methodUpper)) {
    const schema = tool.inputSchema;
    if (
      schema.type === 'object' &&
      schema.properties !== undefined &&
      Object.values(schema.properties).some(p => p.type === 'string')
    ) {
      return true;
    }
  }

  // GET endpoints with SQL-injection-hint path segments.
  if (methodUpper === 'GET') {
    const pathLower = tool.path.toLowerCase();
    return SQL_INJECTION_PATH_HINTS.some(hint => pathLower.includes(hint));
  }

  return false;
}

export type SqlmapRunResult =
  | { ok: false; reason: 'not_implemented' }
  | { ok: false; reason: 'not_candidate' }
  | { ok: false; reason: 'timeout' }
  | { ok: true; injectionPoints: string[] };

/** TODO(v0.7): spawn sqlmap --batch --crawl=0 --level=1 --risk=1 --timeout=60 per endpoint. */
export function runSqlmap(
  _tool: ToolMeta,
  _projectDir: string,
): SqlmapRunResult {
  return { ok: false, reason: 'not_implemented' };
}
