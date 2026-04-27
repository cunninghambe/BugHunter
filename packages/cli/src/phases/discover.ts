// Phase 1: discover — three-source discovery (§ 3.3).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { BugHunterConfig, DiscoveryOutput, DiscoveredPage, ToolMeta, SkippedItem } from '../types.js';
import { discoverFilesystemPages, isDynamicRoute, expandDynamicRoute } from '../discovery/filesystem-pages.js';
import { walkDom } from '../discovery/dom-walker.js';
import { crossRefForms } from '../discovery/form-cross-ref.js';
import { collapseElements } from '../discovery/element-collapse.js';
import { log } from '../log.js';
import micromatch from 'micromatch';
import path from 'node:path';

export async function runDiscover(
  projectDir: string,
  config: BugHunterConfig,
  roles: string[],
  runId: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter,
  routePattern?: string
): Promise<DiscoveryOutput> {
  const skipList: SkippedItem[] = [];

  // Source 1: SurfaceMCP catalog
  const catalog = await surface.surface_list_tools();
  const apiTools: ToolMeta[] = catalog.tools;

  // Source 2: AST filesystem page scan
  const fsPages = await discoverFilesystemPages(projectDir);
  log.info(`Discovered ${fsPages.length} filesystem pages`);

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
      const role = roles[0] ?? 'anonymous';
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

  // Filter external tools
  const filteredApiTools = apiTools.filter(
    t => t.sideEffectClass !== 'external' || config.externalIntegrationsAllowed
  );

  const externalSkips = apiTools
    .filter(t => t.sideEffectClass === 'external' && !config.externalIntegrationsAllowed)
    .map(t => ({ toolId: t.toolId, reason: 'external_side_effect' }));

  return {
    pages,
    apiTools: filteredApiTools,
    skipList: [...skipList, ...externalSkips],
  };
}
