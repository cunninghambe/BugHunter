// Pure resource-ID harvesting from JSON API response bodies (v0.5 §3.1).
// No IO — unit-testable, re-entrant.

import type { DiscoveredIds } from '../types.js';

// Field names whose values are treated as resource identifiers.
const ID_FIELD_NAMES = new Set([
  'id', 'uuid', '_id', 'tradeId', 'userId', 'accountId', 'resourceId',
  'orderId', 'productId', 'transactionId', 'sessionId', 'customerId',
]);

/**
 * Walk a parsed JSON body and collect (fieldName → value) pairs for any
 * field name in ID_FIELD_NAMES. Recurses into arrays and objects up to
 * maxDepth levels.
 */
export function extractIdsFromBody(
  body: unknown,
  maxDepth = 5,
): Array<{ field: string; value: string }> {
  const results: Array<{ field: string; value: string }> = [];
  walk(body, maxDepth, results);
  return results;
}

function walk(node: unknown, depth: number, out: Array<{ field: string; value: string }>): void {
  if (depth <= 0) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, depth - 1, out);
    }
    return;
  }

  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (ID_FIELD_NAMES.has(key) && (typeof value === 'string' || typeof value === 'number')) {
        out.push({ field: key, value: String(value) });
      }
      walk(value, depth - 1, out);
    }
  }
}

/**
 * Merge extracted IDs into a DiscoveredIds map.
 * Called as a pure side-effect hook after each successful API response.
 */
export function mergeDiscoveredIds(
  map: DiscoveredIds,
  role: string,
  toolId: string,
  ids: Array<{ field: string; value: string }>,
): void {
  if (ids.length === 0) return;

  let roleMap = map.get(role);
  if (roleMap === undefined) {
    roleMap = new Map();
    map.set(role, roleMap);
  }

  for (const { field, value } of ids) {
    // Key by toolId+field so ids from different tools don't collide.
    const mapKey = `${toolId}:${field}`;
    let valueSet = roleMap.get(mapKey);
    if (valueSet === undefined) {
      valueSet = new Set();
      roleMap.set(mapKey, valueSet);
    }
    valueSet.add(value);
  }
}

/** Decode the composite key produced by mergeDiscoveredIds. */
export function decodeDiscoveredIdKey(key: string): { toolId: string; field: string } {
  const sep = key.indexOf(':');
  if (sep === -1) return { toolId: key, field: '' };
  return { toolId: key.slice(0, sep), field: key.slice(sep + 1) };
}
