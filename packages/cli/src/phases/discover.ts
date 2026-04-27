// Phase 1: discover — three-source discovery (§ 3.3).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { BugHunterConfig, DiscoveryOutput, DiscoveredPage, ToolMeta, SkippedItem, VisualBaselineEntry, VisionConfig } from '../types.js';
import { isDynamicRoute, expandDynamicRoute } from '../discovery/filesystem-pages.js';
import { discoverPages } from '../discovery/pages.js';
import { walkDom } from '../discovery/dom-walker.js';
import { crawlFromSeeds } from '../discovery/crawler.js';
import { loginInBrowser } from '../discovery/browser-login.js';
import { crossRefForms } from '../discovery/form-cross-ref.js';
import { collapseElements } from '../discovery/element-collapse.js';
import { classifyVisualAnomalies } from '../classify/vision.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import { log } from '../log.js';
import micromatch from 'micromatch';

const VISION_BASELINE_SETTLE_MS = 1500;

export async function runDiscover(
  projectDir: string,
  config: BugHunterConfig,
  roles: string[],
  runId: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter,
  routePattern?: string,
  visionClient?: VisionClientInterface,
  visionBudget?: VisionBudget,
): Promise<DiscoveryOutput> {
  const skipList: SkippedItem[] = [];

  // Browser-side login — runs once per discover phase, before page discovery.
  const loginCfg = config.browserLogin;
  const browserLoginEnabled = (loginCfg?.enabled ?? true) && !!browser;

  if (browserLoginEnabled && browser) {
    const loginRole = loginCfg?.role ?? roles[0];
    if (!loginRole) {
      log.info('browser_login: no roles configured; skipping');
    } else {
      const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
      const result = await loginInBrowser(browser, surface, {
        role: loginRole,
        baseUrl,
        verifyTimeoutMs: loginCfg?.verifyTimeoutMs ?? 10_000,
        verifyPollMs: loginCfg?.verifyPollMs ?? 500,
      });
      if (result.ok) {
        log.info(`browser_login: success (role=${loginRole}, cookies=${result.cookies.length}, url=${result.finalUrl})`);
      } else {
        log.warn(`browser_login: skipped (role=${loginRole}, reason=${result.reason}): ${result.detail}`);
        skipList.push({ route: '<login>', reason: `browser_login_${result.reason}` });
      }
    }
  } else if (!browser) {
    log.info('browser_login: skipped (no browser adapter)');
  }

  // Source 1: SurfaceMCP catalog
  const catalog = await surface.surface_list_tools();
  const apiTools: ToolMeta[] = catalog.tools;

  // Source 2: page discovery (stack-aware via SurfaceMCP surface_describe_self)
  const rawPages = await discoverPages(projectDir, surface);
  log.info(`Discovered ${rawPages.length} pages`);

  // Split seed entries from static entries
  const seedEntries = rawPages.filter(p => p.source === 'crawl_seed');
  const staticEntries = rawPages.filter(p => p.source !== 'crawl_seed');

  // Crawl-based discovery: triggered by seed pages
  const crawledPages: DiscoveredPage[] = [];
  if (seedEntries.length > 0 && browser && config.crawl?.enabled !== false) {
    const seedRoutes = seedEntries.map(s => s.route);
    const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
    log.info(`crawl: starting from ${seedRoutes.length} seed(s): ${seedRoutes.join(', ')}`);
    const result = await crawlFromSeeds(browser, {
      baseUrl,
      seedRoutes,
      maxPages: config.crawl?.maxPages ?? 50,
      maxDepth: config.crawl?.maxDepth ?? 3,
      followQueryParams: config.crawl?.followQueryParams ?? false,
      walkTimeoutMs: config.crawl?.walkTimeoutMs ?? 30_000,
      sameOriginOnly: config.crawl?.sameOriginOnly ?? true,
      runId,
      extraHeaders: config.extraHeaders,
    });
    log.info(
      `crawl: visited ${result.pages.length} pages${ 
      result.hitMaxPages ? ' (max-pages cap hit)' : '' 
      }${result.hitMaxDepth ? ' (max-depth cap hit)' : ''}`
    );
    crawledPages.push(...result.pages);
    for (const s of result.skipped) {
      skipList.push({ route: s.url, reason: `crawl_skipped: ${s.reason}` });
    }
  } else if (seedEntries.length > 0 && !browser) {
    log.warn('crawl: seed pages detected but no browser available; crawl skipped');
  }

  // Adapt static entries to the shape used by the rest of this function
  const fsPages = staticEntries.map(p => ({
    route: p.route,
    sourceFile: p.sourceFile ?? '',
  }));

  // Expand dynamic routes using discoveryFixtures
  const expandedRoutes: Array<{ route: string; sourceFile?: string }> = [];
  for (const p of fsPages) {
    if (isDynamicRoute(p.route)) {
      const fixtures = config.discoveryFixtures ?? {};
      const expanded = expandDynamicRoute(p.route, fixtures);
      if (expanded.length === 0) {
        skipList.push({ route: p.route, reason: 'discovery_skipped: missing_fixture' });
        log.warn(`Dynamic route ${p.route} skipped — no discoveryFixtures configured`);
      } else {
        expandedRoutes.push(...expanded.map(r => ({ route: r, sourceFile: p.sourceFile })));
      }
    } else {
      expandedRoutes.push({ route: p.route, sourceFile: p.sourceFile });
    }
  }

  // Apply route pattern filter
  const routes = routePattern
    ? expandedRoutes.filter(r => micromatch([r.route], [routePattern]).length > 0)
    : expandedRoutes;

  // Deduplicate against routeAliases
  const seen = new Set<string>();
  const dedupRoutes = routes.filter(r => {
    const canonical = config.routeAliases?.[r.route] ?? r.route;
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });

  // Exclude configured routes
  const excluded = config.excludedRoutes ?? [];
  const filteredRoutes = excluded.length > 0
    ? dedupRoutes.filter(r => !micromatch([r.route], excluded).length)
    : dedupRoutes;

  // Source 3: DOM walk per role per page
  const pages: DiscoveredPage[] = [];
  // appBaseUrl is the base URL of the app under test (e.g. "http://localhost:3002").
  // Falls back to surfaceMcpUrl origin only when appBaseUrl is not configured.
  const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;

  for (const { route, sourceFile } of filteredRoutes) {
    const pageElements: DiscoveredPage = {
      route,
      sourceFile,
      elements: [],
      forms: [],
      links: [],
    };

    if (browser) {
      // Walk DOM as first role (read-only discovery; auth state from SurfaceMCP)
      try {
        const domResult = await walkDom(browser, baseUrl + route, runId, config.extraHeaders);
        const collapsed = collapseElements(domResult.elements.filter(e => !e.disabled));
        const pagePathForSurface = sourceFile
          ? path.relative(projectDir, sourceFile)
          : route;
        const crossRefed = await crossRefForms(domResult.forms, pagePathForSurface, surface);
        // Filter external-side-effect forms/buttons
        const safeApiToolIds = new Set(
          apiTools
            .filter(t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed)
            .map(t => t.toolId)
        );
        const safeForms = crossRefed.filter(f => {
          if (!f.apiToolIds?.length) return false;
          return f.apiToolIds.some(id => safeApiToolIds.has(id));
        });

        pageElements.elements = collapsed;
        pageElements.forms = safeForms;
        pageElements.links = domResult.links;
        log.info(`DOM walk for ${route}`, { elements: collapsed.length, forms: safeForms.length });
      } catch (err) {
        log.warn(`DOM walk failed for ${route}`, err);
        skipList.push({ route, reason: `dom_walk_failed: ${String(err)}` });
      }
    }

    pages.push(pageElements);
  }

  // Merge crawled pages: apply routeAliases dedup and excludedRoutes filter
  if (crawledPages.length > 0) {
    for (const p of crawledPages) {
      const canonical = config.routeAliases?.[p.route] ?? p.route;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      if (config.excludedRoutes && config.excludedRoutes.length > 0 && micromatch([p.route], config.excludedRoutes).length > 0) continue;
      pages.push(p);
    }
  }

  // Filter external tools
  const filteredApiTools = apiTools.filter(
    t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed
  );

  const externalSkips = apiTools
    .filter(t => t.sideEffectClass === 'external' && !config.externalIntegrationsAllowed)
    .map(t => ({ toolId: t.toolId, reason: 'external_side_effect' }));

  // Per-page baseline vision pass (§ 4.3.1).
  const visualBaselineDetections = await runVisualBaseline(pages, config, roles, browser, visionClient, visionBudget);

  return {
    pages,
    apiTools: filteredApiTools,
    skipList: [...skipList, ...externalSkips],
    visualBaselineDetections,
  };
}

