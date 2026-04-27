// Unit tests for crawlFromSeeds — SPEC_CRAWLER § 5.1 (14 cases)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crawlFromSeeds, type CrawlOpts } from './crawler.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';

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
it('case 11: walk failure logged and crawl continues', async () => {
  let callCount = 0;
  const browser: BrowserMcpAdapter = {
    navigate: vi.fn(async (url: string) => { return { url }; }),
    evaluate: vi.fn(async () => {
      callCount++;
      if (callCount === 1) return { value: makeDomResult(['/fail-next', '/ok']) };
      if (callCount === 2) throw new Error('fake DOM error');
      return { value: makeDomResult([]) };
    }),
    scroll: vi.fn(async () => ({ scrolled: true })),
    click: vi.fn(), type: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
    listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(), withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;

  const result = await crawlFromSeeds(browser, makeOpts());
  // seed page succeeded
  expect(result.pages.some(p => p.route === '/')).toBe(true);
  // one page should be in skipped
  expect(result.skipped.some(s => s.reason.startsWith('walk_failed:'))).toBe(true);
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
