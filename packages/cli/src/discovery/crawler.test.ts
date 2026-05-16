// Unit tests for crawlFromSeeds — SPEC_CRAWLER § 5.1 (14 cases) + SPA deep crawl extensions (§ 6.1)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crawlFromSeeds, type CrawlOpts } from './crawler.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

type DomResult = { elements: never[]; forms: never[]; links: string[] };

function makeOpts(overrides: Partial<CrawlOpts> = {}): CrawlOpts {
  return {
    baseUrl: 'http://h:1',
    seedRoutes: ['/'],
    maxPages: 50,
    maxDepth: 3,
    followQueryParams: false,
    walkTimeoutMs: 5_000,
    sameOriginOnly: true,
    runId: 'test',
    ...overrides,
  };
}

function makeDomResult(links: string[] = []): DomResult {
  return { elements: [], forms: [], links };
}

// Build a mock BrowserMcpAdapter that never uses real network.
function makeMockBrowser(
  navigateFn: (url: string) => void,
  evaluateResult: DomResult | ((url: string) => DomResult),
  scrollFn?: () => void
): BrowserMcpAdapter {
  let lastUrl = '';
  return {
    navigate: vi.fn(async (url: string) => { navigateFn(url); lastUrl = url; return { url }; }),
    evaluate: vi.fn(async () => {
      const result = typeof evaluateResult === 'function' ? evaluateResult(lastUrl) : evaluateResult;
      return { value: result };
    }),
    scroll: vi.fn(async () => { scrollFn?.(); return { scrolled: true }; }),
    click: vi.fn(),
    type: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: vi.fn(),
    clickByHint: vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' }),
  } as unknown as BrowserMcpAdapter;
}

// Case 1: Single seed, no links — visits one page only.
it('case 1: single seed, no links — one page', async () => {
  const browser = makeMockBrowser(() => {}, makeDomResult([]));
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.pages.length).toBe(1);
  expect(result.pages[0]!.route).toBe('/');
  expect(result.visited).toEqual(['/']);
  expect(result.hitMaxPages).toBe(false);
  expect(result.hitMaxDepth).toBe(false);
});

// Case 2: Seed with two same-origin links — visits three pages BFS.
it('case 2: seed with two links — three pages BFS', async () => {
  const visited: string[] = [];
  const browser = makeMockBrowser(
    (url) => { visited.push(url); },
    (url) => {
      if (url.endsWith('/')) return makeDomResult(['http://h:1/about', 'http://h:1/contact']);
      return makeDomResult([]);
    }
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.pages.length).toBe(3);
  expect(result.visited).toEqual(['/', '/about', '/contact']);
});

// Case 3: maxPages cap stops the crawl mid-queue.
it('case 3: maxPages cap', async () => {
  const browser = makeMockBrowser(
    () => {},
    (url) => {
      if (url.endsWith('/')) return makeDomResult(['/a', '/b', '/c', '/d', '/e']);
      return makeDomResult([]);
    }
  );
  const result = await crawlFromSeeds(browser, makeOpts({ maxPages: 2 }));
  expect(result.pages.length).toBe(2);
  expect(result.hitMaxPages).toBe(true);
});

// Case 4: maxDepth cap rejects child enqueue.
it('case 4: maxDepth cap', async () => {
  const browser = makeMockBrowser(
    () => {},
    (url) => {
      if (url.endsWith('/')) return makeDomResult(['http://h:1/a']);
      if (url.endsWith('/a')) return makeDomResult(['http://h:1/b']);
      return makeDomResult([]);
    }
  );
  const result = await crawlFromSeeds(browser, makeOpts({ maxDepth: 1 }));
  expect(result.pages.length).toBe(2); // / and /a
  expect(result.visited).not.toContain('/b');
  expect(result.hitMaxDepth).toBe(true);
});

// Case 5: Off-origin links are skipped.
it('case 5: off-origin links skipped', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['/local', 'https://google.com/x'])
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.visited).toContain('/');
  expect(result.visited).toContain('/local');
  expect(result.visited).not.toContain('https://google.com/x');
  expect(result.skipped.some(s => s.reason === 'off_origin_or_unsupported')).toBe(true);
});

