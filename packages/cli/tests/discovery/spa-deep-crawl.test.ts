// Integration test for SPA deep crawl (§ 6.3)
// Drives a full crawl against a mock surface with state navigations and runtime enum.

import { describe, it, expect, vi } from 'vitest';
import { crawlFromSeeds, type CrawlOpts } from '../../src/discovery/crawler.js';
import type { BrowserMcpAdapter } from '../../src/adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../../src/adapters/surface-mcp.js';

type DomResult = { elements: never[]; forms: never[]; links: string[] };

function makeDomResult(links: string[] = []): DomResult {
  return { elements: [], forms: [], links };
}

/** Builds a mock SurfaceMcpAdapter that mimics a Vite stack with vite-tab-state-app fixture */
function makeSurface(): SurfaceMcpAdapter {
  const stateNavs = [
    { label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard', testId: 'nav-dashboard' }, sourceFile: 'src/App.tsx', sourceLine: 10, confidence: 'high' },
    { label: 'Trades', method: 'state-setter', target: 'trades', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Trades', testId: 'nav-trades' }, sourceFile: 'src/App.tsx', sourceLine: 11, confidence: 'high' },
    { label: 'Settings', method: 'state-setter', target: 'settings', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Settings', testId: 'nav-settings' }, sourceFile: 'src/App.tsx', sourceLine: 12, confidence: 'high' },
    { label: 'Profile', method: 'state-setter', target: 'profile', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Profile', ariaLabel: 'My profile' }, sourceFile: 'src/App.tsx', sourceLine: 13, confidence: 'high' },
  ];

  return {
    surface_describe_self: vi.fn().mockResolvedValue({
      name: 'vite-tab-state-app',
      stack: 'vite',
      baseUrl: 'http://localhost:5173',
      toolRevision: 1,
      pageRevision: 1,
      capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: true },
    }),
    surface_list_navigations: vi.fn().mockResolvedValue({
      revision: 1,
      navigations: stateNavs,
      skips: [],
    }),
    surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({
      version: 1,
      script: 'ENUM_SCRIPT',
      timeoutMs: 5000,
      expectedSchema: {},
    }),
    surface_postprocess_runtime_routes: vi.fn().mockResolvedValue({
      routes: [],
      summary: { detectedRouters: [], errorCount: 0, totalRoutes: 0, dedupedRoutes: 0, fellBackToNone: true },
    }),
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages: [] }),
    surface_describe_auth: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

/** Builds a stateful mock browser that tracks clickByHint calls and returns appropriate DOM per state */
function makeBrowser(): BrowserMcpAdapter {
  let lastClickedTab: string | null = null;

  return {
    navigate: vi.fn().mockResolvedValue({ url: 'http://localhost:5173/' }),
    evaluate: vi.fn().mockImplementation(async (script: string) => {
      // Runtime enum probe — exact script match
      if (script === 'ENUM_SCRIPT') {
        return { value: { routers: [], errors: [], elapsedMs: 0 } };
      }
      // location.pathname check for state items — exact match
      if (script === 'location.pathname') return { value: '/' };
      // DOM collection (all other scripts — the full IIFE)
      return {
        value: {
          elements: lastClickedTab ? [{ tag: 'div', text: `${lastClickedTab} content`, selector: `#${lastClickedTab}`, disabled: false, ancestorStack: '' }] : [],
          forms: [],
          links: [],
        },
      };
    }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    click: vi.fn(),
    clickByHint: vi.fn().mockImplementation(async (hint: { text?: string; testId?: string; ariaLabel?: string }) => {
      // Detect which tab was clicked based on hint fields
      const label = hint.testId ?? hint.ariaLabel ?? hint.text ?? '';
      if (label.includes('dashboard') || label === 'Dashboard') lastClickedTab = 'dashboard';
      else if (label.includes('trades') || label === 'Trades') lastClickedTab = 'trades';
      else if (label.includes('settings') || label === 'Settings') lastClickedTab = 'settings';
      else if (label.includes('profile') || label === 'Profile' || label === 'My profile') lastClickedTab = 'profile';
      return { clicked: true, matchedBy: hint.testId ? 'testId' : hint.ariaLabel ? 'ariaLabel' : 'text' };
    }),
    type: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;
}

function makeOpts(overrides: Partial<CrawlOpts> = {}): CrawlOpts {
  return {
    baseUrl: 'http://localhost:5173',
    seedRoutes: ['/'],
    maxPages: 50,
    maxDepth: 3,
    followQueryParams: false,
    walkTimeoutMs: 5000,
    sameOriginOnly: true,
    runId: 'spa-deep-crawl-test',
    stateSettleMs: 0,
    ...overrides,
  };
}

describe('SPA deep crawl — integration (§ 6.3)', () => {
  it('discovers seed + 4 state pages with correct shapes', async () => {
    const surface = makeSurface();
    const browser = makeBrowser();

    const result = await crawlFromSeeds(browser, makeOpts({ surface }));

    // 5 pages: seed '/' + 4 state tabs
    expect(result.pages.length).toBe(5);

    // 4 pages are state kind
    const statePages = result.pages.filter(p => p.kind === 'state');
    expect(statePages.length).toBe(4);

    // All state pages have stateContext
    for (const page of statePages) {
      expect(page.stateContext).toBeDefined();
      expect(page.stateContext!.stateVar).toBe('tab');
      expect(page.stateContext!.baseRoute).toBe('/');
    }
  });

  it('telemetry: staticNavigations === 4', async () => {
    const surface = makeSurface();
    const browser = makeBrowser();

    const result = await crawlFromSeeds(browser, makeOpts({ surface }));

    expect(result.telemetry.staticNavigations).toBe(4);
    expect(result.telemetry.seedRoutes).toBe(1);
    expect(result.telemetry.stateKindPages).toBe(4);
  });

  it('telemetry: crawlLinkRoutes === 0 (no <a href> in mock DOM)', async () => {
    const surface = makeSurface();
    const browser = makeBrowser();

    const result = await crawlFromSeeds(browser, makeOpts({ surface }));

    expect(result.telemetry.crawlLinkRoutes).toBe(0);
  });

  it('runtime enum fires once and returns 0 routes (TraiderJo case)', async () => {
    const surface = makeSurface();
    const browser = makeBrowser();

    await crawlFromSeeds(browser, makeOpts({ surface }));

    // surface_enumerate_routes_runtime called exactly once
    expect(surface.surface_enumerate_routes_runtime).toHaveBeenCalledTimes(1);
    expect(surface.surface_postprocess_runtime_routes).toHaveBeenCalledTimes(1);
  });

  it('seed page has kind:url and navSource:crawl-seed', async () => {
    const surface = makeSurface();
    const browser = makeBrowser();

    const result = await crawlFromSeeds(browser, makeOpts({ surface }));

    const seedPage = result.pages.find(p => p.route === '/');
    expect(seedPage).toBeDefined();
    expect(seedPage!.kind).toBe('url');
    expect(seedPage!.navSource).toBe('crawl-seed');
  });
});
