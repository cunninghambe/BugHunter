// Unit tests for runVisualBaseline v0.13 — SPEC_V13_VISION_BASELINE_AUTH.md § 6 (T1–T8)
// All tests use a mock BrowserMcpAdapter; no real camofox required.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { runVisualBaseline } from './discover.js';
import type { BrowserMcpAdapter, ClickByHintResult } from '../adapters/browser-mcp.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { BugHunterConfig, DiscoveredPage } from '../types.js';

const BASE_URL = 'http://localhost:3200';
// Low settle for tests — overrides the 2500ms default
const TEST_SETTLE_MS = 10;

function makeConfig(overrides?: Partial<BugHunterConfig['vision']>): BugHunterConfig {
  return {
    projectName: 'test',
    surfaceMcpUrl: 'http://127.0.0.1:3199/mcp',
    appBaseUrl: BASE_URL,
    roles: ['owner'],
    vision: { enabled: true, preScreenshotSettleMs: TEST_SETTLE_MS, ...overrides },
  };
}

function makeVisionClient(): VisionClientInterface {
  return {
    classify: vi.fn().mockResolvedValue({ rawText: JSON.stringify({ anomalies: [] }) }),
  };
}

function makeBudget(overrides?: {
  tryConsume?: () => boolean;
  tryConsumeHash?: (h: string) => boolean;
}): VisionBudget {
  return {
    tryConsume: vi.fn().mockImplementation(overrides?.tryConsume ?? (() => true)),
    tryConsumeHash: vi.fn().mockImplementation(overrides?.tryConsumeHash ?? (() => true)),
    recordUsage: vi.fn(),
    markAborted: vi.fn(),
    abortReason: undefined,
    consumed: 0,
    remaining: 100,
    cap: 100,
    costUsd: 0,
    costCapUsd: 20,
  };
}

function urlPage(route: string): DiscoveredPage {
  return { route, elements: [], forms: [], links: [], kind: 'url' };
}

function statePage(baseRoute: string, triggerHint: { testId?: string; text?: string }): DiscoveredPage {
  return {
    route: `${baseRoute}#state`,
    elements: [],
    forms: [],
    links: [],
    kind: 'state',
    stateContext: { baseRoute, stateVar: 'tab', stateValue: 'state', triggerHint },
  };
}

/** Builds a singleton-tab BrowserMcpAdapter stub. */
function makeBrowser(opts: {
  evaluatePathname?: string;
  screenshotBytes?: number;
  clickByHintResult?: ClickByHintResult;
  clickByHintResults?: ClickByHintResult[];
} = {}): BrowserMcpAdapter {
  const {
    evaluatePathname = '/dashboard',
    screenshotBytes = 2048,
    clickByHintResult = { clicked: true, matchedBy: 'testId' as const },
    clickByHintResults,
  } = opts;

  const clickByHintFn = clickByHintResults !== undefined
    ? vi.fn().mockImplementation(() => Promise.resolve(clickByHintResults.shift() ?? { clicked: false, reason: 'not_found' as const }))
    : vi.fn().mockResolvedValue(clickByHintResult);

  return {
    navigate: vi.fn().mockResolvedValue({ url: BASE_URL }),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn().mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.alloc(screenshotBytes, 0x89));
      }
      return { path: outputPath ?? '' };
    }),
    evaluate: vi.fn().mockResolvedValue({ value: evaluatePathname }),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: vi.fn(),
    cookies: vi.fn().mockResolvedValue({ tabId: 'tab-1', cookies: [] }),
    clickByHint: clickByHintFn,
  } as unknown as BrowserMcpAdapter;
}

// T1: 3 url-kind pages → 3 navigate + 3 screenshot, zero withTab
describe('T1: url-kind pages use singleton tab', () => {
  it('issues 3 navigate + 3 screenshot; zero withTab calls', async () => {
    const browser = makeBrowser();
    const pages = [urlPage('/a'), urlPage('/b'), urlPage('/c')];

    await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), makeBudget());

    // 1 navigate from probeAuthHealth (to baseUrl) + 3 from per-page navigateForScreenshot.
    expect(browser.navigate).toHaveBeenCalledTimes(4);
    expect(browser.screenshot).toHaveBeenCalledTimes(3);
    expect(browser.withTab).not.toHaveBeenCalled();
  }, 10_000);
});

// T2: 1 state-kind page → navigate(baseRoute) + clickByHint + screenshot
describe('T2: state-kind page uses navigate + clickByHint', () => {
  it('issues navigate to baseRoute, then clickByHint, then screenshot', async () => {
    const browser = makeBrowser();
    const hint = { testId: 'tab-x' };
    const page = statePage('/base', hint);

    await runVisualBaseline([page], makeConfig(), ['owner'], browser, makeVisionClient(), makeBudget());

    expect(browser.navigate).toHaveBeenCalledWith(`${BASE_URL}/base`, undefined);
    expect(browser.clickByHint).toHaveBeenCalledWith(hint);
    expect(browser.screenshot).toHaveBeenCalledOnce();
    expect(browser.withTab).not.toHaveBeenCalled();
  }, 10_000);
});