// Case 6: Hash-only links silently skipped; hash-with-path followed with hash stripped.
it('case 6: hash handling', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['#section', '/dashboard#tab=trades'])
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.visited).toContain('/dashboard');
  expect(result.visited).not.toContain('/dashboard#tab=trades');
  // hash-only silently dropped — no skip entry
  expect(result.skipped.some(s => s.url === '#section')).toBe(false);
});

// Case 7: Trailing slash normalization.
it('case 7: trailing slash normalization', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['/about', '/about/'])
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.pages.length).toBe(2);
  expect(result.visited).toContain('/about');
});

// Case 8: Query-string stripped by default.
it('case 8: query strings stripped (followQueryParams: false)', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['/users?id=1', '/users?id=2'])
  );
  const result = await crawlFromSeeds(browser, makeOpts({ followQueryParams: false }));
  // /users?id=1 and /users?id=2 both normalize to /users — one visit
  const usersVisits = result.visited.filter(k => k === '/users');
  expect(usersVisits.length).toBe(1);
  expect(result.pages.length).toBe(2); // / + /users
});

// Case 9: Query-string follow mode — kept.
it('case 9: followQueryParams: true keeps query', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['/users?id=1', '/users?id=2'])
  );
  const result = await crawlFromSeeds(browser, makeOpts({ followQueryParams: true }));
  expect(result.pages.length).toBe(3); // / + /users?id=1 + /users?id=2
});

// Case 10: Visited dedup against re-encountered URL.
it('case 10: dedup re-encountered URLs', async () => {
  const browser = makeMockBrowser(
    () => {},
    (url) => {
      if (url.endsWith('/')) return makeDomResult(['/about', '/']);
      return makeDomResult(['/']);
    }
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.visited.filter(k => k === '/').length).toBe(1);
  expect(result.visited.filter(k => k === '/about').length).toBe(1);
});

