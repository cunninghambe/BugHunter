// Canonical JSON serialisation helpers for deterministic output.
//
// canonicalStringify: JSON.stringify with sorted keys at every depth.
// canonicalize: strip wall-clock-derived fields before hashing (§6.5).
//
// Used by emit.ts for bugs.jsonl and summary.json to ensure byte-identical
// output regardless of Map insertion order or V8 property enumeration order.

/**
 * Serialize a value to JSON with all object keys sorted alphabetically.
 * Arrays preserve their order.  Does NOT rely on V8 property enumeration.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Strip wall-clock-derived fields from a summary object before canonical hashing.
 * Paths use dot notation; array items are not individually addressed (strip applies
 * to all occurrences of the final key at any depth).
 *
 * §6.5 strip list:
 *   actualRuntimeMs, projectedRuntimeMs, durationMs (at any depth),
 *   discovery.crawlTelemetry.elapsedMs, vision.costUsd,
 *   formReachabilityProbes.durationMs
 */
export function canonicalize(obj: unknown, stripKeys: ReadonlyArray<string>): unknown {
  const keySet = new Set(stripKeys);
  return stripDeep(obj, keySet);
}

function stripDeep(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => stripDeep(item, keys));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(k)) continue;
      result[k] = stripDeep(v, keys);
    }
    return result;
  }
  return value;
}

/**
 * The standard set of wall-clock-derived fields stripped for the canonical hash.
 * Tests assert these are absent from the hashed envelope.
 */
export const CANONICAL_STRIP_KEYS: ReadonlyArray<string> = [
  'actualRuntimeMs',
  'projectedRuntimeMs',
  'durationMs',
  'elapsedMs',
  'costUsd',
];
