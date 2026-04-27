// Link-following BFS crawler for SPA page discovery (SPEC_CRAWLER § 4.3–4.6).
// Reuses walkDom as the per-page primitive; does not duplicate the eval script.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { DiscoveredPage } from '../types.js';
import { walkDom, type DomWalkResult } from './dom-walker.js';
import { log } from '../log.js';

export type CrawlOpts = {
  baseUrl: string;
  seedRoutes: string[];
  maxPages: number;
  maxDepth: number;
  followQueryParams: boolean;
  walkTimeoutMs: number;
  sameOriginOnly: boolean;
  runId: string;
  extraHeaders?: Record<string, string>;
};

export type CrawlResult = {
  pages: DiscoveredPage[];
  visited: string[];
  skipped: Array<{ url: string; reason: string }>;
  hitMaxPages: boolean;
  hitMaxDepth: boolean;
};

/** Returns absolute URL if same-origin & supported scheme, else null. */
export function normalizeLink(href: string, currentUrl: string, opts: Pick<CrawlOpts, 'baseUrl' | 'followQueryParams' | 'sameOriginOnly'>): string | null {
  if (!href || href.startsWith('#')) return null;
  const lowered = href.toLowerCase();
  if (
    // eslint-disable-next-line no-script-url -- defensive URL scheme filter, not a script URL value
    lowered.startsWith('javascript:') ||
    lowered.startsWith('mailto:') ||
    lowered.startsWith('tel:') ||
    lowered.startsWith('data:') ||
    lowered.startsWith('blob:') ||
    lowered.startsWith('file:')
  ) return null;

  let u: URL;
  try {
    u = new URL(href, currentUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  if (opts.sameOriginOnly) {
    const base = new URL(opts.baseUrl);
    if (u.origin !== base.origin) return null;
  }

  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  if (!opts.followQueryParams) u.search = '';
  return u.toString();
}

/** Dedup key: path + optional sorted query, no fragment, no trailing slash. */
export function routeKey(u: URL, followQueryParams: boolean): string {
  let key = u.pathname;
  if (key !== '/' && key.endsWith('/')) key = key.slice(0, -1);
  if (followQueryParams && u.search) {
    const params = [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    key += `?${  params.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }
  return key;
}

function buildPage(walk: DomWalkResult, u: URL, followQueryParams: boolean): DiscoveredPage {
  return {
    route: u.pathname + (followQueryParams ? u.search : ''),
    sourceFile: undefined,
    elements: walk.elements,
    forms: walk.forms,
    links: walk.links,
  };
}

function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
  });
}

export async function crawlFromSeeds(
  browser: BrowserMcpAdapter,
  opts: CrawlOpts
): Promise<CrawlResult> {
  if (opts.seedRoutes.length === 0) return { pages: [], visited: [], skipped: [], hitMaxPages: false, hitMaxDepth: false };

  const visited = new Map<string, DiscoveredPage | null>();
  const queue: Array<{ url: string; depth: number }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  let hitMaxPages = false;
  let hitMaxDepth = false;

  for (const seed of opts.seedRoutes) {
    queue.push({ url: opts.baseUrl + seed, depth: 0 });
  }

  while (queue.length > 0) {
    if (visited.size >= opts.maxPages) { hitMaxPages = true; break; }
    const item = queue.shift();
    if (!item) break;
    const { url, depth } = item;
    const parsed = new URL(url);
    const key = routeKey(parsed, opts.followQueryParams);
    if (visited.has(key)) continue;
    visited.set(key, null); // reserve

    log.info(`crawl: visiting ${visited.size}/${opts.maxPages} depth=${depth} queue=${queue.length} ${parsed.pathname}${parsed.search}`);

    let walkResult: DomWalkResult | null = null;
    try {
      walkResult = await Promise.race([
        walkDom(browser, url, opts.runId, opts.extraHeaders),
        timeoutAfter(opts.walkTimeoutMs, 'walk timeout'),
      ]);
    } catch (err) {
      log.warn(`crawl: walk failed ${parsed.pathname}`, err);
      skipped.push({ url, reason: `walk_failed: ${String(err).slice(0, 200)}` });
      visited.delete(key);
      continue;
    }

    visited.set(key, buildPage(walkResult, parsed, opts.followQueryParams));

    if (depth + 1 > opts.maxDepth) { hitMaxDepth = true; continue; }

    for (const link of walkResult.links) {
      const abs = normalizeLink(link, url, opts);
      if (abs === null) {
        if (!link.startsWith('#')) {
          skipped.push({ url: link, reason: 'off_origin_or_unsupported' });
        }
        continue;
      }
      const childKey = routeKey(new URL(abs), opts.followQueryParams);
      if (visited.has(childKey)) continue;
      if (queue.some(q => routeKey(new URL(q.url), opts.followQueryParams) === childKey)) continue;
      queue.push({ url: abs, depth: depth + 1 });
    }
  }

  const pages = [...visited.values()].filter((p): p is DiscoveredPage => p !== null);
  return { pages, visited: [...visited.keys()], skipped, hitMaxPages, hitMaxDepth };
}
