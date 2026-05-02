// Phase 1: discover — three-source discovery (§ 3.3).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { BugDetection, BugHunterConfig, DiscoveryOutput, DiscoveredPage, ToolMeta, SkippedItem, VisualBaselineEntry, VisionConfig, CrawlTelemetry, VisionBaselineTelemetry, VisionConsistencyTelemetry } from '../types.js';
import { runStaticAnalysis } from '../static/runner.js';
import { gitleaksTool } from '../static/tools/gitleaks.js';
import { npmAuditTool } from '../static/tools/npm-audit.js';
import { semgrepTool } from '../static/tools/semgrep.js';
import { eslintNoEmptyTool } from '../static/tools/eslint-no-empty.js';
import { isDynamicRoute, expandDynamicRoute } from '../discovery/filesystem-pages.js';
import { discoverPages } from '../discovery/pages.js';
import { walkDom } from '../discovery/dom-walker.js';
import { crawlFromSeeds } from '../discovery/crawler.js';
import { loginInBrowser } from '../discovery/browser-login.js';
import { crossRefForms } from '../discovery/form-cross-ref.js';
import { collapseElements } from '../discovery/element-collapse.js';
import { classifyVisualAnomaliesConsistent } from '../classify/vision.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import { scanCssForHoverOnly } from '../static/tools/hover-only-affordance.js';
import { log } from '../log.js';
import micromatch from 'micromatch';
import { runLocaleStress, captureLtrRectMap } from './locale-stress.js';
import { runHardcodedStringsScanner } from '../static/tools/hardcoded-strings.js';

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
  const browserLoginEnabled = (loginCfg?.enabled ?? true) && browser !== undefined;

  if (browserLoginEnabled) {
    const loginRole = loginCfg?.role ?? roles[0];
    if (loginRole === '') {
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
  } else if (browser === undefined) {
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
  let crawlTelemetry: CrawlTelemetry | undefined;
  if (seedEntries.length > 0 && browser !== undefined && config.crawl?.enabled !== false) {
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
      surface,
      includeLowConfidence: config.crawl?.includeLowConfidence ?? false,
      stateSettleMs: config.crawl?.stateSettleMs ?? 250,
      disableRuntimeEnum: config.crawl?.disableRuntimeEnum ?? false,
      maxStateNavigations: config.crawl?.maxStateNavigations ?? 30,
    });
    log.info(
      `crawl: visited ${result.pages.length} pages${
      result.hitMaxPages ? ' (max-pages cap hit)' : ''
      }${result.hitMaxDepth ? ' (max-depth cap hit)' : ''}`
    );
    crawledPages.push(...result.pages);
    crawlTelemetry = result.telemetry;
    for (const s of result.skipped) {
      skipList.push({ route: s.url, reason: `crawl_skipped: ${s.reason}` });
    }
  } else if (seedEntries.length > 0 && browser === undefined) {
    log.warn('crawl: seed pages detected but no browser available; crawl skipped');
  }

  // Adapt static entries to the shape used by the rest of this function
  const fsPages = staticEntries.map(p => ({
    route: p.route,
    sourceFile: p.sourceFile ?? '',
  }));

  // Expand dynamic routes using discoveryFixtures
  const expandedRoutes: Array<{ route: string; sourceFile?: string }> = [];
  const fixtureUnresolvableRoutes: string[] = [];
  for (const p of fsPages) {
    if (isDynamicRoute(p.route)) {
      const fixtures = config.discoveryFixtures ?? {};
      const expanded = expandDynamicRoute(p.route, fixtures);
      if (expanded.length === 0) {
        skipList.push({ route: p.route, reason: 'discovery_skipped: missing_fixture' });
        log.warn(`Dynamic route ${p.route} skipped — no discoveryFixtures configured`);
        fixtureUnresolvableRoutes.push(p.route);
      } else {
        expandedRoutes.push(...expanded.map(r => ({ route: r, sourceFile: p.sourceFile })));
      }
    } else {
      expandedRoutes.push({ route: p.route, sourceFile: p.sourceFile });
    }
  }

  // Apply route pattern filter
  const routes = routePattern !== undefined
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
    ? dedupRoutes.filter(r => micromatch([r.route], excluded).length === 0)
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

    if (browser !== undefined) {
      // Walk DOM as first role (read-only discovery; auth state from SurfaceMCP)
      try {
        const domResult = await walkDom(browser, baseUrl + route, runId, config.extraHeaders);
        const collapsed = collapseElements(domResult.elements.filter(e => !e.disabled));
        const pagePathForSurface = (sourceFile !== undefined && sourceFile !== '')
          ? path.relative(projectDir, sourceFile)
          : route;
        const crossRefed = await crossRefForms(domResult.forms, pagePathForSurface, surface);
        // Filter external-side-effect forms/buttons
        const safeApiToolIds = new Set(
          apiTools
            .filter(t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed === true)
            .map(t => t.toolId)
        );
        const safeForms = crossRefed.filter(f => {
          const ids = f.apiToolIds;
          if (ids === undefined || ids.length === 0) return false;
          return ids.some(id => safeApiToolIds.has(id));
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
      if (config.excludedRoutes !== undefined && config.excludedRoutes.length > 0 && micromatch([p.route], config.excludedRoutes).length > 0) continue;
      pages.push(p);
    }
  }

  // Filter external tools
  const filteredApiTools = apiTools.filter(
    t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed === true
  );

  const externalSkips = apiTools
    .filter(t => t.sideEffectClass === 'external' && config.externalIntegrationsAllowed !== true)
    .map(t => ({ toolId: t.toolId, reason: 'external_side_effect' }));

  // Per-page baseline vision pass (§ 4.3.1).
  const visionResult = await runVisualBaseline(pages, config, roles, browser, visionClient, visionBudget);

  // Static analysis pass (§ 3.4 — default-on; disable via staticAnalysis.enabled=false).
  const staticDetections = await runStaticAnalysisPhase(projectDir, config);

  // v0.37: locale-stress post-discovery phase (§4.1) — opt-in via --locale-stress.
  let localeStressDetections: BugDetection[] | undefined;
  if (config.localeStress === true && browser !== undefined && visionClient !== undefined && visionBudget !== undefined) {
    const allLocaleDetections: BugDetection[] = [];
    for (const page of pages) {
      const url = page.route;
      try {
        const ltrRectMap = await captureLtrRectMap(browser);
        const output = await runLocaleStress({
          url,
          domWalk: { elements: page.elements, forms: page.forms, links: page.links },
          ltrScreenshotPath: '',
          ltrRectMap,
          browser,
          vision: visionClient,
          visionBudget,
          runId,
          outDir: projectDir,
        });
        allLocaleDetections.push(...output.detections);
      } catch (err) {
        log.warn('locale-stress: page failed', { url, err: String(err) });
      }
    }
    if (allLocaleDetections.length > 0) localeStressDetections = allLocaleDetections;
  }

  return {
    pages,
    apiTools: filteredApiTools,
    skipList: [...skipList, ...externalSkips],
    visualBaselineDetections: visionResult.entries,
    crawlTelemetry,
    staticDetections,
    visionBaselineTelemetry: visionResult.telemetry,
    visionConsistencyTelemetry: visionResult.consistencyTelemetry,
    visionByViewport: visionResult.byViewport,
    fixtureUnresolvableRoutes: fixtureUnresolvableRoutes.length > 0 ? fixtureUnresolvableRoutes : undefined,
    localeStressDetections,
  };
}

// Default login-path globs for auth-health probing (R4: configurable in future).
const DEFAULT_LOGIN_GLOBS = ['/login', '/auth/login', '/signin'];

/**
 * Returns true when the singleton tab is on an authenticated route, false if on a login redirect.
 * Navigates to the baseUrl root first so SPA post-login redirects (e.g. / -> /dashboard) settle
 * before we sample location.pathname. Without this, the probe sees the post-login /login pathname
 * if the user just authenticated and the SPA hasn't yet redirected.
 */
async function probeAuthHealth(browser: BrowserMcpAdapter, loginGlobs: string[], baseUrl: string): Promise<boolean> {
  try {
    await browser.navigate(baseUrl);
    await new Promise<void>(r => { setTimeout(r, 1500); });
    const result = await browser.evaluate('location.pathname');
    const pathname = String(result.value ?? '');
    return !loginGlobs.some(glob => pathname === glob || pathname.startsWith(`${glob}/`));
  } catch {
    return false;
  }
}

function viewportHeight(width: number): number {
  return Math.round(width * 0.65);
}

// Fallback for configs that don't go through Zod (e.g. raw BugHunterConfig in tests).
// Zod applies the [375, 768, 1280] default at parse time; this keeps v0.13 compat for mocks.
const DEFAULT_VIEWPORTS = [1280];

type ScreenshotEntry = { page: DiscoveredPage; screenshotPath: string; viewportPx: number };

type ScreenshotPhaseResult = {
  entries: ScreenshotEntry[];
  telemetry: VisionBaselineTelemetry;
  byViewport: Map<number, { uniqueScreenshots: number; deduped: number }>;
};

/** Navigate the singleton tab to the target route; returns false if auth degraded (EC-1). */
async function navigateForScreenshot(
  page: DiscoveredPage,
  browser: BrowserMcpAdapter,
  baseUrl: string,
  loginGlobs: string[],
  loginEnabled: boolean,
): Promise<'ok' | 'skip' | 'auth_lost'> {
  if (page.kind === 'state' && page.stateContext !== undefined) {
    const ctx = page.stateContext;
    await browser.navigate(`${baseUrl}${ctx.baseRoute}`, undefined);
    await new Promise<void>(r => { setTimeout(r, 250); });
    const clickRes = await browser.clickByHint(ctx.triggerHint);
    if (!clickRes.clicked) {
      log.warn(`vision baseline: state trigger failed for ${page.route} (${clickRes.reason})`);
      return 'skip';
    }
    return 'ok';
  }
  await browser.navigate(`${baseUrl}${page.route}`, undefined);
  if (!loginEnabled) return 'ok';
  const pathname = await browser.evaluate('location.pathname').then(r => String(r.value ?? '')).catch(() => '');
  const requestedPath = page.route.split('?')[0] ?? page.route;
  const landedOnLogin = loginGlobs.some(g => pathname === g || pathname.startsWith(`${g}/`));
  const requestedLogin = loginGlobs.some(g => requestedPath === g || requestedPath.startsWith(`${g}/`));
  if (landedOnLogin && !requestedLogin) {
    log.warn(`vision_baseline_auth_lost_mid_loop: redirected to ${pathname} on route ${page.route}`);
    return 'auth_lost';
  }
  return 'ok';
}

// V13_INVARIANT: do not call browser.withTab in screenshotPhase — singleton tab only.
async function screenshotPhase(
  pages: DiscoveredPage[],
  browser: BrowserMcpAdapter,
  visionBudget: VisionBudget,
  baseUrl: string,
  loginGlobs: string[],
  settleMs: number,
  loginEnabled: boolean,
  viewports: number[],
): Promise<ScreenshotPhaseResult> {
  const telemetry: VisionBaselineTelemetry = { uniqueScreenshots: 0, dedupedScreenshots: 0, authLostMidLoop: false, screenshotsTooSmall: 0 };
  const entries: ScreenshotEntry[] = [];
  const byViewport = new Map<number, { uniqueScreenshots: number; deduped: number }>();
  for (const vp of viewports) byViewport.set(vp, { uniqueScreenshots: 0, deduped: 0 });

  let budgetExhausted = false;

  for (const page of pages) {
    if (budgetExhausted) break;

    let navResult: 'ok' | 'skip' | 'auth_lost';
    try {
      navResult = await navigateForScreenshot(page, browser, baseUrl, loginGlobs, loginEnabled);
    } catch (err) {
      log.warn(`vision baseline: failed to open/screenshot page ${page.route}`, { err: String(err) });
      continue;
    }
    if (navResult === 'auth_lost') { telemetry.authLostMidLoop = true; break; }
    if (navResult === 'skip') continue;

    // v0.17: iterate viewports smallest-to-largest within each page.
    // Settle delay applies per resize (spec §4.2), so it lives inside the viewport loop.
    for (const vpWidth of viewports) {
      if (browser.setViewport !== undefined) {
        const vpResult = await browser.setViewport(vpWidth, viewportHeight(vpWidth));
        if (!vpResult.ok) {
          log.warn(`vision baseline: setViewport failed for ${page.route} at ${vpWidth}px (${vpResult.reason}); skipping remaining viewports`);
          break;
        }
      }

      await new Promise<void>(r => { setTimeout(r, settleMs); });

      const routeSlugRaw = page.route.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '');
      const routeSlug = routeSlugRaw !== '' ? routeSlugRaw : 'root';
      const screenshotPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-vision-')), `vision-baseline-${routeSlug}-${vpWidth}.png`);

      try {
        await browser.screenshot(screenshotPath);
      } catch (err) {
        log.warn(`vision baseline: failed to screenshot page ${page.route} at ${vpWidth}px`, { err: String(err) });
        continue;
      }

      let buf: Buffer;
      try { buf = fs.readFileSync(screenshotPath); } catch { continue; }
      if (buf.length < 1024) {
        log.info(`vision baseline: screenshot_too_small for ${page.route} at ${vpWidth}px (${buf.length} bytes)`);
        telemetry.screenshotsTooSmall++;
        continue;
      }

      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const vpTelem = byViewport.get(vpWidth) ?? { uniqueScreenshots: 0, deduped: 0 };
      if (!visionBudget.tryConsumeHash(hash)) {
        log.info(`vision baseline: skipping duplicate screenshot for ${page.route} at ${vpWidth}px`);
        telemetry.dedupedScreenshots++;
        vpTelem.deduped++;
        byViewport.set(vpWidth, vpTelem);
        continue;
      }
      if (!visionBudget.tryConsume()) {
        log.info('vision: per-run budget exhausted during baseline');
        budgetExhausted = true;
        break;
      }

      telemetry.uniqueScreenshots++;
      vpTelem.uniqueScreenshots++;
      byViewport.set(vpWidth, vpTelem);
      entries.push({ page, screenshotPath, viewportPx: vpWidth });
    }

    // Restore desktop viewport after processing each page (EC-10: avoid stuck-mobile state).
    if (browser.setViewport !== undefined) {
      await browser.setViewport(1280, viewportHeight(1280)).catch(() => undefined);
    }
  }

  return { entries, telemetry, byViewport };
}

