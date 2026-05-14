// v0.51 — path-placeholder detection.
//
// SurfaceMCP-discovered routes like `/api/admin/products/:id/adjust-stock`
// include path-parameter placeholders. When BugHunter probes them without a
// matching `discoveryFixtures` entry, the literal string `:id` ends up in the
// outbound URL and the server returns 4xx ("no such route" / "invalid id" /
// schema rejection). That 4xx is a BugHunter probe-coverage gap, not an app
// bug — see docs/benchmarks/BENCHMARK_SPOONWORKS.md (20/20 FPs).
//
// This helper detects the placeholder pattern so callers can suppress bug
// emission and instead surface a "configure discoveryFixtures for X" hint.

const PLACEHOLDER_PATTERN = /\/:([A-Za-z_][A-Za-z0-9_]*)/;
const PLACEHOLDER_PATTERN_GLOBAL = /\/:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Returns the first unresolved placeholder (including the leading slash) or
 * null when the path has none. Express/Next.js-style `/:paramName` syntax.
 */
export function findUnresolvedPlaceholder(routePath: string): string | null {
  const m = PLACEHOLDER_PATTERN.exec(routePath);
  return m === null ? null : m[0];
}

/**
 * Returns every unresolved placeholder in the path (for routes with multiple).
 * Example: `/api/products/:id/images/:index` → [":id", ":index"].
 */
export function listUnresolvedPlaceholders(routePath: string): string[] {
  const out: string[] = [];
  for (const m of routePath.matchAll(PLACEHOLDER_PATTERN_GLOBAL)) {
    out.push(`:${m[1]}`);
  }
  return out;
}

export function hasUnresolvedPlaceholder(routePath: string): boolean {
  return PLACEHOLDER_PATTERN.test(routePath);
}
