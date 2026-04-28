// Tests for runVisualBaseline — vision-baseline state-page reopen via clickByHint
// Covers spec SPEC_VISION_STATE_REOPEN.md § 4.2

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { runVisualBaseline } from './discover.js';
import type { BrowserMcpAdapter, TabScope, ClickByHintResult } from '../adapters/browser-mcp.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { BugHunterConfig, DiscoveredPage } from '../types.js';

const BASE_URL = 'http://localhost:3200';

function makeConfig(): BugHunterConfig {
  return {
    projectName: 'test',
    surfaceMcpUrl: 'http://127.0.0.1:3199/mcp',
    appBaseUrl: BASE_URL,
    roles: ['owner'],
    vision: { enabled: true },
  };
}

function makeVisionClient(): VisionClientInterface {
  return {
    classify: vi.fn().mockResolvedValue({ rawText: JSON.stringify({ anomalies: [] }) }),
  };
}

function makeVisionBudget(): VisionBudget {
  return {
    tryConsume: vi.fn().mockReturnValue(true),
    tryConsumeHash: vi.fn().mockReturnValue(true),
    recordUsage: vi.fn(),
    markAborted: vi.fn(),
    abortReason: undefined,
    consumed: 0,
    remaining: 100,
    cap: 100,
    costUsd: 0,
    costCapUsd: 1,
  };
}

function makeStatePage(baseRoute: string, triggerHint: { testId?: string; text?: string; ariaLabel?: string }): DiscoveredPage {
  return {
    route: `${baseRoute}#insights`,
    elements: [],
    forms: [],
    links: [],
    kind: 'state',
    stateContext: {
      baseRoute,
      stateVar: 'tab',
      stateValue: 'insights',
      triggerHint,
    },
  };
}

function makeUrlPage(route: string): DiscoveredPage {
  return { route, elements: [], forms: [], links: [], kind: 'url' };
}

/** Build a BrowserMcpAdapter whose withTab calls fn(scope) with a controllable TabScope. */
function makeBrowser(clickByHintResult: ClickByHintResult): {
  browser: BrowserMcpAdapter;
  scopeClickByHint: ReturnType<typeof vi.fn>;
  scopeClick: ReturnType<typeof vi.fn>;
  scopeScreenshot: ReturnType<typeof vi.fn>;
  withTabSpy: ReturnType<typeof vi.fn>;
} {
  const scopeClickByHint = vi.fn().mockResolvedValue(clickByHintResult);
  const scopeClick = vi.fn().mockResolvedValue({ clicked: true });
  const scopeScreenshot = vi.fn().mockImplementation(async (outputPath?: string) => {
    if (outputPath !== undefined) {
      fs.writeFileSync(outputPath, Buffer.from('PNG'));
    }
    return { path: outputPath ?? '' };
  });

  const scope: TabScope = {
    tabId: 'tab-1',
    navigate: vi.fn(),
    click: scopeClick,
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: scopeScreenshot,
    evaluate: vi.fn(),
    clickByHint: scopeClickByHint,
  };

  const withTabSpy = vi.fn().mockImplementation(
    async (_url: string, _headers: unknown, fn: (s: TabScope) => Promise<unknown>) => fn(scope)
  );

  const browser = {
    navigate: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    evaluate: vi.fn(),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: withTabSpy,
    clickByHint: vi.fn(),
  } as unknown as BrowserMcpAdapter;

  return { browser, scopeClickByHint, scopeClick, scopeScreenshot, withTabSpy };
}

// Case 1: kind:'state' page → scope.clickByHint called, screenshot taken
describe('vision-baseline state-page — clickByHint success', () => {
  it('calls clickByHint with triggerHint, takes screenshot, produces entry', async () => {
    const hint = { testId: 'tab-insights', text: 'Insights' };
    const { browser, scopeClickByHint, scopeClick, scopeScreenshot, withTabSpy } =
      makeBrowser({ clicked: true, matchedBy: 'testId' });

    const page = makeStatePage('/', hint);
    const entries = await runVisualBaseline(
      [page],
      makeConfig(),
      ['owner'],
      browser,
      makeVisionClient(),
      makeVisionBudget(),
    );

    // withTab opens the base route, not the state route
    expect(withTabSpy).toHaveBeenCalledOnce();
    expect(withTabSpy.mock.calls[0][0]).toBe(`${BASE_URL}/`);

    // clickByHint called with the triggerHint exactly
    expect(scopeClickByHint).toHaveBeenCalledOnce();
    expect(scopeClickByHint).toHaveBeenCalledWith(hint);

    // screenshot taken
    expect(scopeScreenshot).toHaveBeenCalledOnce();

    // old scope.click NOT called
    expect(scopeClick).not.toHaveBeenCalled();

    // one screenshot entry produced (vision returned 0 anomalies → 0 results, but entry was consumed)
    expect(entries).toHaveLength(0); // 0 anomalies → 0 VisualBaselineEntry; screenshot was taken
    // Verify screenshot was actually taken by checking scopeScreenshot was called
  }, 10_000);
});

