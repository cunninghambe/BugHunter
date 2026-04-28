// Link-following BFS crawler for SPA page discovery (SPEC_CRAWLER § 4.3–4.6).
// Reuses walkDom/collectDomOnly as per-page primitives; does not duplicate the eval script.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter, SurfacePostprocessedRoute } from '../adapters/surface-mcp.js';
import type { DiscoveredPage, NavSource, TriggerSelectorHint, CrawlTelemetry } from '../types.js';
import { walkDom, collectDomOnly, type DomWalkResult } from './dom-walker.js';
import { resolveTriggerSelector } from './trigger-resolve.js';
import { log } from '../log.js';

export type QueueItem =
  | {
      kind: 'url';
      url: string;
      depth: number;
      source: NavSource;
    }
  | {
      kind: 'state';
      baseRoute: string;
      stateVar: string;
      stateValue: string;
      trigger: TriggerSelectorHint;
      depth: number;
      source: NavSource;
    };

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
  // New fields from spec § 3.10
  surface?: SurfaceMcpAdapter;
  includeLowConfidence?: boolean;
  stateSettleMs?: number;
  disableRuntimeEnum?: boolean;
  maxStateNavigations?: number;
};

export type CrawlResult = {
  pages: DiscoveredPage[];
  visited: string[];
  skipped: Array<{ url: string; reason: string }>;
  hitMaxPages: boolean;
  hitMaxDepth: boolean;
  telemetry: CrawlTelemetry;
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

/** Dedup key for a QueueItem. State items use a synthetic key; URL items use routeKey. */
export function queueKey(item: QueueItem, followQueryParams = false): string {
  if (item.kind === 'url') {
    const u = new URL(item.url);
    return routeKey(u, followQueryParams);
  }
  return `${item.baseRoute}#state=${item.stateVar}=${item.stateValue}`;
}

function buildUrlPage(walk: DomWalkResult, u: URL, followQueryParams: boolean, source: NavSource): DiscoveredPage {
  return {
    route: u.pathname + (followQueryParams ? u.search : ''),
    sourceFile: undefined,
    elements: walk.elements,
    forms: walk.forms,
    links: walk.links,
    kind: 'url',
    navSource: source,
  };
}

function buildStatePage(walk: DomWalkResult, item: Extract<QueueItem, { kind: 'state' }>): DiscoveredPage {
  const syntheticRoute = `/${item.baseRoute.replace(/^\//, '')}?${encodeURIComponent(item.stateVar)}=${encodeURIComponent(item.stateValue)}`;
  return {
    route: syntheticRoute,
    sourceFile: undefined,
    elements: walk.elements,
    forms: walk.forms,
    links: walk.links,
    kind: 'state',
    stateContext: {
      baseRoute: item.baseRoute,
      stateVar: item.stateVar,
      stateValue: item.stateValue,
      triggerHint: item.trigger,
    },
    navSource: item.source,
  };
}

function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
  });
}

async function runRuntimeEnum(browser: BrowserMcpAdapter, surface: SurfaceMcpAdapter): Promise<SurfacePostprocessedRoute[]> {
  const self = await surface.surface_describe_self();
  if (!self.capabilities.enumerateRoutesRuntime) return [];

  const { script, timeoutMs } = await surface.surface_enumerate_routes_runtime();
  let raw: unknown;
  try {
    const result = await Promise.race([
      browser.evaluate(script),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('runtime_enum_timeout')), timeoutMs + 500)),
    ]);
    raw = (result as { value: unknown }).value;
  } catch (err) {
    log.warn('runtime_enum: script failed', { err: String(err) });
    return [];
  }

  const post = await surface.surface_postprocess_runtime_routes({ raw });
  log.info(`runtime_enum: ${post.summary.detectedRouters.join(',') || 'none'}, ${post.routes.length} routes (${post.summary.dedupedRoutes} after dedup)`);
  return post.routes;
}

