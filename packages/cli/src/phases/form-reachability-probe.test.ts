// Tests for runFormReachabilityProbes (v0.11 §6.2).

import { describe, it, expect, vi } from 'vitest';
import { runFormReachabilityProbes, probeKey } from './form-reachability-probe.js';
import type { DiscoveredPage } from '../types.js';

function makeStatePage(route: string, formSelector = 'form:nth-of-type(1)'): DiscoveredPage {
  return {
    route,
    elements: [],
    forms: [{ formSelector, method: 'POST', fields: [{ name: 'name', type: 'text', required: true }] }],
    links: [],
    kind: 'state',
    stateContext: {
      baseRoute: '/',
      stateVar: 'setTab',
      stateValue: route.replace('/?setTab=', ''),
      triggerHint: { text: 'Tab' },
    },
  };
}

function makeUrlPage(route: string): DiscoveredPage {
  return {
    route,
    elements: [],
    forms: [{ formSelector: 'form', method: 'POST', fields: [{ name: 'email', type: 'email', required: true }] }],
    links: [],
    kind: 'url',
  };
}

function makeBrowser(clickResult = true, formPresent = true) {
  return {
    withTab: vi.fn(async (_url: string, _headers: unknown, fn: (scope: unknown) => Promise<unknown>) => {
      const scope = {
        clickByHint: vi.fn().mockResolvedValue(clickResult ? { clicked: true, matchedBy: 'text' } : { clicked: false, reason: 'not_found' }),
        evaluate: vi.fn().mockResolvedValue({ value: formPresent }),
      };
      return fn(scope);
    }),
  };
}

describe('runFormReachabilityProbes', () => {
  it('skips url-kind pages', async () => {
    const browser = makeBrowser();
    const { results, telemetry } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages: [makeUrlPage('/login')],
      roles: ['owner'],
      runId: 'r1',
      asyncMaxWaitMs: 200,
      perProbeTimeoutMs: 500,
      budgetMs: 10_000,
    });
    expect(results.size).toBe(0);
    expect(telemetry.probesRun).toBe(0);
  });

  it('probes once per (role, state-page, formSelector)', async () => {
    const browser = makeBrowser();
    const pages = [makeStatePage('/?setTab=profile'), makeStatePage('/?setTab=trades'), makeStatePage('/?setTab=settings')];
    const { telemetry } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages,
      roles: ['owner', 'anon'],
      runId: 'r1',
      asyncMaxWaitMs: 200,
      perProbeTimeoutMs: 500,
      budgetMs: 60_000,
    });
    expect(telemetry.probesRun).toBe(6); // 2 roles × 3 pages × 1 form
  });

  it('records formPresent:true when evaluate resolves with true', async () => {
    const browser = makeBrowser(true, true);
    const page = makeStatePage('/?setTab=profile');
    const { results } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages: [page],
      roles: ['owner'],
      runId: 'r1',
      asyncMaxWaitMs: 200,
      perProbeTimeoutMs: 500,
      budgetMs: 10_000,
    });
    const key = probeKey('owner', '/?setTab=profile', 'form:nth-of-type(1)');
    const result = results.get(key);
    expect(result?.probed).toBe(true);
    expect(result?.formPresent).toBe(true);
  });

  it('records form_never_rendered when evaluate returns false (form absent)', async () => {
    const browser = makeBrowser(true, false);
    const page = makeStatePage('/?setTab=profile');
    const { results } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages: [page],
      roles: ['anon'],
      runId: 'r1',
      asyncMaxWaitMs: 200,
      perProbeTimeoutMs: 500,
      budgetMs: 10_000,
    });
    const key = probeKey('anon', '/?setTab=profile', 'form:nth-of-type(1)');
    const result = results.get(key);
    expect(result?.probed).toBe(true);
    expect(result?.formPresent).toBe(false);
    if (result !== undefined && !result.formPresent) {
      expect(result.reason).toBe('form_never_rendered');
    }
  });

  it('records trigger_not_found when clickByHint returns clicked:false', async () => {
    const browser = makeBrowser(false, false);
    const page = makeStatePage('/?setTab=profile');
    const { results } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages: [page],
      roles: ['owner'],
      runId: 'r1',
      asyncMaxWaitMs: 200,
      perProbeTimeoutMs: 500,
      budgetMs: 10_000,
    });
    const key = probeKey('owner', '/?setTab=profile', 'form:nth-of-type(1)');
    const result = results.get(key);
    expect(result?.formPresent).toBe(false);
    if (result !== undefined && !result.formPresent) {
      expect(result.reason).toBe('trigger_not_found');
    }
  });

  it('aborts when budgetMs exhausted; remaining tuples absent from results', async () => {
    // Each probe would take perProbeTimeoutMs=200ms; budget only allows ~0 probes after start
    const browser = makeBrowser(true, true);
    const pages = [
      makeStatePage('/?setTab=p1'),
      makeStatePage('/?setTab=p2'),
      makeStatePage('/?setTab=p3'),
      makeStatePage('/?setTab=p4'),
      makeStatePage('/?setTab=p5'),
    ];
    const { results, telemetry } = await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages,
      roles: ['owner'],
      runId: 'r1',
      asyncMaxWaitMs: 50,
      perProbeTimeoutMs: 10_000, // larger than budgetMs so nothing runs
      budgetMs: 100,
    });
    // With budgetMs=100 and perProbeTimeoutMs=10000, all probes are skipped
    expect(telemetry.skippedByBudget).toBeGreaterThan(0);
    expect(results.size).toBe(0);
  });

  it('runs sequentially — each probe opens its own withTab call', async () => {
    const callOrder: string[] = [];
    const browser = {
      withTab: vi.fn(async (url: string, _h: unknown, fn: (scope: unknown) => Promise<unknown>) => {
        callOrder.push(`open:${url}`);
        const scope = {
          clickByHint: vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'text' }),
          evaluate: vi.fn().mockResolvedValue({ value: true }),
        };
        const result = await fn(scope);
        callOrder.push(`close:${url}`);
        return result;
      }),
    };
    const pages = [makeStatePage('/?setTab=a'), makeStatePage('/?setTab=b')];
    await runFormReachabilityProbes({
      browser: browser as never,
      appBaseUrl: 'http://localhost:3000',
      pages,
      roles: ['owner'],
      runId: 'r1',
      asyncMaxWaitMs: 100,
      perProbeTimeoutMs: 2000,
      budgetMs: 60_000,
    });
    // Sequential: each open is followed by its close before the next open
    expect(callOrder[0]).toMatch(/^open:/);
    expect(callOrder[1]).toMatch(/^close:/);
    expect(callOrder[2]).toMatch(/^open:/);
    expect(callOrder[3]).toMatch(/^close:/);
    expect(browser.withTab).toHaveBeenCalledTimes(2);
  });
});
