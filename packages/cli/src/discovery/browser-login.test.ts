// Unit tests for loginInBrowser — mocked adapters only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loginInBrowser } from './browser-login.js';
import type { BrowserMcpAdapter, CookieEntry } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter, DescribeAuthResult } from '../adapters/surface-mcp.js';

const BASE_URL = 'http://localhost:3002';
const ROLE = 'owner';
const DEFAULT_OPTS = { role: ROLE, baseUrl: BASE_URL, verifyTimeoutMs: 100, verifyPollMs: 10 };

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

function makeBrowser(opts: {
  navigateThrows?: boolean;
  captchaDetected?: boolean;
  twoFaDetected?: boolean;
  triggerClickFails?: boolean;
  fieldTypeFails?: boolean;
  submitNotFound?: boolean;
  submitClickThrows?: boolean;
  cookieAfterSubmit?: boolean;
  urlAfterSubmit?: string;
  cookiesAvailable?: boolean;
  preexistingCookies?: CookieEntry[];
} = {}): BrowserMcpAdapter {
  let navigated = false;
  let submitClicked = false;
  let triggerClicked = false;

  return {
    navigate: vi.fn(async (_url: string) => {
      if (opts.navigateThrows) throw new Error('navigation_failed: 404');
      navigated = true;
      return { url: _url };
    }),
    click: vi.fn(async (selector: unknown) => {
      const sel = typeof selector === 'string' ? selector : JSON.stringify(selector);
      if (opts.triggerClickFails && sel.includes('trigger')) throw new Error('element_not_found');
      if (opts.submitClickThrows) throw new Error('submit_failed: network error');
      if (sel.includes('trigger')) triggerClicked = true;
      else submitClicked = true;
      return { clicked: true };
    }),
    type: vi.fn(async (_selector: unknown, _text: string) => {
      if (opts.fieldTypeFails) throw new Error('element_not_found');
      return { typed: true };
    }),
    scroll: vi.fn(async () => ({ scrolled: true })),
    snapshot: vi.fn(async () => ({ snapshot: '' })),
    screenshot: vi.fn(async () => ({ path: '' })),
    evaluate: vi.fn(async (script: string) => {
      if (script.includes('captcha')) {
        return { value: { captcha: !!opts.captchaDetected, twoFa: !!opts.twoFaDetected } };
      }
      if (script.includes('button[type=\\"submit\\"]') || script.includes("button[type=\"submit\"]") || script.includes("button[type='submit']") || script.includes('querySelector')) {
        if (opts.submitNotFound) return { value: false };
        return { value: true };
      }
      if (script.includes('location.href')) {
        if (opts.urlAfterSubmit && submitClicked) return { value: opts.urlAfterSubmit };
        return { value: 'http://localhost:3002/' };
      }
      if (script.includes('Array.from')) {
        if (opts.submitNotFound) return { value: false };
        return { value: true };
      }
      return { value: null };
    }),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    closeTab: vi.fn(async () => ({ closed: true })),
    openTab: vi.fn(async () => ({ tabId: 'tab1', finalUrl: '' })),
    closeTabExplicit: vi.fn(async () => {}),
    withTab: vi.fn(),
    cookies: vi.fn(async (_urls?: string[]) => {
      if (!opts.cookiesAvailable) throw new Error('cookies tool unavailable');
      const cookies = opts.preexistingCookies ??
        (opts.cookieAfterSubmit && submitClicked ? [SESSION_COOKIE] : []);
      return { tabId: 'tab1', cookies };
    }),
  } as unknown as BrowserMcpAdapter;
}

const FORM_PLAN: DescribeAuthResult = {
  authKind: 'form',
  uiLoginPath: '/login',
  fields: { email: 'email', password: 'password' },
  values: { email: 'user@test.com', password: 'secret' },
  successCheck: { kind: 'cookie', name: 'session' },
  cookieName: 'session',
};