export async function crawlFromSeeds(
  browser: BrowserMcpAdapter,
  opts: CrawlOpts
): Promise<CrawlResult> {
  if (opts.seedRoutes.length === 0) {
    return {
      pages: [],
      visited: [],
      skipped: [],
      hitMaxPages: false,
      hitMaxDepth: false,
      telemetry: { seedRoutes: 0, staticNavigations: 0, runtimeEnumRoutes: 0, crawlLinkRoutes: 0, visitedPages: 0, stateKindPages: 0 },
    };
  }

  const visited = new Map<string, DiscoveredPage | null>();
  const queue: QueueItem[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  let hitMaxPages = false;
  let hitMaxDepth = false;

  const telemetry: CrawlTelemetry = {
    seedRoutes: 0,
    staticNavigations: 0,
    runtimeEnumRoutes: 0,
    crawlLinkRoutes: 0,
    visitedPages: 0,
    stateKindPages: 0,
  };

  // Source 1: static seed pages
  for (const seed of opts.seedRoutes) {
    queue.push({ kind: 'url', url: opts.baseUrl + seed, depth: 0, source: 'crawl-seed' });
    telemetry.seedRoutes++;
  }

  // Source 2: static navigations from surface_list_navigations
  if (opts.surface) {
    const self = await opts.surface.surface_describe_self();
    if (self.capabilities.listNavigations) {
      const nav = await opts.surface.surface_list_navigations();
      for (const n of nav.navigations) {
        if (n.confidence === 'low' && !opts.includeLowConfidence) continue;
        if (n.kind === 'url' || n.kind === 'hash') {
          const target = n.kind === 'hash' ? `/${n.target}` : n.target;
          queue.push({ kind: 'url', url: opts.baseUrl + target, depth: 0, source: 'static-navigation' });
          telemetry.staticNavigations++;
        } else {
          // kind: 'state'
          const stateCount = queue.filter(q => q.kind === 'state').length;
          if (stateCount >= (opts.maxStateNavigations ?? 30)) {
            skipped.push({ url: `${'/'}#state=${n.stateVar ?? '?'}=${n.target}`, reason: 'state_cap_hit' });
            continue;
          }
          queue.push({
            kind: 'state',
            baseRoute: '/',
            stateVar: n.stateVar ?? '',
            stateValue: n.target,
            trigger: n.triggerSelectorHint,
            depth: 0,
            source: 'static-navigation',
          });
          telemetry.staticNavigations++;
        }
      }
    } else {
      log.info('listNavigations unavailable on this surface');
    }
  }

  let runtimeEnumDone = false;
  let stateKindVisited = 0;

  while (queue.length > 0) {
    if (visited.size >= opts.maxPages) { hitMaxPages = true; break; }
    const item = queue.shift();
    if (!item) break;

    const key = queueKey(item, opts.followQueryParams);
    if (visited.has(key)) continue;

    // Cap state items after initial seed to prevent runaway crawls
    if (item.kind === 'state' && stateKindVisited >= (opts.maxStateNavigations ?? 30)) {
      skipped.push({ url: key, reason: 'state_cap_hit' });
      continue;
    }

    visited.set(key, null); // reserve slot

    log.info(`crawl: visiting ${visited.size}/${opts.maxPages} depth=${item.depth} queue=${queue.length} ${key}`);

    let walkResult: DomWalkResult | null = null;
    let currentPageUrl = item.kind === 'url' ? item.url : opts.baseUrl + item.baseRoute;

    try {
      if (item.kind === 'url') {
        walkResult = await Promise.race([
          walkDom(browser, item.url, opts.runId, opts.extraHeaders),
          timeoutAfter(opts.walkTimeoutMs, 'walk timeout'),
        ]);
      } else {
        // State navigation: navigate to base if needed, then click the trigger
        const evalResult = await browser.evaluate('location.pathname');
        const currentPath = evalResult.value as string;
        if (currentPath !== item.baseRoute) {
          await browser.navigate(opts.baseUrl + item.baseRoute, opts.extraHeaders);
          currentPageUrl = opts.baseUrl + item.baseRoute;
        }

        const selector = await resolveTriggerSelector(browser, item.trigger);
        if (!selector) {
          skipped.push({ url: key, reason: 'trigger_not_found' });
          visited.delete(key);
          continue;
        }

        await browser.click(selector);
        await new Promise<void>(r => { setTimeout(r, opts.stateSettleMs ?? 250); });
        walkResult = await collectDomOnly(browser);
        stateKindVisited++;
      }
    } catch (err) {
      log.warn(`crawl: walk failed ${key}`, err);
      skipped.push({ url: key, reason: `walk_failed: ${String(err).slice(0, 200)}` });
      visited.delete(key);
      continue;
    }

    const page = item.kind === 'url'
      ? buildUrlPage(walkResult, new URL(currentPageUrl), opts.followQueryParams, item.source)
      : buildStatePage(walkResult, item);

    visited.set(key, page);

    // Source 3: runtime enum — once per crawl, after first depth-0 walk
    if (!runtimeEnumDone && item.depth === 0 && !opts.disableRuntimeEnum && opts.surface) {
      runtimeEnumDone = true;
      const runtimeRoutes = await runRuntimeEnum(browser, opts.surface);
      for (const r of runtimeRoutes) {
        const u = opts.baseUrl + r.path;
        const rKey = queueKey({ kind: 'url', url: u, depth: 1, source: 'runtime-enum' }, opts.followQueryParams);
        if (!visited.has(rKey) && !queue.some(q => queueKey(q, opts.followQueryParams) === rKey)) {
          queue.push({ kind: 'url', url: u, depth: 1, source: 'runtime-enum' });
          telemetry.runtimeEnumRoutes++;
        }
      }
    }

    if (item.depth + 1 > opts.maxDepth) { hitMaxDepth = true; continue; }

    // Follow <a href> links from DOM walk
    for (const link of walkResult.links) {
      const abs = normalizeLink(link, currentPageUrl, opts);
      if (abs === null) {
        if (!link.startsWith('#')) {
          skipped.push({ url: link, reason: 'off_origin_or_unsupported' });
        }
        continue;
      }
      const childItem: QueueItem = { kind: 'url', url: abs, depth: item.depth + 1, source: 'crawl-link' };
      const childKey = queueKey(childItem, opts.followQueryParams);
      if (visited.has(childKey)) continue;
      if (queue.some(q => queueKey(q, opts.followQueryParams) === childKey)) continue;
      queue.push(childItem);
      telemetry.crawlLinkRoutes++;
    }
  }

  const pages = [...visited.values()].filter((p): p is DiscoveredPage => p !== null);
  telemetry.visitedPages = pages.length;
  telemetry.stateKindPages = pages.filter(p => p.kind === 'state').length;

  return { pages, visited: [...visited.keys()], skipped, hitMaxPages, hitMaxDepth, telemetry };
}