// Case 11: Walk failure — page logged, skipped, crawl continues.
// v0.53: mock now keys on URL rather than counting evaluate() ticks. The
// original tick-based mock broke when the crawler's per-page evaluate count
// grew (state-nav probes + runtime-route enum + DOM walk all consume ticks
// now). URL-keying is robust to future tick growth.
it('case 11: walk failure logged and crawl continues', async () => {
  let lastUrl = '';
  const browser: BrowserMcpAdapter = {
    navigate: vi.fn(async (url: string) => { lastUrl = url; return { url }; }),
    evaluate: vi.fn(async () => {
      if (lastUrl.endsWith('/fail-next')) throw new Error('fake DOM error');
      if (lastUrl.endsWith('/') || lastUrl === '') return { value: makeDomResult(['/fail-next', '/ok']) };
      return { value: makeDomResult([]) };
    }),
    scroll: vi.fn(async () => ({ scrolled: true })),
    click: vi.fn(), type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
    listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;

  const result = await crawlFromSeeds(browser, makeOpts());
  // seed page succeeded
  expect(result.pages.some(p => p.route === '/')).toBe(true);
  // /fail-next must be reported as skipped (walk_failed) or as a page with
  // empty content — either is acceptable; the load-bearing assertion is that
  // crawl didn't crash and the seed survived.
  const failNextSkipped = result.skipped.some(s => s.url.endsWith('/fail-next') || s.reason.includes('fake DOM error'));
  const failNextPage = result.pages.some(p => p.route === '/fail-next');
  expect(failNextSkipped || failNextPage).toBe(true);
});

// Case 12: Per-page walk timeout fires.
it('case 12: walk timeout sends page to skipped', async () => {
  const browser: BrowserMcpAdapter = {
    navigate: vi.fn(async (url: string) => ({ url })),
    evaluate: vi.fn(() => new Promise(() => { /* never resolves */ })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    click: vi.fn(), type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
    listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;

  const result = await crawlFromSeeds(browser, makeOpts({ walkTimeoutMs: 50 }));
  expect(result.pages.length).toBe(0);
  expect(result.skipped.some(s => s.reason.includes('timeout') || s.reason.includes('walk_failed'))).toBe(true);
}, 5_000);

// Case 13: javascript: / mailto: / tel: schemes are silently skipped.
it('case 13: unsupported schemes silently skipped', async () => {
  const browser = makeMockBrowser(
    () => {},
    makeDomResult(['javascript:void(0)', 'mailto:x@y.z', 'tel:+15555', '/real'])
  );
  const result = await crawlFromSeeds(browser, makeOpts());
  expect(result.visited).toContain('/');
  expect(result.visited).toContain('/real');
  expect(result.visited.length).toBe(2);
});

// Case 14: Empty seedRoutes returns empty result.
it('case 14: empty seedRoutes returns empty result', async () => {
  const browser = makeMockBrowser(() => {}, makeDomResult([]));
  const result = await crawlFromSeeds(browser, makeOpts({ seedRoutes: [] }));
  expect(result.pages).toEqual([]);
  expect(result.visited).toEqual([]);
  expect(result.hitMaxPages).toBe(false);
  expect(result.hitMaxDepth).toBe(false);
});

// ── SPA Deep Crawl extension cases (§ 6.1) ───────────────────────────────────

function makeSurface(overrides: Partial<SurfaceMcpAdapter> = {}): SurfaceMcpAdapter {
  return {
    surface_describe_self: vi.fn().mockResolvedValue({
      name: 'test',
      stack: 'vite',
      baseUrl: 'http://h:1',
      toolRevision: 1,
      pageRevision: 1,
      capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: false },
    }),
    surface_list_navigations: vi.fn().mockResolvedValue({ revision: 1, navigations: [], skips: [] }),
    surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({ version: 1, script: '(function(){ return { routers: [], errors: [], elapsedMs: 0 }; })()', timeoutMs: 5000, expectedSchema: {} }),
    surface_postprocess_runtime_routes: vi.fn().mockResolvedValue({ routes: [], summary: { detectedRouters: [], errorCount: 0, totalRoutes: 0, dedupedRoutes: 0, fellBackToNone: false } }),
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
    ...overrides,
  } as unknown as SurfaceMcpAdapter;
}

describe('SPA deep crawl — static navigation sources (C1–C2)', () => {
  // C1: static-navigation/url — surface returns one nav with kind:'url'.
  it('C1: static-navigation url nav — crawler visits base and target', async () => {
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'About', method: 'link', target: '/about', kind: 'url',
          triggerSelectorHint: {}, sourceFile: 'src/App.tsx', sourceLine: 5, confidence: 'high',
        }],
        skips: [],
      }),
    });
    const browser = makeMockBrowser(() => {}, makeDomResult([]));
    const result = await crawlFromSeeds(browser, makeOpts({ surface }));
    expect(result.visited).toContain('/');
    expect(result.visited).toContain('/about');
    expect(result.pages.length).toBe(2);
  });

  // C2: static-navigation/state — browser.clickByHint is called for state nav.
  it('C2: static-navigation state nav — clickByHint called, page shape correct', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
          sourceFile: 'src/App.tsx', sourceLine: 10, confidence: 'high',
        }],
        skips: [],
      }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));

    // clickByHint should have been called with the hint directly
    expect(clickByHintMock).toHaveBeenCalledWith({ text: 'Dashboard' });
    // browser.click should NOT have been called for state nav
    expect(browser.click).not.toHaveBeenCalled();
    // 2 pages: seed / and state page
    expect(result.pages.length).toBe(2);
    const statePage = result.pages.find(p => p.kind === 'state');
    expect(statePage).toBeDefined();
    expect(statePage!.stateContext?.stateVar).toBe('tab');
    expect(statePage!.stateContext?.stateValue).toBe('dashboard');
  });
});

describe('SPA deep crawl — dedup and cap (C3–C4)', () => {
  // C3: same state nav from two sources → visited once.
  it('C3: state-navigation dedup — clicked once when queued twice', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const stateNav = {
      label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
      stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
      sourceFile: 'src/App.tsx', sourceLine: 10, confidence: 'high',
    };
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      // Return the same nav twice
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [stateNav, stateNav],
        skips: [],
      }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    // clickByHint called once (deduped)
    expect(clickByHintMock).toHaveBeenCalledTimes(1);
    expect(result.pages.filter(p => p.kind === 'state').length).toBe(1);
  });

  // C4: maxStateNavigations cap — only first 2 of 5 state navs visited.
  it('C4: maxStateNavigations cap — drops excess state items', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn()
      .mockResolvedValue({ value: makeDomResult([]) });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const makeStateNav = (value: string) => ({
      label: value, method: 'state-setter', target: value, kind: 'state',
      stateVar: 'tab', triggerSelectorHint: { text: value },
      sourceFile: 'src/App.tsx', sourceLine: 1, confidence: 'high',
    });

    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: ['a', 'b', 'c', 'd', 'e'].map(makeStateNav),
        skips: [],
      }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0, maxStateNavigations: 2 }));
    expect(result.pages.filter(p => p.kind === 'state').length).toBeLessThanOrEqual(2);
    // At least some state items in skipped with state_cap_hit
    expect(result.skipped.some(s => s.reason === 'state_cap_hit')).toBe(true);
  });
});

