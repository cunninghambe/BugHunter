// Tests for runVisualBaseline — singleton-tab sequential screenshots (v0.13)
// Updated from SPEC_VISION_STATE_REOPEN.md to SPEC_V13_VISION_BASELINE_AUTH.md § 4, § 6

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { runVisualBaseline } from './discover.js';
import type { BrowserMcpAdapter, ClickByHintResult } from '../adapters/browser-mcp.js';
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
    vision: { enabled: true, preScreenshotSettleMs: 10 },
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

/** Build a singleton-tab BrowserMcpAdapter stub (v0.13 design). */
function makeBrowser(clickByHintResult: ClickByHintResult, evaluatePathname = '/dashboard'): {
  browser: BrowserMcpAdapter;
  navigateSpy: ReturnType<typeof vi.fn>;
  screenshotSpy: ReturnType<typeof vi.fn>;
  clickByHintSpy: ReturnType<typeof vi.fn>;
  evaluateSpy: ReturnType<typeof vi.fn>;
} {
  const navigateSpy = vi.fn().mockResolvedValue({ url: BASE_URL });
  const screenshotSpy = vi.fn().mockImplementation(async (outputPath?: string) => {
    if (outputPath !== undefined) {
      fs.writeFileSync(outputPath, Buffer.alloc(2048, 'PNG'));
    }
    return { path: outputPath ?? '' };
  });
  const clickByHintSpy = vi.fn().mockResolvedValue(clickByHintResult);
  const evaluateSpy = vi.fn().mockResolvedValue({ value: evaluatePathname });

  const browser = {
    navigate: navigateSpy,
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: screenshotSpy,
    evaluate: evaluateSpy,
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: vi.fn(),
    cookies: vi.fn().mockResolvedValue({ tabId: 'tab-1', cookies: [] }),
    clickByHint: clickByHintSpy,
  } as unknown as BrowserMcpAdapter;

  return { browser, navigateSpy, screenshotSpy, clickByHintSpy, evaluateSpy };
}

// Case 1: kind:'state' page → browser.navigate to baseRoute, clickByHint, screenshot taken
describe('vision-baseline state-page — clickByHint success (singleton tab)', () => {
  it('navigates singleton tab to base route, calls clickByHint, takes screenshot', async () => {
    const hint = { testId: 'tab-insights', text: 'Insights' };
    const { browser, navigateSpy, clickByHintSpy, screenshotSpy } =
      makeBrowser({ clicked: true, matchedBy: 'testId' });

    const page = makeStatePage('/', hint);
    const result = await runVisualBaseline(
      [page],
      makeConfig(),
      ['owner'],
      browser,
      makeVisionClient(),
      makeVisionBudget(),
    );

    // singleton tab navigates to base route (not the state route)
    expect(navigateSpy).toHaveBeenCalledWith(`${BASE_URL}/`, undefined);

    // clickByHint called with the triggerHint
    expect(clickByHintSpy).toHaveBeenCalledWith(hint);

    // screenshot taken on the singleton tab
    expect(screenshotSpy).toHaveBeenCalledOnce();

    // withTab must NOT be called
    expect((browser.withTab as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    expect(result.entries).toHaveLength(0); // 0 anomalies → 0 VisualBaselineEntry
  }, 10_000);
});

// Case 2: kind:'state' page → clickByHint returns clicked:false → page skipped
describe('vision-baseline state-page — clickByHint failure (singleton tab)', () => {
  it('skips screenshot, continues loop, does not throw', async () => {
    const { browser, screenshotSpy } = makeBrowser({ clicked: false, reason: 'not_found' });

    const page = makeStatePage('/', { testId: 'tab-insights' });
    let threw = false;
    try {
      const result = await runVisualBaseline(
        [page],
        makeConfig(),
        ['owner'],
        browser,
        makeVisionClient(),
        makeVisionBudget(),
      );
      expect(result.entries).toHaveLength(0);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(screenshotSpy).not.toHaveBeenCalled();
  }, 10_000);
});

// Case 3: kind:'url' page → browser.navigate to route, no clickByHint
describe('vision-baseline url-page — singleton tab, no clickByHint', () => {
  it('navigates singleton tab to the route, skips clickByHint, takes screenshot', async () => {
    const { browser, navigateSpy, clickByHintSpy, screenshotSpy } =
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

    expect(navigateSpy).toHaveBeenCalledWith(`${BASE_URL}/dashboard`, undefined);
    expect(clickByHintSpy).not.toHaveBeenCalled();
    expect(screenshotSpy).toHaveBeenCalledOnce();
    expect((browser.withTab as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  }, 10_000);
});

// Case 4: mixed batch — one state (success), one url, one state (trigger fails) → 2 screenshots
describe('vision-baseline mixed batch (singleton tab)', () => {
  it('continues loop past failed trigger; 2 screenshots taken, 1 skipped', async () => {
    const hint = { testId: 'tab-insights', text: 'Insights' };
    const clickByHintSpy = vi.fn()
      .mockResolvedValueOnce({ clicked: true, matchedBy: 'testId' } satisfies ClickByHintResult)
      .mockResolvedValueOnce({ clicked: false, reason: 'not_found' } satisfies ClickByHintResult);

    const screenshotSpy = vi.fn().mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.alloc(2048, 'PNG'));
      }
      return { path: outputPath ?? '' };
    });

    const browser = {
      navigate: vi.fn().mockResolvedValue({ url: BASE_URL }),
      click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
      snapshot: vi.fn(), screenshot: screenshotSpy,
      evaluate: vi.fn().mockResolvedValue({ value: '/dashboard' }),
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(),
      withTab: vi.fn(),
      cookies: vi.fn().mockResolvedValue({ tabId: 'tab-1', cookies: [] }),
      clickByHint: clickByHintSpy,
    } as unknown as BrowserMcpAdapter;

    const pages: DiscoveredPage[] = [
      makeStatePage('/', hint),                                   // state, click succeeds → screenshot
      makeUrlPage('/dashboard'),                                  // url → screenshot
      makeStatePage('/app', { testId: 'tab-reports' }),           // state, click fails → skipped
    ];

    await runVisualBaseline(
      pages,
      makeConfig(),
      ['owner'],
      browser,
      makeVisionClient(),
      makeVisionBudget(),
    );

    // withTab must NOT be called
    expect((browser.withTab as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // clickByHint called for the 2 state pages, not the url page
    expect(clickByHintSpy).toHaveBeenCalledTimes(2);

    // screenshots taken only for the 2 succeeding pages
    expect(screenshotSpy).toHaveBeenCalledTimes(2);
  }, 10_000);
});