// Case 2: kind:'state' page → clickByHint returns clicked:false → page skipped
describe('vision-baseline state-page — clickByHint failure', () => {
  it('does not call screenshot, swallows error, returns empty entries', async () => {
    const { browser, scopeScreenshot } = makeBrowser({ clicked: false, reason: 'not_found' });

    const page = makeStatePage('/', { testId: 'tab-insights' });
    let threw = false;
    try {
      const entries = await runVisualBaseline(
        [page],
        makeConfig(),
        ['owner'],
        browser,
        makeVisionClient(),
        makeVisionBudget(),
      );
      expect(entries).toHaveLength(0);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(scopeScreenshot).not.toHaveBeenCalled();
  }, 10_000);
});

// Case 3: kind:'url' page → existing path unchanged
describe('vision-baseline url-page — no clickByHint', () => {
  it('opens route directly, skips clickByHint, takes screenshot', async () => {
    const { browser, scopeClickByHint, scopeScreenshot, withTabSpy } =
      makeBrowser({ clicked: true, matchedBy: 'testId' });

    const page = makeUrlPage('/dashboard');
    await runVisualBaseline(
      [page],
      makeConfig(),
      ['owner'],
      browser,
      makeVisionClient(),
      makeVisionBudget(),
    );

    expect(withTabSpy).toHaveBeenCalledOnce();
    expect(withTabSpy.mock.calls[0][0]).toBe(`${BASE_URL}/dashboard`);
    expect(scopeClickByHint).not.toHaveBeenCalled();
    expect(scopeScreenshot).toHaveBeenCalledOnce();
  }, 10_000);
});

// Case 4: mixed batch — one state (success), one url, one state (trigger fails) → 2 screenshots taken
describe('vision-baseline mixed batch', () => {
  it('continues loop past failed trigger; 2 screenshots taken, 1 skipped', async () => {
    const hint = { testId: 'tab-insights', text: 'Insights' };

    // First call: success; second call: failure
    const scopeClickByHint = vi.fn()
      .mockResolvedValueOnce({ clicked: true, matchedBy: 'testId' } satisfies ClickByHintResult)
      .mockResolvedValueOnce({ clicked: false, reason: 'not_found' } satisfies ClickByHintResult);

    const scopeScreenshot = vi.fn().mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.from('PNG'));
      }
      return { path: outputPath ?? '' };
    });

    const scope: TabScope = {
      tabId: 'tab-1',
      navigate: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn(),
      snapshot: vi.fn(),
      screenshot: scopeScreenshot,
      evaluate: vi.fn(),
      clickByHint: scopeClickByHint,
    };

    const withTabSpy = vi.fn().mockImplementation(
      async (_url: string, _headers: unknown, fn: (s: TabScope) => Promise<unknown>) => fn(scope)
    );

    const browser = {
      navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
      snapshot: vi.fn(), screenshot: vi.fn(), evaluate: vi.fn(),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(),
      withTab: withTabSpy, clickByHint: vi.fn(),
    } as unknown as BrowserMcpAdapter;

    const pages: DiscoveredPage[] = [
      makeStatePage('/', hint),            // state, click succeeds → screenshot taken
      makeUrlPage('/dashboard'),           // url → screenshot taken
      makeStatePage('/app', { testId: 'tab-reports' }),  // state, click fails → skipped
    ];

    await runVisualBaseline(
      pages,
      makeConfig(),
      ['owner'],
      browser,
      makeVisionClient(),
      makeVisionBudget(),
    );

    // withTab called 3 times (once per page)
    expect(withTabSpy).toHaveBeenCalledTimes(3);

    // clickByHint called for the 2 state pages, not the url page
    expect(scopeClickByHint).toHaveBeenCalledTimes(2);

    // screenshots taken only for the 2 succeeding pages
    expect(scopeScreenshot).toHaveBeenCalledTimes(2);
  }, 10_000);
});