describe('SPA deep crawl — trigger resolution (C5–C9b)', () => {
  type ClickByHintResult = { clicked: true; matchedBy: 'testId' | 'ariaLabel' | 'text' } | { clicked: false; reason: 'no_hint_fields' | 'not_found' };

  function makeTriggerBrowser(clickByHintResult: ClickByHintResult): BrowserMcpAdapter {
    return {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script === 'location.pathname') return { value: '/' };
        return { value: makeDomResult([]) };
      }),
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: vi.fn().mockResolvedValue(clickByHintResult),
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;
  }

  function makeTriggerSurface(hint: Record<string, string>): SurfaceMcpAdapter {
    return makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'X', method: 'state-setter', target: 'x', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: hint,
          sourceFile: 'src/App.tsx', sourceLine: 1, confidence: 'high',
        }],
        skips: [],
      }),
    });
  }

  // C5: testId priority — clickByHint called with hint, returns matchedBy:'testId', state page produced.
  it('C5: trigger-resolve testid-priority — clickByHint called with full hint, state page produced', async () => {
    const browser = makeTriggerBrowser({ clicked: true, matchedBy: 'testId' });
    const surface = makeTriggerSurface({ testId: 'nav-x', text: 'X label' });
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(browser.clickByHint).toHaveBeenCalledWith({ testId: 'nav-x', text: 'X label' });
    expect((browser.clickByHint as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.pages.find(p => p.kind === 'state')).toBeDefined();
  });

  // C6: aria-label fallback — clickByHint called with hint, returns matchedBy:'ariaLabel'.
  it('C6: trigger-resolve aria-label fallback — clickByHint called with ariaLabel hint', async () => {
    const browser = makeTriggerBrowser({ clicked: true, matchedBy: 'ariaLabel' });
    const surface = makeTriggerSurface({ ariaLabel: 'X label', text: 'X' });
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(browser.clickByHint).toHaveBeenCalledWith({ ariaLabel: 'X label', text: 'X' });
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.pages.find(p => p.kind === 'state')).toBeDefined();
  });

  // C7: text-only hint — clickByHint called, browser.click NOT called for state nav.
  it('C7: trigger-resolve text-fallback — clickByHint used, browser.click NOT called', async () => {
    const browser = makeTriggerBrowser({ clicked: true, matchedBy: 'text' });
    const surface = makeTriggerSurface({ text: 'X label' });
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(browser.clickByHint).toHaveBeenCalledWith({ text: 'X label' });
    // Regression guard: browser.click must NOT be called for text-only state nav
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.pages.find(p => p.kind === 'state')).toBeDefined();
  });

  // C8: empty hint — clickByHint returns no_hint_fields — page skipped with trigger_not_found.
  it('C8: trigger-resolve none — trigger_not_found skip', async () => {
    const browser = makeTriggerBrowser({ clicked: false, reason: 'no_hint_fields' });
    const surface = makeTriggerSurface({});
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(result.skipped.some(s => s.reason === 'trigger_not_found')).toBe(true);
    expect(result.pages.find(p => p.kind === 'state')).toBeUndefined();
  });

  // C9: all priorities miss → matchedBy:'text' (falls through from testId to text).
  it('C9: trigger-resolve missing element — testId absent in DOM, falls to text, state page produced', async () => {
    const browser = makeTriggerBrowser({ clicked: true, matchedBy: 'text' });
    const surface = makeTriggerSurface({ testId: 'nonexistent', text: 'X label' });
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(browser.clickByHint).toHaveBeenCalledWith({ testId: 'nonexistent', text: 'X label' });
    expect(browser.click).not.toHaveBeenCalled();
    expect(result.pages.find(p => p.kind === 'state')).toBeDefined();
  });

  // C9b: all priorities miss — not_found → trigger_not_found skip, no state page.
  it('C9b: trigger-resolve not_found — all priorities miss, trigger_not_found skip', async () => {
    const browser = makeTriggerBrowser({ clicked: false, reason: 'not_found' });
    const surface = makeTriggerSurface({ text: 'Z' });
    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(browser.clickByHint).toHaveBeenCalledWith({ text: 'Z' });
    expect(result.skipped.some(s => s.reason === 'trigger_not_found')).toBe(true);
    expect(result.pages.find(p => p.kind === 'state')).toBeUndefined();
  });
});

