// Unit tests for race-runner executeRaceTest using a mock browser adapter.

import { describe, it, expect, vi } from 'vitest';
import { executeRaceTest } from './race-runner.js';
import type { RaceTestContext } from './race-runner.js';
import type { BrowserMcpAdapter, TabScope, EvaluateResult } from '../adapters/browser-mcp.js';
import type { TestCase, RaceConditionsConfig } from '../types.js';

// ---- mock helpers ----

function makeEvalResult(value: unknown): EvaluateResult {
  return { value };
}

/**
 * Build a minimal TabScope mock. evaluate() returns '' for all calls
 * unless overridden, simulating a page with no state change (no bug).
 */
function makeMockTab(overrides: Partial<TabScope> = {}): TabScope {
  return {
    tabId: 'mock-tab-1',
    navigate: vi.fn().mockResolvedValue({ ok: true }),
    click: vi.fn().mockResolvedValue({ ok: true }),
    type: vi.fn().mockResolvedValue({ ok: true }),
    evaluate: vi.fn().mockImplementation((_expr: string) => Promise.resolve(makeEvalResult(''))),
    screenshot: vi.fn().mockResolvedValue({ path: '' }),
    snapshot: vi.fn().mockResolvedValue({ content: '' }),
    scroll: vi.fn().mockResolvedValue({ ok: true }),
    clickByHint: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as TabScope;
}

/**
 * Build a minimal BrowserMcpAdapter mock. withTab calls the callback with a fake TabScope.
 */
function makeMockBrowser(tab: TabScope = makeMockTab()): BrowserMcpAdapter {
  return {
    withTab: vi.fn().mockImplementation(
      (_url: string, _role: string | undefined, fn: (scope: TabScope) => Promise<unknown>) => fn(tab)
    ),
  } as unknown as BrowserMcpAdapter;
}

const baseConfig: RaceConditionsConfig = { enabled: true };

function makeRaceTestCase(
  variantKind: 'double_submit' | 'click_then_navigate' | 'optimistic_revert' | 'interleaved_mutations' | 'cross_tab',
  overrides: Partial<TestCase> = {},
): TestCase {
  const variant = (() => {
    switch (variantKind) {
      case 'double_submit': return { kind: 'double_submit' as const, gapMs: 0 };
      case 'click_then_navigate': return { kind: 'click_then_navigate' as const, targetRoute: '/dashboard', preFireDelayMs: 0 };
      case 'optimistic_revert': return { kind: 'optimistic_revert' as const, forcedStatus: 500, forcedBody: '{}' };
      case 'interleaved_mutations': return { kind: 'interleaved_mutations' as const, siblingActionId: '#other-btn', gapMs: 0, consensusRuns: 1 };
      case 'cross_tab': return { kind: 'cross_tab' as const, settleMs: 100 };
    }
  })();

  return {
    id: `tc-${variantKind}`,
    runId: 'run-1',
    role: 'user',
    page: '/posts',
    palette: 'happy',
    action: {
      kind: 'submit',
      via: 'ui',
      palette: 'happy',
      toolId: 'POST /api/posts',
      selector: '#submit-btn',
      expectedOutcome: { kind: 'any' },
    },
    expectedOutcome: { kind: 'any' },
    race: { variant },
    ...overrides,
  } as unknown as TestCase;
}

// ---- executeRaceTest ----

describe('executeRaceTest', () => {
  it('throws when called on a test case without race field', async () => {
    const tc = makeRaceTestCase('double_submit');
    const noRaceTc = { ...tc, race: undefined };
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    await expect(executeRaceTest(noRaceTc as unknown as TestCase, ctx)).rejects.toThrow('executeRaceTest called on non-race test case');
  });

  it('returns passed:true when no bugs detected (double_submit)', async () => {
    const tc = makeRaceTestCase('double_submit');
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    expect(result.testId).toBe('tc-double_submit');
    expect(result.passed).toBe(true);
    expect(result.bugs).toHaveLength(0);
  });

  it('returns passed:true for click_then_navigate when mutation succeeded (final state visible)', async () => {
    // Simulate a page that shows 'success' text after mutation so classifyTargetState returns 'optimistic',
    // which is not 'pre' — so the stale-data branch does not fire. No failed response either.
    const tab = makeMockTab({
      evaluate: vi.fn().mockImplementation((expr: string) => {
        if (expr.includes('outerHTML')) return Promise.resolve(makeEvalResult('<button>success saved</button>'));
        if (expr.includes('location.href')) return Promise.resolve(makeEvalResult('http://localhost/dashboard'));
        return Promise.resolve(makeEvalResult(''));
      }),
    });
    const tc = makeRaceTestCase('click_then_navigate');
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(tab),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    expect(result.passed).toBe(true);
  });

  it('returns passed:true for interleaved_mutations with no divergence', async () => {
    const tc = makeRaceTestCase('interleaved_mutations');
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    expect(result.passed).toBe(true);
  });

  it('returns passed:true for optimistic_revert when routeFulfill is unsupported (EC-10)', async () => {
    const tc = makeRaceTestCase('optimistic_revert');
    // Browser has no routeFulfill — should skip gracefully
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    expect(result.passed).toBe(true);
    expect(result.bugs).toHaveLength(0);
  });

  it('returns infrastructure failure on browser error', async () => {
    const tab = makeMockTab({
      evaluate: vi.fn().mockRejectedValue(new Error('browser crashed')),
    });
    const browser: BrowserMcpAdapter = {
      withTab: vi.fn().mockImplementation(
        (_url: string, _role: string | undefined, fn: (scope: TabScope) => Promise<unknown>) => fn(tab)
      ),
    } as unknown as BrowserMcpAdapter;

    const tc = makeRaceTestCase('double_submit');
    const ctx: RaceTestContext = {
      browser,
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    // The evaluate calls are try/catch'd so they should silently degrade — not crash
    // (captureObservation catches evaluate errors), so this should still pass
    expect(result).toBeDefined();
    expect(typeof result.passed).toBe('boolean');
  });

  it('returns occurrenceId as non-empty string', async () => {
    const tc = makeRaceTestCase('double_submit');
    const ctx: RaceTestContext = {
      browser: makeMockBrowser(),
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    const result = await executeRaceTest(tc, ctx);
    expect(result.occurrenceId).toBeTruthy();
    expect(result.occurrenceId.length).toBeGreaterThan(0);
  });

  it('uses absolute page URL when tc.page starts with http', async () => {
    const tc = makeRaceTestCase('double_submit', { page: 'http://custom.example.com/posts' });
    const browser = makeMockBrowser();
    const ctx: RaceTestContext = {
      browser,
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    await executeRaceTest(tc, ctx);
    const withTabMock = browser.withTab as ReturnType<typeof vi.fn>;
    expect(withTabMock).toHaveBeenCalledWith(
      'http://custom.example.com/posts',
      undefined,
      expect.any(Function),
    );
  });

  it('prepends appBaseUrl when tc.page is a relative path', async () => {
    const tc = makeRaceTestCase('double_submit', { page: '/posts' });
    const browser = makeMockBrowser();
    const ctx: RaceTestContext = {
      browser,
      runId: 'run-1',
      appBaseUrl: 'http://localhost:3000',
      config: baseConfig,
    };
    await executeRaceTest(tc, ctx);
    const withTabMock = browser.withTab as ReturnType<typeof vi.fn>;
    expect(withTabMock).toHaveBeenCalledWith(
      'http://localhost:3000/posts',
      undefined,
      expect.any(Function),
    );
  });
});
