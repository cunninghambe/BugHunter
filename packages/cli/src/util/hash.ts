// Schema hashing utilities.

import { createHash } from 'node:crypto';
import type { JsonSchema } from '../types.js';

/**
 * Returns the first 12 hex chars of a SHA-1 hash of the canonical JSON
 * representation of a JsonSchema (keys sorted recursively).
 */
export function hashSchema(schema: JsonSchema): string {
  return createHash('sha1')
    .update(canonicalJson(schema))
    .digest('hex')
    .slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
    .join(',');
  return '{' + sorted + '}';
}