describe('SPA deep crawl — runtime enum (C10–C14)', () => {
  // C10: runtime-enum integration — script evaluated, new route queued.
  it('C10: runtime-enum/integration — routes discovered and visited', async () => {
    const postprocessed = { routes: [{ path: '/x', params: [], source: 'tanstack-router' }], summary: { detectedRouters: ['tanstack-router'], errorCount: 0, totalRoutes: 1, dedupedRoutes: 1, fellBackToNone: false } };
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: true },
      }),
      surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({
        version: 1, script: '(function(){ return { routers: [{name:"tanstack-router", routes:[{path:"/x",params:[]}]}], errors:[], elapsedMs:1 }; })()', timeoutMs: 5000, expectedSchema: {},
      }),
      surface_postprocess_runtime_routes: vi.fn().mockResolvedValue(postprocessed),
    });
    const browser = makeMockBrowser(() => {}, makeDomResult([]));
    const result = await crawlFromSeeds(browser, makeOpts({ surface }));
    expect(result.visited).toContain('/x');
    expect(result.telemetry.runtimeEnumRoutes).toBeGreaterThanOrEqual(1);
  });

  // C11: disableRuntimeEnum: true — enumerate not called.
  it('C11: runtime-enum/disabled — surface_enumerate_routes_runtime not called', async () => {
    const enumerateMock = vi.fn();
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: true },
      }),
      surface_enumerate_routes_runtime: enumerateMock,
    });
    const browser = makeMockBrowser(() => {}, makeDomResult([]));
    await crawlFromSeeds(browser, makeOpts({ surface, disableRuntimeEnum: true }));
    expect(enumerateMock).not.toHaveBeenCalled();
  });

  // C12: capability absent — enumerate not called.
  it('C12: runtime-enum/capability-absent — skips enumerate', async () => {
    const enumerateMock = vi.fn();
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: false },
      }),
      surface_enumerate_routes_runtime: enumerateMock,
    });
    const browser = makeMockBrowser(() => {}, makeDomResult([]));
    await crawlFromSeeds(browser, makeOpts({ surface }));
    expect(enumerateMock).not.toHaveBeenCalled();
  });

  // C13: script fails — crawl continues without extra routes.
  it('C13: runtime-enum/script-fails — warn logged, crawl continues', async () => {
    let evalCallCount = 0;
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: true },
      }),
      surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({
        version: 1, script: 'ENUM_SCRIPT', timeoutMs: 5000, expectedSchema: {},
      }),
      surface_postprocess_runtime_routes: vi.fn(), // should not be called
    });
    // Evaluate: first call is DOM collection (returns dom result), second is runtime enum script (rejects)
    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        evalCallCount++;
        if (script === 'ENUM_SCRIPT') throw new Error('script_crashed');
        return { value: makeDomResult([]) };
      }),
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(), type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;
    const result = await crawlFromSeeds(browser, makeOpts({ surface }));
    // Crawl completed with seed page only
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.telemetry.runtimeEnumRoutes).toBe(0);
  });

  // C14: runtime-enum fires once even with multiple depth-0 visits.
  it('C14: runtime-enum/runs-once — multiple seeds, enum called once', async () => {
    const enumerateMock = vi.fn().mockResolvedValue({
      version: 1, script: '(function(){ return { routers: [], errors: [], elapsedMs: 0 }; })()', timeoutMs: 5000, expectedSchema: {},
    });
    const postprocessMock = vi.fn().mockResolvedValue({
      routes: [], summary: { detectedRouters: [], errorCount: 0, totalRoutes: 0, dedupedRoutes: 0, fellBackToNone: false },
    });
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: true },
      }),
      surface_enumerate_routes_runtime: enumerateMock,
      surface_postprocess_runtime_routes: postprocessMock,
    });
    const browser = makeMockBrowser(() => {}, makeDomResult([]));
    await crawlFromSeeds(browser, makeOpts({ surface, seedRoutes: ['/', '/about'] }));
    expect(enumerateMock).toHaveBeenCalledTimes(1);
  });
});