async function runVisualBaseline(
  pages: DiscoveredPage[],
  config: BugHunterConfig,
  roles: string[],
  browser: BrowserMcpAdapter | undefined,
  visionClient: VisionClientInterface | undefined,
  visionBudget: VisionBudget | undefined,
): Promise<VisualBaselineEntry[]> {
  if (!browser || !visionClient || !visionBudget || !config.vision?.enabled) return [];

  const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
  const role = roles[0] ?? 'anonymous';
  const visionConfig: VisionConfig = config.vision;
  const concurrency = visionConfig.concurrency ?? 4;

  // Phase 1: take screenshots sequentially (one tab at a time).
  const screenshotEntries: Array<{ page: DiscoveredPage; screenshotPath: string }> = [];

  for (const page of pages) {
    const routeSlug = page.route.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '') || 'root';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-vision-'));
    const screenshotPath = path.join(tmpDir, `vision-baseline-${routeSlug}.png`);

    try {
      await browser.withTab(`${baseUrl}${page.route}`, undefined, async scope => {
        await new Promise<void>(r => { setTimeout(r, VISION_BASELINE_SETTLE_MS); });
        await scope.screenshot(screenshotPath);
      });
    } catch (err) {
      log.warn(`vision baseline: failed to open/screenshot page ${page.route}`, { err: String(err) });
      continue;
    }

    // Dedup by screenshot hash (no API call consumed yet)
    try {
      const buf = fs.readFileSync(screenshotPath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (!visionBudget.tryConsumeHash(hash)) {
        log.info(`vision baseline: skipping duplicate screenshot for ${page.route}`);
        continue;
      }
    } catch {
      continue;
    }

    // Gate the API call budget here (after confirming screenshot is unique)
    if (!visionBudget.tryConsume()) {
      log.info('vision: per-run budget exhausted during baseline');
      break;
    }

    screenshotEntries.push({ page, screenshotPath });
  }

  // Phase 2: classify in concurrency-bounded pool
  const results: VisualBaselineEntry[] = [];
  const inFlight = new Set<Promise<void>>();

  for (const { page, screenshotPath } of screenshotEntries) {
    const p = classifyVisualAnomalies({
      screenshotPath,
      url: `${baseUrl}${page.route}`,
      action: { kind: 'render' },
      role,
      config: visionConfig,
      client: visionClient,
      budget: visionBudget,
    }).then(detections => {
      for (const detection of detections) {
        results.push({ page, detection, screenshotPath });
      }
      inFlight.delete(p);
    }).catch(err => {
      log.warn(`vision baseline: classification error for ${page.route}`, { err: String(err) });
      inFlight.delete(p);
    });

    inFlight.add(p);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }

  await Promise.allSettled(inFlight);
  log.info(`vision baseline: found ${results.length} anomaly/anomalies across ${screenshotEntries.length} page(s)`);
  return results;
}
