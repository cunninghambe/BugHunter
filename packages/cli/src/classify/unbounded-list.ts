// Unbounded list classifier — unbounded_list_render (§4.4).
// Operates on raw DOM snapshots (HTML strings) via regex/pattern matching.
// Works in Node.js without DOM APIs.

import type { BugDetection } from '../types.js';

const ROW_THRESHOLD = 100;

const VIRTUALIZATION_CLASS_PATTERNS = [
  'react-window',
  'react-virtual',
  'tanstack-virtual',
  'virtual-list',
];

/** Jaccard similarity between two sets of strings. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Count direct child tags (e.g. <tr> or <li>) within an outer HTML. */
function countDirectChildren(html: string, childTag: string): number {
  const re = new RegExp(`<${childTag}(\\s|>)`, 'gi');
  const matches = html.match(re);
  return matches !== null ? matches.length : 0;
}

/** Check if HTML contains data-virtualized attribute. */
function hasDataVirtualized(html: string): boolean {
  return /data-virtualized/i.test(html);
}

/** Check if HTML contains virtualization class patterns. */
function hasVirtualizationClass(html: string): string[] {
  const signals: string[] = [];
  for (const pattern of VIRTUALIZATION_CLASS_PATTERNS) {
    if (html.toLowerCase().includes(pattern)) {
      signals.push(`class:${pattern}`);
    }
  }
  return signals;
}

type ListContainer = {
  tag: string;
  childTag: string;
  outerHtml: string;
  /** Approximate selector (tag[id|class]) */
  selector: string;
};

/** Extract list containers and their outerHTML from a DOM snapshot. */
function extractListContainers(domSnapshot: string): ListContainer[] {
  const containers: ListContainer[] = [];

  // For each list container type, find occurrences
  const patterns: Array<{ tag: string; childTag: string; re: RegExp }> = [
    { tag: 'tbody', childTag: 'tr', re: /<tbody([^>]*)>([\s\S]*?)<\/tbody>/gi },
    { tag: 'ul', childTag: 'li', re: /<ul([^>]*)>([\s\S]*?)<\/ul>/gi },
    { tag: 'ol', childTag: 'li', re: /<ol([^>]*)>([\s\S]*?)<\/ol>/gi },
  ];

  // Role-based: role="list", role="grid", role="rowgroup"
  const rolePatterns = ['list', 'grid', 'rowgroup'];
  for (const role of rolePatterns) {
    const re = new RegExp(`<div([^>]*role=["']${role}["'][^>]*)>([\\s\\S]*?)<\\/div>`, 'gi');
    patterns.push({ tag: `div[role="${role}"]`, childTag: 'div', re });
  }

  for (const { tag, childTag, re } of patterns) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(domSnapshot)) !== null) {
      const attrs = match[1] ?? '';
      // match[0] is the full outer HTML (including the container element itself)
      const outerHtml = match[0];

      // Build approximate selector
      const idMatch = /id=["']([^"']+)["']/.exec(attrs);
      const classMatch = /class=["']([^"']+)["']/.exec(attrs);
      let selector = tag;
      if (idMatch !== null) selector = `${tag}#${idMatch[1]}`;
      else if (classMatch !== null) {
        const cls = classMatch[1].trim().split(/\s+/).slice(0, 2).join('.');
        if (cls !== '') selector = `${tag}.${cls}`;
      }

      containers.push({ tag, childTag, outerHtml, selector });
    }
  }

  return containers;
}

/** Parse a DOM snapshot (HTML string) and find unbounded list containers. */
export function classifyUnboundedList(
  domSnapshot: string,
  pageRoute: string,
  threshold = ROW_THRESHOLD,
): BugDetection[] {
  if (domSnapshot === '') return [];

  // Check for global virtualization signals in the entire snapshot
  const globalVirtualization =
    hasDataVirtualized(domSnapshot) ||
    hasVirtualizationClass(domSnapshot).length > 0;

  // If the whole document is virtualized, skip all checks
  if (globalVirtualization) return [];

  const containers = extractListContainers(domSnapshot);
  const detections: BugDetection[] = [];

  for (const { childTag, outerHtml, selector } of containers) {
    const rowCount = countDirectChildren(outerHtml, childTag);
    if (rowCount <= threshold) continue;

    detections.push({
      kind: 'unbounded_list_render',
      rootCause: `${selector} renders ${rowCount} rows without virtualization (threshold: ${threshold})`,
      pageRoute,
      evidence: {
        containerSelector: selector,
        rowCount,
        threshold,
        virtualizationSignals: [],
      },
    });
  }

  return detections;
}
