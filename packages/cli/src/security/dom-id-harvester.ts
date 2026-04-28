// DOM-side resource-ID harvester (v0.5 Gap 2).
// Pure: no IO, no side-effects. Uses regex-based parsing on snapshot HTML.
// Must not throw on malformed input — returns [] on any error.

import { log } from '../log.js';

export type DomHarvestedId = { field: string; value: string; path: string };

// Route path-segment extraction: /entity/<id-shaped-segment>
// Matches alphanumeric + hyphen/underscore segments of 4–40 chars after a resource name.
const ROUTE_ID_RE = /\/[a-z][a-z0-9-]*\/([a-z0-9][a-z0-9_-]{3,39})(?:\/|$)/gi;

// Reserved words that are never resource IDs (route segments, not entity ids)
const ROUTE_SEGMENT_EXCLUDE = new Set([
  'api', 'static', 'assets', 'public', 'images', 'css', 'js', 'fonts',
  'edit', 'new', 'create', 'update', 'delete', 'list', 'index', 'view',
  'login', 'logout', 'register', 'auth', 'oauth', 'callback', 'redirect',
]);

// data-* attribute name patterns that are likely IDs (reuse Tier-1/Tier-2 logic from extractor)
// Attribute name after stripping 'data-' prefix is checked against these patterns.
const DATA_ATTR_ID_RE = /^(?:id|uuid|guid|_id|pk|key)$|(?:[-_]id$)|(?:[-_]uuid$)/i;

// Attributes that are definitely not IDs even if they match the above
const DATA_ATTR_EXCLUDE_RE = /^(?:testid|dismiss|toggle|target|action|type|role|label|describe|placeholder)$/i;

/**
 * Harvest resource IDs from rendered DOM snapshot HTML and page link hrefs.
 * Returns extracted { field, value, path } tuples.
 * Never throws — returns [] on error.
 */
export function harvestIdsFromDom(snapshot: string, links: string[]): DomHarvestedId[] {
  try {
    return [...harvestFromLinks(links), ...harvestFromDataAttrs(snapshot)];
  } catch (err) {
    log.debug('dom-id-harvester: parse error', { err: String(err) });
    return [];
  }
}

function harvestFromLinks(links: string[]): DomHarvestedId[] {
  const results: DomHarvestedId[] = [];
  for (const href of links) {
    try {
      // Use pathname only — strip host to work with both relative and absolute links
      const pathname = href.startsWith('http') ? new URL(href).pathname : href.split('?')[0] ?? href;
      ROUTE_ID_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ROUTE_ID_RE.exec(pathname)) !== null) {
        // match[1] is always defined — the regex has exactly one capture group
        const segment = match[1] as string;
        if (ROUTE_SEGMENT_EXCLUDE.has(segment.toLowerCase())) continue;
        if (/^\d+$/.test(segment) && segment.length < 4) continue; // too short numeric
        results.push({ field: '__route_id', value: segment, path: href });
      }
    } catch {
      // Malformed href — skip
    }
  }
  return results;
}

function harvestFromDataAttrs(snapshot: string): DomHarvestedId[] {
  const results: DomHarvestedId[] = [];
  // Match data-<name>="<value>" or data-<name>='<value>'
  const DATA_ATTR_RE = /\bdata-([\w-]+)=["']([^"']{1,128})["']/g;
  let match: RegExpExecArray | null;
  while ((match = DATA_ATTR_RE.exec(snapshot)) !== null) {
    // match[1] and match[2] are always defined — the regex has exactly two capture groups
    const attrName = match[1] as string;
    const attrValue = match[2] as string;

    // Strip 'data-' prefix and normalize to check against ID patterns
    const normalized = attrName.replace(/-/g, '_').toLowerCase();
    if (DATA_ATTR_EXCLUDE_RE.test(normalized)) continue;
    if (!DATA_ATTR_ID_RE.test(normalized)) continue;
    if (attrValue.length < 2 || /^\s*$/.test(attrValue)) continue;

    results.push({ field: attrName, value: attrValue, path: `[data-${attrName}]` });
  }
  return results;
}
