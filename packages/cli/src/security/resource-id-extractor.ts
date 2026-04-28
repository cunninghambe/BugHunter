// Pure resource-ID harvesting from JSON API response bodies (v0.5 §3.1).
// No IO — unit-testable, re-entrant.

import type { DiscoveredIds } from '../types.js';

// Tier 1: known identifier names (case-insensitive exact match)
const ID_NAMES_EXACT = new Set([
  'id', 'uuid', 'guid', '_id', '_uuid', '_key', '_pk', 'pk',
  'slug', 'handle', 'code', 'key', 'objectid', 'nodeid', 'hash',
]);

// Tier 2: regex match — camelCase and snake_case id/uuid suffixes
const ID_NAMES_REGEX: RegExp[] = [
  /^[a-z][a-zA-Z0-9]*Id$/,       // tradeId, accountId, customerId
  /^[a-z][a-zA-Z0-9]*Uuid$/,     // tradeUuid
  /^[a-z][a-z0-9]*_id$/,         // user_id, tx_id, wallet_id
  /^[a-z][a-z0-9]*_uuid$/,       // user_uuid
  /^[a-z][a-zA-Z0-9]*Hash$/,     // txHash
  /^[a-z][a-zA-Z0-9]*Number$/,   // accountNumber, invoiceNumber
];

// Tier 3: excluded — auth material, not resource IDs (matched lowercase)
const ID_NAMES_EXCLUDE = new Set([
  'apikey', 'token', 'secret', 'password', 'sessionid',
  'sessiontoken', 'csrftoken', 'authtoken',
]);

function isIdField(fieldName: string): boolean {
  if (ID_NAMES_EXCLUDE.has(fieldName.toLowerCase())) return false;
  if (ID_NAMES_EXACT.has(fieldName.toLowerCase())) return true;
  return ID_NAMES_REGEX.some(re => re.test(fieldName));
}

function looksLikeResourceId(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  if (value === '0' || value === '-1') return false;
  if (/^\s*$/.test(value)) return false;
  if (/^(true|false|null|undefined|active|inactive|pending|complete)$/i.test(value)) return false;
  return true;
}

/**
 * Walk a parsed JSON body and collect (field, value, path) tuples for any
 * field name matching the tiered ID-name rules. Recurses up to maxDepth.
 */
export function extractIdsFromBody(
  body: unknown,
  maxDepth = 5,
): Array<{ field: string; value: string; path: string }> {
  const results: Array<{ field: string; value: string; path: string }> = [];
  walk(body, maxDepth, '', results);
  return results;
}

function walk(
  node: unknown,
  depth: number,
  pathPrefix: string,
  out: Array<{ field: string; value: string; path: string }>,
): void {
  if (depth <= 0) return;

  if (Array.isArray(node)) {
    node.forEach((item, idx) => {
      walk(item, depth - 1, `${pathPrefix}[${idx}]`, out);
    });
    return;
  }

  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const currentPath = pathPrefix === '' ? key : `${pathPrefix}.${key}`;
      if (isIdField(key) && (typeof value === 'string' || typeof value === 'number')) {
        const strValue = String(value);
        if (looksLikeResourceId(strValue)) {
          out.push({ field: key, value: strValue, path: currentPath });
        }
      }
      walk(value, depth - 1, currentPath, out);
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
  ids: Array<{ field: string; value: string; path?: string }>,
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