describe('SPA deep crawl — collectDomOnly / page shape (C15–C16)', () => {
  // C15: collectDomOnly — navigate is NOT called for state items.
  it('C15: walk-collectDomOnly/no-navigate — no navigate on state items after first', async () => {
    const navigateMock = vi.fn().mockResolvedValue({ url: 'http://h:1/' });
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: navigateMock,
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
          sourceFile: 'src/App.tsx', sourceLine: 1, confidence: 'high',
        }],
        skips: [],
      }),
    });

    await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));

    // navigate called once for seed '/', not again for the state item (which is already at '/')
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  // C16: state page shape — kind:'state' and stateContext populated.
  it('C16: state-page-shape — pages have kind:state and stateContext', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
          stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
          sourceFile: 'src/App.tsx', sourceLine: 1, confidence: 'high',
        }],
        skips: [],
      }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    const statePage = result.pages.find(p => p.kind === 'state');
    expect(statePage).toBeDefined();
    expect(statePage!.kind).toBe('state');
    expect(statePage!.stateContext).toBeDefined();
    expect(statePage!.stateContext!.stateVar).toBe('tab');
    expect(statePage!.stateContext!.stateValue).toBe('dashboard');
    expect(statePage!.stateContext!.baseRoute).toBe('/');
  });
});

describe('SPA deep crawl — mixed sources and dedup (C17–C20)', () => {
  // C17: mixed sources — all 5 sources contribute pages.
  it('C17: mixed-sources — telemetry counts all source types', async () => {
    const postprocessed = { routes: [{ path: '/runtime-page', params: [], source: 'tanstack-router' }], summary: { detectedRouters: ['tanstack-router'], errorCount: 0, totalRoutes: 1, dedupedRoutes: 1, fellBackToNone: false } };
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: true },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [
          { label: 'About', method: 'link', target: '/about', kind: 'url', triggerSelectorHint: {}, sourceFile: 'a.tsx', sourceLine: 1, confidence: 'high' },
          { label: 'Tab', method: 'state-setter', target: 'tab1', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Tab' }, sourceFile: 'a.tsx', sourceLine: 2, confidence: 'high' },
        ],
        skips: [],
      }),
      surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({ version: 1, script: '(function(){ return { routers: [], errors: [], elapsedMs: 0 }; })()', timeoutMs: 5000, expectedSchema: {} }),
      surface_postprocess_runtime_routes: vi.fn().mockResolvedValue(postprocessed),
    });

    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult(['/link-from-dom']) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(result.telemetry.seedRoutes).toBe(1);
    expect(result.telemetry.staticNavigations).toBeGreaterThanOrEqual(1);
    expect(result.telemetry.runtimeEnumRoutes).toBeGreaterThanOrEqual(1);
    expect(result.telemetry.visitedPages).toBeGreaterThan(0);
  });

  // C18: same state (baseRoute+stateVar+stateValue) from two sources → visited once.
  it('C18: dedup/state-equals-existing-state — same state queued twice, clicked once', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const nav = { label: 'A', method: 'state-setter', target: 'a', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'A' }, sourceFile: 'x.tsx', sourceLine: 1, confidence: 'high' };
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({ revision: 1, navigations: [nav, nav], skips: [] }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    expect(clickByHintMock).toHaveBeenCalledTimes(1);
    expect(result.pages.filter(p => p.kind === 'state').length).toBe(1);
  });

  // C19: state nav and url nav with same path-like string → different keys, both visited.
  it('C19: dedup/state-vs-url — state and url navs with same target string have different keys', async () => {
    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const evaluateMock = vi.fn().mockImplementation(async (script: string) => {
      if (script === 'location.pathname') return { value: '/' };
      return { value: makeDomResult([]) };
    });

    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: evaluateMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      click: vi.fn(),
      clickByHint: clickByHintMock,
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [
          { label: 'Dashboard URL', method: 'link', target: '/dashboard', kind: 'url', triggerSelectorHint: {}, sourceFile: 'x.tsx', sourceLine: 1, confidence: 'high' },
          { label: 'Dashboard State', method: 'state-setter', target: 'dashboard', kind: 'state', stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' }, sourceFile: 'x.tsx', sourceLine: 2, confidence: 'high' },
        ],
        skips: [],
      }),
    });

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));
    // Both should be in visited (different keys)
    expect(result.visited.some(k => k === '/dashboard')).toBe(true);
    expect(result.visited.some(k => k.includes('#state=tab=dashboard'))).toBe(true);
  });

  // C20: low-confidence nav excluded by default, included when opt-in.
  it('C20: low-confidence/excluded — excluded by default, included when includeLowConfidence:true', async () => {
    const makeSurfaceWithLowConfNav = (listNavs: boolean) => makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'test', stack: 'vite', baseUrl: 'http://h:1', toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [{
          label: 'Guessed', method: 'link', target: '/guessed', kind: 'url',
          triggerSelectorHint: {}, sourceFile: 'x.tsx', sourceLine: 1, confidence: 'low',
        }],
        skips: [],
      }),
    });

    // Default: excluded
    const browser1 = makeMockBrowser(() => {}, makeDomResult([]));
    const result1 = await crawlFromSeeds(browser1, makeOpts({ surface: makeSurfaceWithLowConfNav(false) }));
    expect(result1.visited).not.toContain('/guessed');

    // Opt-in: included
    const browser2 = makeMockBrowser(() => {}, makeDomResult([]));
    const result2 = await crawlFromSeeds(browser2, makeOpts({ surface: makeSurfaceWithLowConfNav(true), includeLowConfidence: true }));
    expect(result2.visited).toContain('/guessed');
  });
});

