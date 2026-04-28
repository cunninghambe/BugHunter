// Tests for loginInBrowser — :has-text() evaluate-only modal flow (spec §8.2)
import { describe, it, expect, vi } from 'vitest';
import { loginInBrowser } from '../../src/discovery/browser-login.js';
import type { BrowserMcpAdapter, CookieEntry } from '../../src/adapters/browser-mcp.js';
import type { SurfaceMcpAdapter, DescribeAuthResult } from '../../src/adapters/surface-mcp.js';

const BASE_URL = 'http://localhost:3002';
const DEFAULT_OPTS = { role: 'owner', baseUrl: BASE_URL, verifyTimeoutMs: 100, verifyPollMs: 10 };

const SESSION_COOKIE: CookieEntry = {
  name: 'session',
  value: 'tok123',
  domain: 'localhost',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
};

function makeSurface(plan: DescribeAuthResult): SurfaceMcpAdapter {
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

// Plan with a :has-text() trigger selector (TraiderJo shape)
const HAS_TEXT_PLAN: DescribeAuthResult = {
  authKind: 'form',
  uiLoginPath: '/login',
  uiTriggerSelector: 'button:has-text("log in")',
  fields: { email: 'email', password: 'password' },
  values: { email: 'owner@test.com', password: 'secret' },
  successCheck: { kind: 'cookie', name: 'session' },
  cookieName: 'session',
};

/**
 * Build a browser mock for the evaluate-only modal flow.
 * browser.click and browser.snapshot throw if called — this enforces the
 * constraint that they must not be used in the :has-text() path.
 */
function makeModalBrowser(opts: {
  triggerFound?: boolean;
  fieldFound?: boolean;
  submitFound?: boolean;
  cookiesAvailable?: boolean;
} = {}): BrowserMcpAdapter {
  const triggerFound = opts.triggerFound ?? true;
  const fieldFound = opts.fieldFound ?? true;
  const submitFound = opts.submitFound ?? true;
  const cookiesAvailable = opts.cookiesAvailable ?? true;

  // Track calls to querySelectorAll+MouseEvent scripts: call #1 is the trigger;
  // calls #2+ are submit attempts (SUBMIT_LABELS fallback or :has-text() submit).
  let clickByTextCallCount = 0;
  let cookieCallCount = 0;

  return {
    navigate: vi.fn(async (_url: string) => ({ url: _url })),
    // These MUST NOT be called in the :has-text() evaluate-only path
    click: vi.fn(async () => { throw new Error('browser.click must not be called in evaluate-only path'); }),
    snapshot: vi.fn(async () => { throw new Error('browser.snapshot must not be called in evaluate-only path'); }),
    type: vi.fn(async () => ({ typed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    screenshot: vi.fn(async () => ({ path: '' })),
    evaluate: vi.fn(async (script: string) => {
      // captcha/2FA detection
      if (script.includes('captcha')) {
        return { value: { captcha: false, twoFa: false } };
      }
      // tryClickByText — contains querySelectorAll + MouseEvent dispatch
      if (script.includes('querySelectorAll') && script.includes('dispatchEvent(new MouseEvent')) {
        clickByTextCallCount++;
        if (clickByTextCallCount === 1) {
          // First call = trigger click
          return { value: triggerFound };
        }
        // Subsequent calls = submit (SUBMIT_LABELS fallback or :has-text() submit)
        return { value: submitFound };
      }
      // tryClickByCssSelector — querySelector + MouseEvent (CSS submit selector)
      if (script.includes('querySelector(') && script.includes('dispatchEvent(new MouseEvent')) {
        return { value: submitFound };
      }
      // tryTypeByCssSelector — uses getOwnPropertyDescriptor + native setter
      if (script.includes('getOwnPropertyDescriptor')) {
        return { value: fieldFound };
      }
      // verifySuccess URL check
      if (script.includes('location.href')) {
        return { value: 'http://localhost:3002/dashboard' };
      }
      return { value: null };
    }),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    closeTab: vi.fn(async () => ({ closed: true })),
    openTab: vi.fn(async () => ({ tabId: 'tab1', finalUrl: '' })),
    closeTabExplicit: vi.fn(async () => {}),
    withTab: vi.fn(),
    cookies: vi.fn(async (_urls?: string[]) => {
      if (!cookiesAvailable) throw new Error('cookies unavailable');
      cookieCallCount++;
      // First call = fast-path check → empty; subsequent → session cookie
      if (cookieCallCount <= 1) return { tabId: 'tab1', cookies: [] };
      return { tabId: 'tab1', cookies: [SESSION_COOKIE] };
    }),
  } as unknown as BrowserMcpAdapter;
}

describe('loginInBrowser — :has-text() modal flow', () => {
  it('clicks trigger via evaluate when uiTriggerSelector is :has-text()', async () => {
    const browser = makeModalBrowser();
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(browser.evaluate).toHaveBeenCalled();
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('does NOT call browser.snapshot at any point', async () => {
    const browser = makeModalBrowser();
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(browser.snapshot).not.toHaveBeenCalled();
  });

  it('does NOT call browser.click for trigger or submit', async () => {
    const browser = makeModalBrowser();
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('types into fields via evaluate using native prototype setter', async () => {
    const browser = makeModalBrowser();
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    const typingCall = calls.find(s => s.includes('getOwnPropertyDescriptor'));
    expect(typingCall).toBeDefined();
    expect(typingCall).toMatch(/getOwnPropertyDescriptor/);
    expect(typingCall).toMatch(/dispatchEvent\(new Event\('input'/);
    expect(typingCall).toMatch(/dispatchEvent\(new Event\('change'/);
  });

  it('trigger click script uses MouseEvent with bubbles and cancelable', async () => {
    const browser = makeModalBrowser();
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    const clickCall = calls.find(s => s.includes('dispatchEvent(new MouseEvent'));
    expect(clickCall).toBeDefined();
    expect(clickCall).toMatch(/bubbles:true/);
    expect(clickCall).toMatch(/cancelable:true/);
  });

  it('returns trigger_not_found when evaluate reports no element match', async () => {
    const browser = makeModalBrowser({ triggerFound: false });
    const result = await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('trigger_not_found');
  });

  it('returns field_not_found when no field candidate matches in DOM', async () => {
    const browser = makeModalBrowser({ fieldFound: false });
    const result = await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('field_not_found');
  });

  it('returns submit_not_found when no submit text matches', async () => {
    const browser = makeModalBrowser({ submitFound: false });
    const result = await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('submit_not_found');
  });

  it('clicks submit via :has-text() submit selector when configured', async () => {
    const plan: DescribeAuthResult = {
      ...HAS_TEXT_PLAN,
      uiSubmitSelector: 'button:has-text("Submit")',
    };
    const browser = makeModalBrowser();
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    expect(browser.click).not.toHaveBeenCalled();
    // Submit evaluate call should include the text "Submit"
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    // The submit selector 'button:has-text("Submit")' routes through tryClickByText,
    // which lowercases the text and JSON.stringifies it into the evaluate script.
    const submitCall = calls.find(s => s.includes('"submit"') && s.includes('dispatchEvent'));
    expect(submitCall).toBeDefined();
  });

  it('clicks submit via SUBMIT_LABELS fallback when no uiSubmitSelector', async () => {
    // HAS_TEXT_PLAN has no uiSubmitSelector, so the fallback fires
    const browser = makeModalBrowser();
    const result = await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('preserves cookie verification path (verifySuccess unchanged)', async () => {
    const browser = makeModalBrowser({ cookiesAvailable: true });
    const result = await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookies.length).toBeGreaterThan(0);
    expect(result.cookies[0]?.name).toBe('session');
  });
});
