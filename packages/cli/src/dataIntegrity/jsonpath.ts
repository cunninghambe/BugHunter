// v0.42: dotted-path JSON extraction with [N] index and [*] wildcard support.
// Implements a minimal subset (no full JSONPath spec required per §8.3).

/**
 * Extract a value from `obj` using a dotted JSON path.
 * Supports:
 *   - `a.b.c` — nested property access
 *   - `a[0].b` — array index
 *   - `a[*].b` — wildcard (returns array of all matches)
 */
export function extractJsonPath(obj: unknown, jsonPath: string): unknown {
  const segments = parsePath(jsonPath);
  return walk(obj, segments);
}

type Segment = { key: string } | { index: number } | { wildcard: true };

function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  // Split on '.' but keep bracket expressions intact
  const parts = path.split('.');
  for (const part of parts) {
    if (part === '') continue;
    const bracketMatch = part.match(/^([^\[]*)\[(\d+|\*)\]$/);
    if (bracketMatch !== null) {
      const prefix = bracketMatch[1];
      const indexPart = bracketMatch[2];
      if (prefix !== '') segments.push({ key: prefix });
      if (indexPart === '*') {
        segments.push({ wildcard: true });
      } else {
        segments.push({ index: parseInt(indexPart, 10) });
      }
    } else {
      segments.push({ key: part });
    }
  }
  return segments;
}

function walk(current: unknown, segments: Segment[]): unknown {
  if (segments.length === 0) return current;
  const [head, ...rest] = segments;

  if ('wildcard' in head) {
    if (!Array.isArray(current)) return undefined;
    return current.map(item => walk(item, rest)).flat();
  }

  if ('index' in head) {
    if (!Array.isArray(current)) return undefined;
    return walk(current[head.index], rest);
  }

  // key
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
  const obj = current as Record<string, unknown>;
  if (!(head.key in obj)) return undefined;
  return walk(obj[head.key], rest);
}
