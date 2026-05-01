// V25: Unit tests for detectHallucinatedRoutes — covers the 10 edge cases from the spec.

import { describe, it, expect } from 'vitest';
import { detectHallucinatedRoutes } from './hallucinated-route.js';
import type { DiscoveredPage, TestResult } from '../types.js';

function makeRenderResult(pageRoute: string, overrides: Partial<TestResult> = {}): TestResult {
  return {
    testId: `test-${pageRoute.replace(/\//g, '-')}`,
    occurrenceId: `occ-${pageRoute.replace(/\//g, '-')}`,
    passed: false,
    bugs: [],
    durationMs: 10,
    preState: { url: pageRoute, title: 'Page', consoleErrorCount: 0 },
    postState: {
      url: pageRoute,
      title: 'Page',
      consoleErrors: [],
      networkRequests: [{ method: 'GET', path: pageRoute, status: 404, duration: 50 }],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 100,
    },
    ...overrides,
  };
}

function makeFilesystemPage(route: string, overrides: Partial<DiscoveredPage> = {}): DiscoveredPage {
  return {
    route,
    sourceFile: `src/app${route}/page.tsx`,
    elements: [],
    forms: [],
    links: [],
    ...overrides,
  };
}

describe('detectHallucinatedRoutes', () => {
  it('fires when a filesystem-routed page returns 404 on its own navigation', () => {
    const result = makeRenderResult('/ghost');
    const page = makeFilesystemPage('/ghost');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    const entry = out.perTestId.get(result.testId);
    expect(entry).toBeDefined();
    expect(entry!.add).toHaveLength(1);
    expect(entry!.add[0]!.kind).toBe('hallucinated_route');
    expect(entry!.add[0]!.targetPath).toBe('/ghost');
  });

  it('sets rootCause and pageRoute correctly', () => {
    const result = makeRenderResult('/ghost');
    const page = makeFilesystemPage('/ghost');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    const detection = out.perTestId.get(result.testId)!.add[0]!;
    expect(detection.rootCause).toContain('/ghost');
    expect(detection.rootCause).toContain('404');
    expect(detection.pageRoute).toBe('/ghost');
  });

  // Negative case: page returns 200
  it('does NOT fire when the page navigation returns 200', () => {
    const result = makeRenderResult('/realpage', {
      postState: {
        url: '/realpage',
        title: 'Real Page',
        consoleErrors: [],
        networkRequests: [{ method: 'GET', path: '/realpage', status: 200, duration: 50 }],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 100,
      },
    });
    const page = makeFilesystemPage('/realpage');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-1: SPA catch-all (app returns HTTP 200 for all routes)
  it('EC-HR-1: does not fire when server returns 200 for unknown routes (SPA catch-all)', () => {
    const result = makeRenderResult('/nonexistent', {
      postState: {
        url: '/nonexistent',
        title: '404 Page',
        consoleErrors: [],
        networkRequests: [{ method: 'GET', path: '/nonexistent', status: 200, duration: 20 }],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 0,
      },
    });
    const page = makeFilesystemPage('/nonexistent');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-2: dynamic route in fixtureUnresolvableRoutes → skip
  it('EC-HR-2: does not fire when route is in fixtureUnresolvableRoutes', () => {
    const result = makeRenderResult('/products/[id]');
    const page = makeFilesystemPage('/products/[id]');
    const out = detectHallucinatedRoutes({
      renderResults: [result],
      pages: [page],
      fixtureUnresolvableRoutes: new Set(['/products/[id]']),
    });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-3: state-kind page → skip
  it('EC-HR-3: does not fire for state-kind pages', () => {
    const result = makeRenderResult('/?tab=trades');
    const page: DiscoveredPage = {
      route: '/?tab=trades',
      sourceFile: 'src/app/page.tsx',
      elements: [],
      forms: [],
      links: [],
      kind: 'state',
      stateContext: { baseRoute: '/', stateVar: 'tab', stateValue: 'trades', triggerHint: {} },
    };
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-4: crawl-link route → skip (navSource = 'crawl-link')
  it('EC-HR-4: does not fire for crawl-link-only routes', () => {
    const result = makeRenderResult('/discovered-by-crawl');
    const page: DiscoveredPage = {
      route: '/discovered-by-crawl',
      sourceFile: undefined,
      elements: [],
      forms: [],
      links: [],
      navSource: 'crawl-link',
    };
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-4: crawl-seed route → also skip
  it('EC-HR-4: does not fire for crawl-seed routes', () => {
    const result = makeRenderResult('/seed-route');
    const page: DiscoveredPage = {
      route: '/seed-route',
      sourceFile: undefined,
      elements: [],
      forms: [],
      links: [],
      navSource: 'crawl-seed',
    };
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-5: root '/' returns 404
  it('EC-HR-5: fires for root / route returning 404', () => {
    const result = makeRenderResult('/');
    const page = makeFilesystemPage('/');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    const entry = out.perTestId.get(result.testId);
    expect(entry).toBeDefined();
    expect(entry!.add[0]!.targetPath).toBe('/');
  });

  // EC-HR-7: postState missing (perf disabled)
  it('EC-HR-7: does not fire when postState is absent', () => {
    const result: TestResult = {
      testId: 'no-poststate',
      occurrenceId: 'occ-no-poststate',
      passed: false,
      bugs: [],
      durationMs: 0,
    };
    const page = makeFilesystemPage('/some-route');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has('no-poststate')).toBe(false);
  });

  // EC-HR-7: networkRequests empty
  it('EC-HR-7: does not fire when networkRequests is empty', () => {
    const result = makeRenderResult('/some-route', {
      postState: {
        url: '/some-route',
        title: '',
        consoleErrors: [],
        networkRequests: [],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 0,
      },
    });
    const page = makeFilesystemPage('/some-route');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-9: 410 or 451 → does not fire
  it('EC-HR-9: does not fire for 410 (Gone)', () => {
    const result = makeRenderResult('/gone-page', {
      postState: {
        url: '/gone-page',
        title: '',
        consoleErrors: [],
        networkRequests: [{ method: 'GET', path: '/gone-page', status: 410, duration: 20 }],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 0,
      },
    });
    const page = makeFilesystemPage('/gone-page');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(false);
  });

  // EC-HR-10: navSource === undefined (static-page from surface_list_pages) qualifies
  it('EC-HR-10: fires for pages with navSource undefined (surface_list_pages)', () => {
    const result = makeRenderResult('/vite-route');
    const page: DiscoveredPage = {
      route: '/vite-route',
      sourceFile: undefined,
      elements: [],
      forms: [],
      links: [],
      navSource: undefined,
    };
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(true);
  });

  // static-page navSource qualifies
  it('fires for pages with navSource === static-page', () => {
    const result = makeRenderResult('/static-listed');
    const page: DiscoveredPage = {
      route: '/static-listed',
      sourceFile: undefined,
      elements: [],
      forms: [],
      links: [],
      navSource: 'static-page',
    };
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(true);
  });

  // removePredicate: removes 404_for_linked_route for the same page URL
  it('removePredicate removes 404_for_linked_route for the same page URL', () => {
    const result = makeRenderResult('/ghost');
    const page = makeFilesystemPage('/ghost');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    const { removePredicate } = out.perTestId.get(result.testId)!;

    const linkedRouteBug = { kind: '404_for_linked_route' as const, rootCause: 'x', targetPath: '/ghost' };
    const otherBug = { kind: '404_for_linked_route' as const, rootCause: 'x', targetPath: '/other' };
    expect(removePredicate(linkedRouteBug)).toBe(true);
    expect(removePredicate(otherBug)).toBe(false);
  });

  // removePredicate only removes the right kind
  it('removePredicate does not remove other bug kinds', () => {
    const result = makeRenderResult('/ghost');
    const page = makeFilesystemPage('/ghost');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    const { removePredicate } = out.perTestId.get(result.testId)!;

    const networkBug = { kind: 'network_4xx_unexpected' as const, rootCause: 'x', targetPath: '/ghost' };
    expect(removePredicate(networkBug)).toBe(false);
  });

  // path matching: tolerates trailing slash
  it('matches page route with trailing slash in HAR path', () => {
    const result = makeRenderResult('/products', {
      postState: {
        url: '/products',
        title: '',
        consoleErrors: [],
        networkRequests: [{ method: 'GET', path: '/products/', status: 404, duration: 10 }],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 0,
      },
    });
    const page = makeFilesystemPage('/products');
    const out = detectHallucinatedRoutes({ renderResults: [result], pages: [page], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.has(result.testId)).toBe(true);
  });

  // no results → empty map
  it('returns an empty map when renderResults is empty', () => {
    const out = detectHallucinatedRoutes({ renderResults: [], pages: [], fixtureUnresolvableRoutes: new Set() });
    expect(out.perTestId.size).toBe(0);
  });
});
