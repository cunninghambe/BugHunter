// Integration tests for discover phase with crawl wiring — SPEC_CRAWLER § 5.5 (cases 17–19)

import { describe, it, expect, vi } from 'vitest';
import { runDiscover } from '../src/phases/discover.js';
import type { SurfaceMcpAdapter, SurfacePageMeta, SurfaceDescribeSelfResult } from '../src/adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../src/adapters/browser-mcp.js';
import type { BugHunterConfig } from '../src/types.js';

type DomResult = { elements: never[]; forms: never[]; links: string[] };

function makeDomResult(links: string[] = []): DomResult {
  return { elements: [], forms: [], links };
}

function makeConfig(overrides: Partial<BugHunterConfig> = {}): BugHunterConfig {
  return {
    projectName: 'test',
    surfaceMcpUrl: 'http://127.0.0.1:3199/mcp',
    appBaseUrl: 'http://127.0.0.1:5200',
    roles: ['anonymous'],
    ...overrides,
  };
}

function makeDescribeSelf(partial: Partial<SurfaceDescribeSelfResult> = {}): SurfaceDescribeSelfResult {
  return {
    name: 'test',
    stack: 'vite',
    baseUrl: 'http://127.0.0.1:5200',
    toolRevision: 1,
    pageRevision: 1,
    capabilities: { listPages: true, crawlSeed: true },
    ...partial,
  };
}

function makeSeedPage(): SurfacePageMeta {
  return {
    route: '/',
    sourceFile: '<unresolved>',
    lazy: false,
    dynamicParams: [],
    declaredAt: { file: '<crawl-seed>', line: 0 },
    source: 'crawl_seed',
  };
}

function makeStaticPage(route: string): SurfacePageMeta {
  return {
    route,
    sourceFile: `src/pages${route === '/' ? '/index' : route}.tsx`,
    lazy: false,
    dynamicParams: [],
    declaredAt: { file: 'src/App.tsx', line: 1 },
    source: 'static',
  };
}

function makeSurface(pages: SurfacePageMeta[], describeSelf: SurfaceDescribeSelfResult): SurfaceMcpAdapter {
  return {
    surface_describe_self: vi.fn().mockResolvedValue(describeSelf),
    surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages, skips: [] }),
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

function makeBrowser(evalFn: (url: string) => DomResult): BrowserMcpAdapter {
  let lastUrl = '';
  return {
    navigate: vi.fn(async (url: string) => { lastUrl = url; return { url }; }),
    evaluate: vi.fn(async () => ({ value: evalFn(lastUrl) })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    click: vi.fn(), type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
    listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;
}

// Case 17: Seed flow end-to-end with a mock browser — 3 pages discovered.
describe('discover-crawl integration — case 17', () => {
  it('seed flow end-to-end: / → /a + /b → 3 pages', async () => {
    const surface = makeSurface([makeSeedPage()], makeDescribeSelf());
    const browser = makeBrowser((url) => {
      if (url.endsWith('/')) return makeDomResult(['/a', '/b']);
      return makeDomResult([]);
    });

    const output = await runDiscover('/tmp/fake', makeConfig(), ['anonymous'], 'test-run', surface, browser);
    expect(output.pages.length).toBe(3);
    const routes = output.pages.map(p => p.route).sort();
    expect(routes).toEqual(['/', '/a', '/b']);
    for (const p of output.pages) {
      expect(p.elements).toBeDefined();
      expect(p.forms).toBeDefined();
      expect(p.links).toBeDefined();
    }
  }, 10_000);
});

// Case 18: crawl.enabled: false — crawl skipped, zero pages.
describe('discover-crawl integration — case 18', () => {
  it('crawl disabled via config: zero pages', async () => {
    const surface = makeSurface([makeSeedPage()], makeDescribeSelf());
    const browser = makeBrowser(() => makeDomResult(['/a', '/b']));

    const output = await runDiscover(
      '/tmp/fake',
      makeConfig({ crawl: { enabled: false } }),
      ['anonymous'],
      'test-run',
      surface,
      browser
    );
    expect(output.pages.length).toBe(0);
  });
});

// Case 19: Mixed seed + static — both flow through; dedup applies.
describe('discover-crawl integration — case 19', () => {
  it('mixed static + seed: static walked normally, crawl adds unique routes', async () => {
    const surface = makeSurface(
      [makeStaticPage('/dashboard'), makeSeedPage()],
      makeDescribeSelf()
    );
    const browser = makeBrowser((url) => {
      // Crawl from / discovers /dashboard (deduped) and /about (new)
      if (url.endsWith('/')) return makeDomResult(['/dashboard', '/about']);
      return makeDomResult([]);
    });

    const config = makeConfig({ appBaseUrl: 'http://127.0.0.1:5200' });
    const output = await runDiscover('/tmp/fake', config, ['anonymous'], 'test-run', surface, browser);

    const routes = output.pages.map(p => p.route).sort();
    // /dashboard from static walk + / from crawl + /about from crawl (no dedup of /dashboard)
    expect(routes).toContain('/dashboard');
    expect(routes).toContain('/');
    expect(routes).toContain('/about');
    // /dashboard should appear only once
    expect(routes.filter(r => r === '/dashboard').length).toBe(1);
  }, 10_000);
});