describe('SPA deep crawl — tab-state-only integration', () => {
  // Integration: surface_list_navigations returns N kind:'state' navs.
  // After SPEC_CRAWLER_STATE_CLICK this uses clickByHint (not browser.click).
  // Asserts: N+1 DiscoveredPages, each state page carries stateContext,
  // clickByHint called N times, browser.click called 0 times for state navs.
  it('seed + 3 state navs → 4 DiscoveredPages, clickByHint called 3×, click called 0×', async () => {
    const surface = makeSurface({
      surface_describe_self: vi.fn().mockResolvedValue({
        name: 'tab-state-app', stack: 'vite', baseUrl: 'http://h:1',
        toolRevision: 1, pageRevision: 1,
        capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false, crawlSeed: true },
      }),
      surface_list_navigations: vi.fn().mockResolvedValue({
        revision: 1,
        navigations: [
          { label: 'Dashboard', method: 'state-setter', target: 'dashboard', kind: 'state',
            stateVar: 'tab', triggerSelectorHint: { text: 'Dashboard' },
            sourceFile: 'src/App.tsx', sourceLine: 10, confidence: 'high' },
          { label: 'Trades', method: 'state-setter', target: 'trades', kind: 'state',
            stateVar: 'tab', triggerSelectorHint: { text: 'Trades' },
            sourceFile: 'src/App.tsx', sourceLine: 11, confidence: 'high' },
          { label: 'Settings', method: 'state-setter', target: 'settings', kind: 'state',
            stateVar: 'tab', triggerSelectorHint: { testId: 'nav-settings' },
            sourceFile: 'src/App.tsx', sourceLine: 12, confidence: 'high' },
        ],
        skips: [],
      }),
    });

    const clickByHintMock = vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' });
    const clickMock = vi.fn();
    const browser: BrowserMcpAdapter = {
      navigate: vi.fn().mockResolvedValue({ url: 'http://h:1/' }),
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script === 'location.pathname') return { value: '/' };
        return { value: makeDomResult([]) };
      }),
      click: clickMock,
      clickByHint: clickByHintMock,
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const result = await crawlFromSeeds(browser, makeOpts({ surface, stateSettleMs: 0 }));

    expect(result.pages).toHaveLength(4);
    expect(result.pages.filter(p => p.kind === 'state')).toHaveLength(3);
    expect(result.pages.find(p => p.kind === undefined || p.kind === 'url')?.route).toBe('/');

    const dashboard = result.pages.find(p => p.stateContext?.stateValue === 'dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard!.stateContext!.stateVar).toBe('tab');
    expect(dashboard!.stateContext!.triggerHint.text).toBe('Dashboard');

    // clickByHint called once per state nav; browser.click never called for state navs
    expect(clickByHintMock).toHaveBeenCalledTimes(3);
    expect(clickMock).not.toHaveBeenCalled();

    expect(result.telemetry.staticNavigations).toBe(3);
    expect(result.telemetry.stateKindPages).toBe(3);
  });
});