type ClassifyPhaseResult = {
  entries: VisualBaselineEntry[];
  consistencyTelemetry: VisionConsistencyTelemetry;
  byViewport: Map<number, { anomaliesFound: number }>;
};

async function classifyPhase(
  screenshotEntries: ScreenshotEntry[],
  baseUrl: string,
  role: string,
  visionConfig: VisionConfig,
  visionClient: VisionClientInterface,
  visionBudget: VisionBudget,
): Promise<ClassifyPhaseResult> {
  const results: VisualBaselineEntry[] = [];
  const byViewport = new Map<number, { anomaliesFound: number }>();
  const consistencyRuns = visionConfig.consistencyRuns ?? 2;
  const agreementMode = visionConfig.agreementMode ?? 'strict';
  const telem: VisionConsistencyTelemetry = {
    runsPerScreenshot: consistencyRuns,
    agreementMode,
    totalCalls: 0,
    totalSucceeded: 0,
    droppedByDisagreement: 0,
    agreementRate: 1,
    screenshotsWithAnomalies: 0,
    screenshotsClean: 0,
  };
  let agreementRateSum = 0;

  const inFlight = new Set<Promise<void>>();
  const concurrency = visionConfig.concurrency ?? 4;

  for (const { page, screenshotPath, viewportPx } of screenshotEntries) {
    const p = classifyVisualAnomaliesConsistent({
      screenshotPath,
      url: `${baseUrl}${page.route}`,
      action: { kind: 'render' },
      role,
      config: visionConfig,
      client: visionClient,
      budget: visionBudget,
      consistencyRuns,
      agreementMode,
    }).then(consistent => {
      telem.totalCalls += consistent.callsAttempted;
      telem.totalSucceeded += consistent.callsSucceeded;
      telem.droppedByDisagreement += consistent.droppedByDisagreement;
      const hadAnomalies = consistent.perRunDetections.some(r => r.length > 0);
      if (hadAnomalies) {
        telem.screenshotsWithAnomalies++;
        agreementRateSum += consistent.agreementRate;
      } else {
        telem.screenshotsClean++;
      }
      const vpTelem = byViewport.get(viewportPx) ?? { anomaliesFound: 0 };
      for (const detection of consistent.detections) {
        // v0.17: tag detection with viewport context.
        const taggedDetection = { ...detection, visualContext: { viewportPx } };
        results.push({ page, detection: taggedDetection, screenshotPath });
        vpTelem.anomaliesFound++;
      }
      byViewport.set(viewportPx, vpTelem);
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

  telem.agreementRate = telem.screenshotsWithAnomalies > 0
    ? agreementRateSum / telem.screenshotsWithAnomalies
    : 1;

  return { entries: results, consistencyTelemetry: telem, byViewport };
}

type VisualBaselineResult = {
  entries: VisualBaselineEntry[];
  telemetry: VisionBaselineTelemetry | undefined;
  consistencyTelemetry: VisionConsistencyTelemetry | undefined;
  byViewport: Record<number, { uniqueScreenshots: number; anomaliesFound: number; deduped: number }> | undefined;
};

export async function runVisualBaseline(
  pages: DiscoveredPage[],
  config: BugHunterConfig,
  roles: string[],
  browser: BrowserMcpAdapter | undefined,
  visionClient: VisionClientInterface | undefined,
  visionBudget: VisionBudget | undefined,
): Promise<VisualBaselineResult> {
  if (browser === undefined || visionClient === undefined || visionBudget === undefined || config.vision?.enabled !== true) {
    return { entries: [], telemetry: undefined, consistencyTelemetry: undefined, byViewport: undefined };
  }

  const baseUrl = config.appBaseUrl ?? new URL(config.surfaceMcpUrl).origin;
  const role = roles[0] ?? 'anonymous';
  const visionConfig: VisionConfig = config.vision;
  const loginEnabled = config.browserLogin?.enabled !== false;
  const settleMs = Math.max(VISION_BASELINE_SETTLE_MS, visionConfig.preScreenshotSettleMs ?? 2500);
  const viewports = visionConfig.viewports ?? DEFAULT_VIEWPORTS;

  // One-time auth health probe before the screenshot loop (Design C §4).
  if (loginEnabled) {
    const isAuthed = await probeAuthHealth(browser, DEFAULT_LOGIN_GLOBS, baseUrl);
    if (!isAuthed) {
      log.warn('vision baseline: singleton tab not authenticated (auth_lost_pre_loop); skipping vision pass');
      return {
        entries: [],
        telemetry: { uniqueScreenshots: 0, dedupedScreenshots: 0, authLostMidLoop: true, screenshotsTooSmall: 0 },
        consistencyTelemetry: undefined,
        byViewport: undefined,
      };
    }
  }

  // Phase 1: sequential singleton-tab screenshots across all viewports.
  const { entries: screenshotEntries, telemetry, byViewport: screenshotByVp } = await screenshotPhase(
    pages, browser, visionBudget, baseUrl, DEFAULT_LOGIN_GLOBS, settleMs, loginEnabled, viewports,
  );

  // Phase 2: classify with consistency aggregation in concurrency-bounded pool.
  const { entries, consistencyTelemetry, byViewport: classifyByVp } = await classifyPhase(
    screenshotEntries, baseUrl, role, visionConfig, visionClient, visionBudget,
  );

  // Merge per-viewport telemetry from both phases.
  const byViewport: Record<number, { uniqueScreenshots: number; anomaliesFound: number; deduped: number }> = {};
  for (const vp of viewports) {
    const ss = screenshotByVp.get(vp) ?? { uniqueScreenshots: 0, deduped: 0 };
    const cl = classifyByVp.get(vp) ?? { anomaliesFound: 0 };
    byViewport[vp] = { uniqueScreenshots: ss.uniqueScreenshots, anomaliesFound: cl.anomaliesFound, deduped: ss.deduped };
  }

  log.info(`vision baseline: found ${entries.length} anomaly/anomalies across ${screenshotEntries.length} page(s)`);
  return { entries, telemetry, consistencyTelemetry, byViewport };
}

async function runStaticAnalysisPhase(
  projectDir: string,
  config: BugHunterConfig,
): Promise<BugDetection[]> {
  if (config.staticAnalysis?.enabled === false) {
    log.info('static: staticAnalysis.enabled=false; skipping');
    return [];
  }

  const tools = [gitleaksTool, npmAuditTool, semgrepTool, eslintNoEmptyTool];
  const runs = await runStaticAnalysis(projectDir, tools);

  const detections: BugDetection[] = [];
  for (const run of runs) {
    if (run.warnings.length > 0) {
      log.warn(`static: tool ${run.toolId} warnings`, { warnings: run.warnings });
    }
    detections.push(...run.detections);
  }

  // v0.37: hardcoded-strings scanner — gated by localeStress flag.
  if (config.localeStress === true) {
    const hardcodedDetections = await runHardcodedStringsScanner({ projectRoot: projectDir });
    detections.push(...hardcodedDetections);
  }

  if (detections.length > 0) {
    log.info(`static: found ${detections.length} detection(s) across ${runs.filter(r => !r.skipped).length} tool(s)`);
  }

  // v0.41: hover-only CSS scan when mobile mode is enabled.
  if (config.mobile?.enabled === true && config.mobile.hoverOnlyScan !== false) {
    const cssDetections = runHoverOnlyCssScan(projectDir);
    detections.push(...cssDetections);
  }

  return detections;
}

/** Scan all .css files in projectDir for hover-only affordances. */
function runHoverOnlyCssScan(projectDir: string): BugDetection[] {
  const detections: BugDetection[] = [];
  const cssFiles: string[] = [];

  function collectCss(dir: string, depth: number): void {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectCss(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.css')) {
        cssFiles.push(full);
      }
    }
  }

  collectCss(projectDir, 0);

  for (const cssPath of cssFiles) {
    let css: string;
    try { css = fs.readFileSync(cssPath, 'utf-8'); } catch { continue; }
    const source = path.relative(projectDir, cssPath);
    const found = scanCssForHoverOnly(css, source);
    detections.push(...found);
  }

  if (detections.length > 0) {
    log.info(`mobile/hover-only: found ${detections.length} detection(s) in ${cssFiles.length} CSS files`);
  }

  return detections;
}
