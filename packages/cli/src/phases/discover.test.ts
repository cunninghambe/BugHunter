// Unit tests for runVisualBaseline v0.13 — SPEC_V13_VISION_BASELINE_AUTH.md § 6 (T1–T8)
// All tests use a mock BrowserMcpAdapter; no real camofox required.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { runVisualBaseline, runBrowserLoginPhase } from './discover.js';
import type { BrowserMcpAdapter, ClickByHintResult, CookieEntry } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter, DescribeAuthResult } from '../adapters/surface-mcp.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { BugHunterConfig, DiscoveredPage, AuthConfig } from '../types.js';

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

// v0.17 multi-viewport tests

/** Build a browser with optional setViewport support. */
function makeBrowserWithViewport(opts: {
  screenshotBytes?: number;
  setViewportResult?: { ok: true } | { ok: false; reason: string };
} = {}): BrowserMcpAdapter & { setViewport: ReturnType<typeof vi.fn> } {
  const { screenshotBytes = 2048, setViewportResult = { ok: true } } = opts;
  const base = makeBrowser({ screenshotBytes });
  const setViewportSpy = vi.fn().mockResolvedValue(setViewportResult);
  return { ...base, setViewport: setViewportSpy } as unknown as BrowserMcpAdapter & { setViewport: ReturnType<typeof vi.fn> };
}

// TV1: 3 viewports × 2 pages = 6 unique captures (all hashes unique)
describe('TV1: v0.17 multi-viewport — 3 viewports × 2 pages', () => {
  it('calls setViewport 3× per page and takes 6 unique screenshots', async () => {
    let screenshotIndex = 0;
    const browser = makeBrowser({ screenshotBytes: 2048 });
    // Return distinct bytes for each call so hashes differ.
    (browser.screenshot as ReturnType<typeof vi.fn>).mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.alloc(2048, screenshotIndex++));
      }
      return { path: outputPath ?? '' };
    });
    const setViewportSpy = vi.fn().mockResolvedValue({ ok: true });
    const browserWithVp = { ...browser, setViewport: setViewportSpy } as unknown as BrowserMcpAdapter;

    const pages = [urlPage('/a'), urlPage('/b')];
    const result = await runVisualBaseline(
      pages,
      makeConfig({ viewports: [375, 768, 1280] }),
      ['owner'],
      browserWithVp,
      makeVisionClient(),
      makeBudget(),
    );

    // setViewport called at least 6 times (3 viewports × 2 pages; restore calls also happen)
    expect(setViewportSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(result.telemetry?.uniqueScreenshots).toBe(6);
  }, 15_000);
});

// TV2: same content at all viewports → hash dedup → 1 classify call per page
describe('TV2: v0.17 hash dedup across viewports', () => {
  it('identical screenshots across all viewports dedup to 1 per page', async () => {
    let hashConsumed = 0;
    const budget = makeBudget({
      tryConsumeHash: () => hashConsumed++ === 0 || hashConsumed === 4, // accept 1st and 4th (one per page)
    });
    const browser = makeBrowserWithViewport({ screenshotBytes: 2048 });

    const pages = [urlPage('/login'), urlPage('/login-alt')];
    const result = await runVisualBaseline(
      pages,
      makeConfig({ viewports: [375, 768, 1280] }),
      ['owner'],
      browser,
      makeVisionClient(),
      budget,
    );

    expect(result.telemetry?.dedupedScreenshots).toBeGreaterThan(0);
    expect(result.telemetry?.uniqueScreenshots).toBeLessThan(6); // dedup reduced count
  }, 15_000);
});

// TV3: setViewport failure mid-loop → remaining viewports skipped for that page, next page proceeds
describe('TV3: v0.17 setViewport failure (EC-10) skips remaining viewports for page', () => {
  it('when setViewport fails at 768px, 1280px is skipped; next page is still processed', async () => {
    const setViewportSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true })                            // page1: 375px ok
      .mockResolvedValueOnce({ ok: false, reason: 'resize_failed' }) // page1: 768px fails
      .mockResolvedValueOnce({ ok: true })                            // page1: restore to 1280
      .mockResolvedValue({ ok: true });                               // page2: all ok

    let screenshotIndex = 0;
    const browser = makeBrowser({ screenshotBytes: 2048 });
    (browser.screenshot as ReturnType<typeof vi.fn>).mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.alloc(2048, screenshotIndex++));
      }
      return { path: outputPath ?? '' };
    });
    const browserWithVp = { ...browser, setViewport: setViewportSpy } as unknown as BrowserMcpAdapter;

    const pages = [urlPage('/a'), urlPage('/b')];
    await runVisualBaseline(
      pages,
      makeConfig({ viewports: [375, 768, 1280] }),
      ['owner'],
      browserWithVp,
      makeVisionClient(),
      makeBudget(),
    );

    // Page 1: only 375px captured (768px failed → viewportFailed=true → loop breaks)
    // Page 2: all 3 viewports (setViewport returns ok for page 2)
    // Total screenshots = 1 (page1/375) + 3 (page2) = 4
    expect((browser.screenshot as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
  }, 15_000);
});