// T3: hash dedup — 3 identical screenshots → 1 tryConsumeHash accept, 2 rejects, tryConsume once
describe('T3: hash dedup collapses identical screenshots', () => {
  it('calls tryConsumeHash 3 times; only first returns true; tryConsume called once', async () => {
    let callCount = 0;
    const budget = makeBudget({
      tryConsumeHash: () => callCount++ === 0,
    });
    const browser = makeBrowser({ screenshotBytes: 2048 });
    // All pages return the same screenshot bytes (same hash)
    const pages = [urlPage('/a'), urlPage('/b'), urlPage('/c')];

    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), budget);

    expect(budget.tryConsumeHash).toHaveBeenCalledTimes(3);
    expect(budget.tryConsume).toHaveBeenCalledTimes(1);
    expect(result.telemetry?.uniqueScreenshots).toBe(1);
    expect(result.telemetry?.dedupedScreenshots).toBe(2);
  }, 10_000);
});

// T4: auth-health probe negative → runVisualBaseline returns [] with authLostMidLoop telemetry
describe('T4: auth-health probe negative aborts before loop', () => {
  it('returns empty entries and authLostMidLoop:true when probe sees /auth/login', async () => {
    const browser = makeBrowser({ evaluatePathname: '/auth/login' });
    const pages = [urlPage('/dashboard'), urlPage('/users')];

    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), makeBudget());

    expect(result.entries).toHaveLength(0);
    expect(result.telemetry?.authLostMidLoop).toBe(true);
    // No screenshots taken — probe fired before the loop
    expect(browser.screenshot).not.toHaveBeenCalled();
  }, 10_000);
});

// T5: EC-1 mid-loop auth loss → current route skipped, rest of loop aborted
describe('T5: mid-loop auth loss (EC-1)', () => {
  it('aborts remaining routes when navigate redirects to /auth/login', async () => {
    // evaluate returns /dashboard for the probe, then /auth/login after second navigate
    const evaluateSpy = vi.fn()
      .mockResolvedValueOnce({ value: '/dashboard' })  // pre-loop probe → authed
      .mockResolvedValueOnce({ value: '/auth/login' }) // post-navigate page 1 check → auth lost
      .mockResolvedValue({ value: '/auth/login' });     // subsequent calls

    const screenshotSpy = vi.fn().mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) fs.writeFileSync(outputPath, Buffer.alloc(2048, 0x89));
      return { path: outputPath ?? '' };
    });

    const browser = {
      navigate: vi.fn().mockResolvedValue({ url: BASE_URL }),
      click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
      snapshot: vi.fn(), screenshot: screenshotSpy,
      evaluate: evaluateSpy,
      listTabs: vi.fn(), closeTab: vi.fn(), openTab: vi.fn(), closeTabExplicit: vi.fn(),
      withTab: vi.fn(),
      cookies: vi.fn().mockResolvedValue({ tabId: 'tab-1', cookies: [] }),
      clickByHint: vi.fn().mockResolvedValue({ clicked: true, matchedBy: 'testId' as const }),
    } as unknown as BrowserMcpAdapter;

    const pages = [urlPage('/dashboard'), urlPage('/users'), urlPage('/settings')];
    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), makeBudget());

    expect(result.telemetry?.authLostMidLoop).toBe(true);
    // Page 1 redirected to /auth/login → no screenshot + loop aborted → pages 2 & 3 never navigated
    expect(screenshotSpy).not.toHaveBeenCalled();
  }, 10_000);
});

// T6: EC-7 — state-kind page where clickByHint fails → that route skipped, loop continues
describe('T6: EC-7 state trigger failure — skips route, continues loop', () => {
  it('skips state page with failed trigger; next url page is still screenshotted', async () => {
    const browser = makeBrowser({
      clickByHintResults: [
        { clicked: false, reason: 'not_found' },  // state page fails
      ],
    });
    const pages = [
      statePage('/base', { testId: 'tab-x' }),  // fails
      urlPage('/dashboard'),                     // succeeds
    ];

    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), makeBudget());

    // clickByHint called once for the state page
    expect(browser.clickByHint).toHaveBeenCalledTimes(1);
    // screenshot called once for the url page only
    expect(browser.screenshot).toHaveBeenCalledTimes(1);
    expect(result.telemetry?.uniqueScreenshots).toBe(1);
  }, 10_000);
});

// T7: EC-11 — budget caps at 2 calls, third route's tryConsume returns false → break
describe('T7: EC-11 budget exhaustion breaks the loop', () => {
  it('stops after 2 tryConsume calls; screenshotEntries.length === 2', async () => {
    let consumeCalls = 0;
    const budget = makeBudget({
      tryConsume: () => ++consumeCalls <= 2,
    });
    const browser = makeBrowser({ screenshotBytes: 2048 });
    const pages = [urlPage('/a'), urlPage('/b'), urlPage('/c')];

    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), budget);

    expect(budget.tryConsume).toHaveBeenCalledTimes(3); // third call returns false
    expect(result.telemetry?.uniqueScreenshots).toBe(2);
  }, 10_000);
});

// T8: EC-6 — screenshot < 1024 bytes → skipped, no budget consumed
describe('T8: EC-6 small screenshot skipped without consuming budget', () => {
  it('drops screenshots under 1024 bytes; increments screenshotsTooSmall counter', async () => {
    const browser = makeBrowser({ screenshotBytes: 512 }); // below 1024 threshold
    const budget = makeBudget();
    const pages = [urlPage('/a'), urlPage('/b')];

    const result = await runVisualBaseline(pages, makeConfig(), ['owner'], browser, makeVisionClient(), budget);

    // No budget consumed
    expect(budget.tryConsume).not.toHaveBeenCalled();
    expect(result.telemetry?.screenshotsTooSmall).toBe(2);
    expect(result.telemetry?.uniqueScreenshots).toBe(0);
  }, 10_000);
});
