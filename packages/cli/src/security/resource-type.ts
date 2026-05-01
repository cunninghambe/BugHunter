// Pure resource-type derivation from URL paths and field names (v0.21 §6.3).
// No IO — unit-testable, re-entrant.

import type { IdorConfig } from '../types.js';

/**
 * Derive a resource type string from the given tool context.
 *
 * Derivation order (first match wins):
 * 1. Per-tool override from config.idor.resourceTypeOverrides[toolId]
 * 2. Per-URL-pattern override from config.idor.resourceTypeOverridesByPath[pattern]
 * 3. URL-path heuristic on toolPath
 * 4. Field-name fallback from fieldName
 * 5. '_unknown' last resort
 */
export function deriveResourceType(
  toolId: string,
  toolPath: string,
  fieldName: string,
  idorConfig: Pick<IdorConfig, 'resourceTypeOverrides' | 'resourceTypeOverridesByPath'> | undefined,
): string {
  // 1. Per-tool override
  const toolOverride = idorConfig?.resourceTypeOverrides?.[toolId];
  if (toolOverride !== undefined && toolOverride.length > 0) return toolOverride;

  // 2. Per-URL-pattern override (exact-path match, no glob expansion in v0.21)
  const pathOverrides = idorConfig?.resourceTypeOverridesByPath ?? {};
  for (const [pattern, override] of Object.entries(pathOverrides)) {
    if (pathMatchesPattern(toolPath, pattern)) return override;
  }

  // 3. URL-path heuristic
  const fromPath = extractResourceTypeFromPath(toolPath);
  if (fromPath !== null) return fromPath;

  // 4. Field-name fallback
  const fromField = extractResourceTypeFromField(fieldName);
  if (fromField !== null) return fromField;

  return '_unknown';
}

/**
 * Extract resource type from a URL path.
 * Matches /api/v1/orders/:id → 'order', /api/users → 'user', etc.
 * Strips trailing 's' when stem length >= 3.
 */
export function extractResourceTypeFromPath(urlPath: string): string | null {
  // Match: optional /api prefix, optional /vN version, then first path segment
  const m = urlPath.match(/^\/api(?:\/v\d+)?\/([a-z][a-z0-9-]*)(?:\/|$)/i);
  if (m === null) return null;

  const segment = m[1].toLowerCase();
  return singularise(segment);
}

/**
 * Extract resource type from a field name like 'tradeId', 'customer_id', 'orderUuid'.
 * Strips common id/uuid/hash suffixes.
 */
export function extractResourceTypeFromField(fieldName: string): string | null {
  // Strip camelCase suffixes: Id, Uuid, Hash, Number
  let stem = fieldName
    .replace(/Id$/, '')
    .replace(/Uuid$/, '')
    .replace(/Hash$/, '')
    .replace(/Number$/, '');

  // Strip snake_case suffixes: _id, _uuid
  stem = stem.replace(/_id$/, '').replace(/_uuid$/, '');

  if (stem.length < 2 || stem === fieldName) return null;
  return stem.toLowerCase();
}

/**
 * Singularise by stripping trailing 's' when the resulting stem has length >= 3.
 * Open question 1 conservative default: minimal rule, user overrides via config.
 * 'orders' → 'order', 'users' → 'user', 'news' → 'news' (stem 'new' is 3 chars, so becomes 'new')
 * Special case: preserve 'series', 'status', 'address' as-is since they end in 's' but stem < 3 meaningful.
 * The minimal rule: strip trailing 's' only when len(stem) >= 3.
 */
function singularise(word: string): string {
  if (!word.endsWith('s')) return word;
  const stem = word.slice(0, -1);
  return stem.length >= 3 ? stem : word;
}

/**
 * Simple path pattern matcher.
 * Supports :param placeholders and exact segments. No glob.
 * '/api/orders/:id' matches '/api/orders/123'.
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split('/');
  const patternParts = pattern.split('/');
  if (pathParts.length !== patternParts.length) return false;

  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}