// TV4: byViewport telemetry is populated correctly
describe('TV4: v0.17 byViewport telemetry in result', () => {
  it('result.byViewport has entries for each configured viewport', async () => {
    let screenshotIndex = 0;
    const browser = makeBrowserWithViewport({ screenshotBytes: 2048 });
    (browser.screenshot as ReturnType<typeof vi.fn>).mockImplementation(async (outputPath?: string) => {
      if (outputPath !== undefined) {
        fs.writeFileSync(outputPath, Buffer.alloc(2048, screenshotIndex++));
      }
      return { path: outputPath ?? '' };
    });

    const pages = [urlPage('/dash')];
    const result = await runVisualBaseline(
      pages,
      makeConfig({ viewports: [375, 1280] }),
      ['owner'],
      browser,
      makeVisionClient(),
      makeBudget(),
    );

    expect(result.byViewport).toBeDefined();
    expect(result.byViewport?.[375]).toBeDefined();
    expect(result.byViewport?.[1280]).toBeDefined();
    expect(result.byViewport?.[375]?.uniqueScreenshots).toBe(1);
    expect(result.byViewport?.[1280]?.uniqueScreenshots).toBe(1);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// runBrowserLoginPhase — skip-guard unit tests (issue #116)
// ---------------------------------------------------------------------------

const SURFACE_MCP_URL = 'http://127.0.0.1:3199/mcp';
const APP_BASE_URL = 'http://localhost:3002';

function makeMinimalConfig(overrides?: Partial<BugHunterConfig>): BugHunterConfig {
  return {
    projectName: 'test',
    surfaceMcpUrl: SURFACE_MCP_URL,
    appBaseUrl: APP_BASE_URL,
    roles: ['owner'],
    ...overrides,
  };
}

function makeMockSurface(authPlan?: DescribeAuthResult): SurfaceMcpAdapter {
  const plan: DescribeAuthResult = authPlan ?? {
    authKind: 'form',
    uiLoginPath: '/login',
    fields: { email: 'email', password: 'password' },
    values: { email: 'user@test.com', password: 'secret' },
    successCheck: { kind: 'cookie', name: 'session' },
    cookieName: 'session',
  };
  return {
    surface_describe_auth: vi.fn(async () => plan),
    surface_list_tools: vi.fn(),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn(),
    surface_describe_self: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

function makeMockBrowser(): BrowserMcpAdapter {
  return {
    navigate: vi.fn(async (url: string) => ({ url })),
    click: vi.fn(async () => ({ clicked: true })),
    type: vi.fn(async () => ({ typed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    snapshot: vi.fn(async () => ({ snapshot: '' })),
    screenshot: vi.fn(async () => ({ path: '' })),
    evaluate: vi.fn(async () => ({ value: null })),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    closeTab: vi.fn(async () => ({ closed: true })),
    openTab: vi.fn(async () => ({ tabId: 'tab1', finalUrl: '' })),
    closeTabExplicit: vi.fn(async () => {}),
    withTab: vi.fn(),
    cookies: vi.fn(async () => ({ tabId: 'tab1', cookies: [] })),
  } as unknown as BrowserMcpAdapter;
}

describe('runBrowserLoginPhase — skip guards (#116)', () => {
  it('auth.kind=none → skipped, no navigate call', async () => {
    const browser = makeMockBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: { kind: 'none' } });

    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toBe('auth.kind=none');
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(surface.surface_describe_auth).not.toHaveBeenCalled();
  });

  it('browserLogin.enabled=false → skipped, no navigate call', async () => {
    const browser = makeMockBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ browserLogin: { enabled: false } });

    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toBe('browserLogin.enabled=false');
    expect(browser.navigate).not.toHaveBeenCalled();
  });

  it('auth.kind=none takes precedence over browserLogin.enabled=true', async () => {
    const browser = makeMockBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: { kind: 'none' }, browserLogin: { enabled: true } });

    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toBe('auth.kind=none');
  });

  it('no browser adapter → skipped', async () => {
    const surface = makeMockSurface();
    const config = makeMinimalConfig();

    const result = await runBrowserLoginPhase(config, undefined, surface, ['owner']);

    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toContain('no browser adapter');
  });

  it('normal config + form auth → proceeds (not skipped)', async () => {
    const browser = makeMockBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig();

    // loginInBrowser will call surface_describe_auth; surface returns form plan
    // browser.navigate will be called
    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    // The login will proceed (not skipped at phase level) even if it fails inside loginInBrowser
    expect(result.skipped).toBe(false);
    expect(surface.surface_describe_auth).toHaveBeenCalled();
    expect(browser.navigate).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runBrowserLoginPhase — cookie-endpoint auth propagation (#171)
// Verifies that the session cookie set during loginViaCookieEndpoint is
// accessible in the same browser context that the crawler later uses.
// ---------------------------------------------------------------------------

const COOKIE_AUTH_CONFIG: Extract<AuthConfig, { kind: 'cookie' }> = {
  kind: 'cookie',
  loginEndpoint: {
    method: 'POST',
    url: '/api/auth/login',
    bodyShape: 'json',
    usernameField: 'email',
    passwordField: 'password',
  },
  cookieName: 'bench_session',
  credentials: {
    owner: { email: 'owner@bench.local', password: 'Owner123!' },
  },
};

const SESSION_COOKIE: CookieEntry = {
  name: 'bench_session',
  value: 'sess-abc123',
  domain: 'localhost',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

function makeCookieAuthBrowser(opts: { cookiePresent?: boolean } = {}): BrowserMcpAdapter {
  const cookiePresent = opts.cookiePresent ?? true;
  return {
    navigate: vi.fn(async (url: string) => ({ url })),
    click: vi.fn(async () => ({ clicked: true })),
    type: vi.fn(async () => ({ typed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    snapshot: vi.fn(async () => ({ snapshot: '' })),
    screenshot: vi.fn(async () => ({ path: '' })),
    evaluate: vi.fn(async () => ({ value: { status: 200, ok: true } })),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    closeTab: vi.fn(async () => ({ closed: true })),
    openTab: vi.fn(async () => ({ tabId: 'tab1', finalUrl: '' })),
    closeTabExplicit: vi.fn(async () => {}),
    withTab: vi.fn(),
    cookies: vi.fn(async () => ({
      tabId: 'tab1',
      cookies: cookiePresent ? [SESSION_COOKIE] : [],
    })),
  } as unknown as BrowserMcpAdapter;
}

describe('runBrowserLoginPhase — cookie-endpoint auth propagation (#171)', () => {
  it('cookie auth: navigate(baseUrl) is called so the browser tab exists before the in-browser fetch', async () => {
    const browser = makeCookieAuthBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: COOKIE_AUTH_CONFIG, appBaseUrl: APP_BASE_URL });

    await runBrowserLoginPhase(config, browser, surface, ['owner']);

    // navigate must be called with appBaseUrl to open a browser tab before evaluate()
    const navigateCalls = (browser.navigate as ReturnType<typeof vi.fn>).mock.calls;
    expect(navigateCalls.length).toBeGreaterThan(0);
    expect(navigateCalls[0]?.[0]).toBe(APP_BASE_URL);
  });

  it('cookie auth: login succeeds and phase returns skipped=false with loginRole', async () => {
    const browser = makeCookieAuthBrowser({ cookiePresent: true });
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: COOKIE_AUTH_CONFIG, appBaseUrl: APP_BASE_URL });

    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.loginRole).toBe('owner');
      expect(result.skipItem).toBeUndefined();
    }
  });

  it('cookie auth: evaluate is called with credentials-include fetch script (#171)', async () => {
    const browser = makeCookieAuthBrowser();
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: COOKIE_AUTH_CONFIG, appBaseUrl: APP_BASE_URL });

    await runBrowserLoginPhase(config, browser, surface, ['owner']);

    const evaluateCalls = (browser.evaluate as ReturnType<typeof vi.fn>).mock.calls;
    expect(evaluateCalls.length).toBeGreaterThan(0);
    const script = evaluateCalls[0]?.[0] as string;
    expect(script).toContain('credentials');
    expect(script).toContain('include');
    // The fetch runs AFTER navigate — verify call order
    const navOrder = (browser.navigate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    const evalOrder = (browser.evaluate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Infinity;
    expect(navOrder).toBeLessThan(evalOrder);
  });

  it('cookie auth: missing session cookie after fetch → skipItem set, phase not skipped', async () => {
    const browser = makeCookieAuthBrowser({ cookiePresent: false });
    const surface = makeMockSurface();
    const config = makeMinimalConfig({ auth: COOKIE_AUTH_CONFIG, appBaseUrl: APP_BASE_URL });

    const result = await runBrowserLoginPhase(config, browser, surface, ['owner']);

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.skipItem).toBeDefined();
      expect(result.skipItem?.reason).toContain('browser_login_');
    }
  });
});