describe('loginInBrowser — auth kind gates', () => {
  it('auth=none → auth_not_browseable', async () => {
    const result = await loginInBrowser(
      makeBrowser(),
      makeSurface({ authKind: 'none', reason: 'no_auth_configured' }),
      DEFAULT_OPTS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('auth_not_browseable');
  });

  it('auth=bearer → auth_not_browseable', async () => {
    const result = await loginInBrowser(
      makeBrowser(),
      makeSurface({ authKind: 'bearer', reason: 'programmatic_only', detail: 'Bearer-token auth...' }),
      DEFAULT_OPTS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('auth_not_browseable');
  });

  it('auth=api_key → auth_not_browseable', async () => {
    const result = await loginInBrowser(
      makeBrowser(),
      makeSurface({ authKind: 'api_key', reason: 'programmatic_only', detail: 'API-key auth...' }),
      DEFAULT_OPTS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('auth_not_browseable');
  });

  it('anonymous role → role_has_no_credentials', async () => {
    const result = await loginInBrowser(
      makeBrowser(),
      makeSurface({ authKind: 'anonymous', reason: 'role_has_no_credentials' }),
      DEFAULT_OPTS
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('role_has_no_credentials');
  });
});

describe('loginInBrowser — form auth happy path', () => {
  it('trigger click + two fields + submit + cookie verify → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      uiTriggerSelector: 'button[data-trigger]',
    };
    const browser = makeBrowser({ cookiesAvailable: true, cookieAfterSubmit: true });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookies.length).toBeGreaterThan(0);
    expect(browser.navigate).toHaveBeenCalledWith('http://localhost:3002/login');
    expect(browser.click).toHaveBeenCalledWith('button[data-trigger]');
    expect(browser.type).toHaveBeenCalledTimes(2);
  });
});

describe('loginInBrowser — failure modes', () => {
  it('trigger missing → trigger_not_found', async () => {
    const plan: DescribeAuthResult = { ...FORM_PLAN, uiTriggerSelector: '#missing-trigger' };
    const browser = makeBrowser({ triggerClickFails: true });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('trigger_not_found');
  });

  it('field not found across all candidates → field_not_found', async () => {
    const browser = makeBrowser({ fieldTypeFails: true });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('field_not_found');
  });

  it('submit button not found → submit_not_found', async () => {
    const browser = makeBrowser({ submitNotFound: true });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('submit_not_found');
  });

  it('cookie successCheck never satisfied within timeout → verification_failed', async () => {
    // cookiesAvailable=false means cookies() throws, and no cookie name in document.cookie
    // also no URL change
    const browser = makeBrowser({ cookiesAvailable: false });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification_failed');
  });

  it('navigate throws → login_page_load_failed', async () => {
    const browser = makeBrowser({ navigateThrows: true });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('login_page_load_failed');
  });

  it('captcha detected → captcha_detected', async () => {
    const browser = makeBrowser({ captchaDetected: true });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('captcha_detected');
  });

  it('2FA detected → two_factor_detected', async () => {
    const browser = makeBrowser({ twoFaDetected: true });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('two_factor_detected');
  });
});

describe('loginInBrowser — fast path', () => {
  it('cookie already present at navigate time → ok:true without form interaction', async () => {
    const browser = makeBrowser({
      cookiesAvailable: true,
      preexistingCookies: [SESSION_COOKIE],
    });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(browser.type).not.toHaveBeenCalled();
    expect(browser.click).not.toHaveBeenCalled();
  });
});

describe('loginInBrowser — nextauth', () => {
  it('nextauth happy path with synthesized cookie successCheck', async () => {
    const plan: DescribeAuthResult = {
      authKind: 'nextauth',
      uiLoginPath: '/api/auth/signin',
      fields: { email: 'username', password: 'password' },
      values: { username: 'user@test.com', password: 'secret' },
      successCheck: { kind: 'cookie', name: 'authjs.session-token' },
      cookieName: 'authjs.session-token',
    };
    const browser = makeBrowser({
      cookiesAvailable: true,
      cookieAfterSubmit: true,
    });
    // Override cookies mock to return the authjs cookie
    vi.mocked(browser.cookies).mockResolvedValueOnce({ tabId: 'tab1', cookies: [] }) // fast path check
    vi.mocked(browser.cookies).mockResolvedValue({
      tabId: 'tab1',
      cookies: [{ ...SESSION_COOKIE, name: 'authjs.session-token' }],
    });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
  });
});

describe('loginInBrowser — URL-change verification', () => {
  it('status-based successCheck: URL changes after submit → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'status', code: 200 },
    };
    const browser = makeBrowser({
      cookiesAvailable: false,
      urlAfterSubmit: 'http://localhost:3002/dashboard',
    });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 200,
      verifyPollMs: 20,
    });
    expect(result.ok).toBe(true);
  });
});

describe('loginInBrowser — cookies tool unavailable', () => {
  it('gracefully falls back to document.cookie when cookies() throws', async () => {
    // cookies() throws (PR 1 not deployed) — but the cookie DOES appear via document.cookie
    const browser = makeBrowser({ cookiesAvailable: false });
    // We need evaluate to return the cookie name in document.cookie after submit
    let submitDone = false;
    vi.mocked(browser.click).mockImplementation(async (sel: unknown) => {
      const s = typeof sel === 'string' ? sel : '';
      if (!s.includes('trigger')) submitDone = true;
      return { clicked: true };
    });
    vi.mocked(browser.evaluate).mockImplementation(async (script: string) => {
      if (script.includes('captcha')) return { value: { captcha: false, twoFa: false } };
      if (script.includes('location.href')) return { value: 'http://localhost:3002/' };
      if (script.includes('document.cookie') && submitDone) return { value: 'session=tok123' };
      if (script.includes('document.cookie')) return { value: '' };
      // submit button exists
      return { value: true };
    });
    const result = await loginInBrowser(browser, makeSurface(FORM_PLAN), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 200,
      verifyPollMs: 20,
    });
    expect(result.ok).toBe(true);
  });
});

describe('loginInBrowser — describe_auth unavailable', () => {
  it('surface_describe_auth throws → unknown_error with upgrade hint', async () => {
    const surface = {
      ...makeSurface({ authKind: 'none', reason: 'no_auth_configured' }),
      surface_describe_auth: vi.fn(async () => { throw new Error('Tool not found: surface_describe_auth'); }),
    } as unknown as SurfaceMcpAdapter;
    const result = await loginInBrowser(makeBrowser(), surface, DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_error');
    expect(result.detail).toContain('v0.3');
  });
});
