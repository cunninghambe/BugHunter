// Unit tests for loginInBrowser — mocked adapters only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loginInBrowser, fieldCandidates, looksLikeCssSelector, labelTextCandidates } from './browser-login.js';
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
      // waitForLoginFormReady poll — recognize and short-circuit so tests don't timeout.
      if (script.includes('for(var i=0;i<sels.length;i++)') || script.includes('for(const s of sels)')) {
        return { value: !opts.fieldTypeFails };
      }
      // tryTypeByLabelText script (label-text fallback) — fails when fieldTypeFails.
      if (script.includes("querySelectorAll('label')") && script.includes('htmlFor')) {
        return { value: false };
      }
      // tryTypeByCssSelector script (native value setter) — fails when fieldTypeFails.
      if (script.includes('getOwnPropertyDescriptor')) {
        return { value: !opts.fieldTypeFails };
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
    // Field fill prefers evaluate-based tryTypeByCssSelector; assert the native
    // value-setter script ran twice (one per field) regardless of whether the
    // snapshot-based browser.type was reached.
    const evalCalls = (browser.evaluate as unknown as { mock: { calls: [string][] } }).mock.calls;
    const setterCalls = evalCalls.filter(([s]) => s.includes('getOwnPropertyDescriptor'));
    expect(setterCalls.length).toBe(2);
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

// ---------------------------------------------------------------------------
// :has-text() evaluate-only modal flow tests
// ---------------------------------------------------------------------------

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
 * Build a browser mock tailored to the evaluate-only modal flow.
 * evaluate() is the only method expected to be called (besides navigate and cookies).
 * Tracks which evaluate scripts were called so tests can assert on script content.
 */
function makeModalBrowser(opts: {
  triggerFound?: boolean;
  fieldFound?: boolean;
  submitFound?: boolean;
  cookieAfterSubmit?: boolean;
  cookiesAvailable?: boolean;
} = {}): BrowserMcpAdapter {
  const triggerFound = opts.triggerFound ?? true;
  const fieldFound = opts.fieldFound ?? true;
  const submitFound = opts.submitFound ?? true;
  const cookiesAvailable = opts.cookiesAvailable ?? true;

  let submitDone = false;
  let triggerHandled = false;
  const evaluateCalls: string[] = [];

  const browser = {
    navigate: vi.fn(async (_url: string) => ({ url: _url })),
    // click and snapshot MUST NOT be called in the :has-text() path
    click: vi.fn(async () => { throw new Error('browser.click must not be called in evaluate-only path'); }),
    snapshot: vi.fn(async () => { throw new Error('browser.snapshot must not be called in evaluate-only path'); }),
    type: vi.fn(async () => ({ typed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    screenshot: vi.fn(async () => ({ path: '' })),
    evaluate: vi.fn(async (script: string) => {
      evaluateCalls.push(script);

      // captcha/2FA detection — none present
      if (script.includes('captcha')) {
        return { value: { captcha: false, twoFa: false } };
      }
      // waitForLoginFormReady poll — recognize and short-circuit so tests don't timeout.
      if (script.includes('for(var i=0;i<sels.length;i++)') || script.includes('for(const s of sels)')) {
        return { value: fieldFound };
      }
      // tryTypeByLabelText script (label-text fallback) — fail in modal tests so
      // CSS-selector path is the one exercised.
      if (script.includes("querySelectorAll('label')") && script.includes('htmlFor')) {
        return { value: false };
      }
      // tryClickByText script — first call (with the plan's :has-text trigger
      // text) is the trigger; subsequent calls are submit-button attempts.
      if (script.includes('dispatchEvent(new MouseEvent') && script.includes('querySelectorAll(')) {
        if (!triggerHandled) {
          triggerHandled = true;
          return { value: triggerFound };
        }
        // Submit attempts (SUBMIT_LABELS fallback or :has-text submit selector via tryClickByText).
        const found = submitFound;
        if (found) submitDone = true;
        return { value: found };
      }
      // tryClickByCssSelector (uiSubmitSelector as CSS, no querySelectorAll)
      if (script.includes('dispatchEvent(new MouseEvent')) {
        const found = submitFound;
        if (found) submitDone = true;
        return { value: found };
      }
      // Field typing (tryTypeByCssSelector) — uses getOwnPropertyDescriptor
      if (script.includes('getOwnPropertyDescriptor')) {
        return { value: fieldFound };
      }
      // Submit button via tryClickFirstMatchingButton / tryClickByText with SUBMIT_LABELS
      if (script.includes('querySelectorAll') && script.includes('dispatchEvent')) {
        const found = submitFound;
        if (found) submitDone = true;
        return { value: found };
      }
      // URL for verifySuccess
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
      // First call (fast-path check) → empty; subsequent → session cookie
      const calls = (browser.cookies as ReturnType<typeof vi.fn>).mock.calls.length;
      if (calls <= 1) return { tabId: 'tab1', cookies: [] };
      return {
        tabId: 'tab1',
        cookies: [SESSION_COOKIE],
      };
    }),
    _evaluateCalls: evaluateCalls,
  } as unknown as BrowserMcpAdapter & { _evaluateCalls: string[] };

  return browser;
}

describe('loginInBrowser — :has-text() modal flow', () => {
  it('clicks trigger via evaluate when uiTriggerSelector is :has-text()', async () => {
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    // evaluate must have been called (trigger, fields, submit, verify)
    expect(browser.evaluate).toHaveBeenCalled();
    // click must NOT have been called
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('does NOT call browser.snapshot at any point', async () => {
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(browser.snapshot).not.toHaveBeenCalled();
  });

  it('does NOT call browser.click for trigger or submit', async () => {
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('types into fields via evaluate (script contains native setter)', async () => {
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    const typingCall = calls.find(s => s.includes('getOwnPropertyDescriptor'));
    expect(typingCall).toBeDefined();
    expect(typingCall).toMatch(/getOwnPropertyDescriptor/);
    expect(typingCall).toMatch(/dispatchEvent\(new Event\('input'/);
    expect(typingCall).toMatch(/dispatchEvent\(new Event\('change'/);
  });

  it('trigger click script uses MouseEvent with bubbles:true', async () => {
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    await loginInBrowser(browser, makeSurface(HAS_TEXT_PLAN), DEFAULT_OPTS);
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    const clickCall = calls.find(s => s.includes('dispatchEvent(new MouseEvent'));
    expect(clickCall).toBeDefined();
    expect(clickCall).toMatch(/bubbles:true/);
    expect(clickCall).toMatch(/cancelable:true/);
  });

  it('returns trigger_not_found when evaluate reports no match', async () => {
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
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    // No browser.click calls
    expect(browser.click).not.toHaveBeenCalled();
    // Submit script should contain the text "Submit"
    const calls = vi.mocked(browser.evaluate).mock.calls.map(([s]) => s as string);
    // tryClickByText lowercases the text for matching — search the script for "submit" (lowered).
    const submitCall = calls.find(s => s.toLowerCase().includes('"submit"'));
    expect(submitCall).toBeDefined();
  });

  it('clicks submit via SUBMIT_LABELS fallback when no uiSubmitSelector', async () => {
    // HAS_TEXT_PLAN has no uiSubmitSelector — triggers fallback
    const browser = makeModalBrowser({ cookieAfterSubmit: true });
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

describe('looksLikeCssSelector', () => {
  it('detects #id form', () => {
    expect(looksLikeCssSelector('#login-password')).toBe(true);
  });
  it('detects .class form', () => {
    expect(looksLikeCssSelector('.password-input')).toBe(true);
  });
  it('detects [attr=val] form', () => {
    expect(looksLikeCssSelector('[data-testid="password"]')).toBe(true);
  });
  it('detects descendant combinator (space)', () => {
    expect(looksLikeCssSelector('form input.pw')).toBe(true);
  });
  it('detects child combinator (>)', () => {
    expect(looksLikeCssSelector('form > input')).toBe(true);
  });
  it('rejects bare attribute fragment', () => {
    expect(looksLikeCssSelector('password')).toBe(false);
  });
  it('rejects empty', () => {
    expect(looksLikeCssSelector('')).toBe(false);
  });
});

describe('fieldCandidates', () => {
  it('puts user-supplied #id selector at the front when domName looks like a CSS selector', () => {
    const candidates = fieldCandidates('password', '#login-password');
    expect(candidates[0]).toBe('#login-password');
    // Default fallbacks still present.
    expect(candidates).toContain('input[type="password"]');
  });

  it('puts user-supplied [attr=...] selector at the front', () => {
    const candidates = fieldCandidates('password', '[data-testid="login-password"]');
    expect(candidates[0]).toBe('[data-testid="login-password"]');
  });

  it('preserves attribute-fragment behavior when domName is a bare name', () => {
    const candidates = fieldCandidates('password', 'password');
    // First candidate is the name-attr expansion (no CSS-selector-passthrough).
    expect(candidates[0]).toBe('input[name="password"]');
    expect(candidates).not.toContain('password');
  });

  it('still emits input[type="password"] for password credKey', () => {
    expect(fieldCandidates('password', '#x')).toContain('input[type="password"]');
  });

  it('still emits input[type="email"] for email credKey', () => {
    expect(fieldCandidates('email', '#x')).toContain('input[type="email"]');
  });

  it('emits aria-label fallback for credKey', () => {
    expect(fieldCandidates('password', 'password')).toContain('input[aria-label*="password" i]');
  });

  it('emits aria-label fallback for distinct domName', () => {
    expect(fieldCandidates('password', 'user-pwd')).toContain('input[aria-label*="user-pwd" i]');
  });

  it('does not emit aria-label[domName] when domName is a CSS selector', () => {
    const candidates = fieldCandidates('password', '#x');
    expect(candidates).not.toContain('input[aria-label*="#x" i]');
  });
});

describe('labelTextCandidates', () => {
  it('includes credKey lowercased', () => {
    expect(labelTextCandidates('password', 'password')).toContain('password');
  });

  it('includes humanized email aliases', () => {
    const out = labelTextCandidates('email', 'email');
    expect(out).toContain('email');
    expect(out).toContain('email address');
    expect(out).toContain('username');
  });

  it('skips CSS-selector-shaped domName', () => {
    const out = labelTextCandidates('password', '#login-password');
    expect(out).not.toContain('#login-password');
  });

  it('keeps non-selector domName when distinct from credKey', () => {
    expect(labelTextCandidates('password', 'user-pwd')).toContain('user-pwd');
  });
});

// ─── v0.18 verifySuccess — localStorage + dom_signal ─────────────────────────

function makeVerifyBrowser(opts: {
  localStorageValue?: string | null;
  domSelectorPresent?: boolean;
  currentUrl?: string;
  /** Array of values to return on successive localStorage evaluate calls */
  localStorageSequence?: Array<string | null>;
  domSequence?: boolean[];
} = {}): BrowserMcpAdapter {
  let lsCallCount = 0;
  let domCallCount = 0;

  return {
    navigate: vi.fn(async (url: string) => ({ url })),
    click: vi.fn(async () => ({ clicked: true })),
    type: vi.fn(async () => ({ typed: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    snapshot: vi.fn(async () => ({ snapshot: '' })),
    screenshot: vi.fn(async () => ({ path: '' })),
    listTabs: vi.fn(async () => ({ tabs: [] })),
    closeTab: vi.fn(async () => ({ closed: true })),
    openTab: vi.fn(async () => ({ tabId: 'tab1', finalUrl: '' })),
    closeTabExplicit: vi.fn(async () => {}),
    withTab: vi.fn(),
    cookies: vi.fn(async () => ({ tabId: 'tab1', cookies: [] })),
    evaluate: vi.fn(async (script: string) => {
      if (script.includes('captcha')) return { value: { captcha: false, twoFa: false } };
      if (script.includes('for(var i=0;i<sels.length;i++)')) return { value: true };
      if (script.includes('getOwnPropertyDescriptor')) return { value: true };
      if (script.includes('location.href')) return { value: opts.currentUrl ?? 'http://localhost:3002/login' };
      if (script.includes('localStorage.getItem')) {
        if (opts.localStorageSequence) {
          const val = opts.localStorageSequence[lsCallCount] ?? null;
          lsCallCount++;
          return { value: val };
        }
        return { value: opts.localStorageValue ?? null };
      }
      if (script.includes('document.querySelector(') && script.includes('!==null')) {
        if (opts.domSequence) {
          const val = opts.domSequence[domCallCount] ?? false;
          domCallCount++;
          return { value: val };
        }
        return { value: opts.domSelectorPresent ?? false };
      }
      return { value: true };
    }),
  } as unknown as BrowserMcpAdapter;
}

describe('verifySuccess — localStorage kind', () => {
  it('token present at minLength threshold → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage' },
    };
    // Value is a 100-char JWT-like string
    const token = 'a'.repeat(100);
    const browser = makeVerifyBrowser({ localStorageValue: token, currentUrl: 'http://localhost:3002/dashboard' });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
  });

  it('token shorter than default minLength (16) → keeps polling → verification_failed', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage' },
    };
    const browser = makeVerifyBrowser({ localStorageValue: 'short', currentUrl: 'http://localhost:3002/login' });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification_failed');
  });

  it('value is "null" string → rejected → verification_failed', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage' },
    };
    const browser = makeVerifyBrowser({ localStorageValue: 'null', currentUrl: 'http://localhost:3002/login' });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification_failed');
  });

  it('tokenJsonPath resolves nested token → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token' },
    };
    // The evaluate script extracts state.token from the JSON; mock returns the extracted value
    const nestedToken = 'a'.repeat(200);
    const browser = makeVerifyBrowser({ localStorageValue: nestedToken, currentUrl: 'http://localhost:3002/dashboard' });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
  });

  it('tokenJsonPath missing intermediate key → null → keeps polling → verification_failed', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage', tokenJsonPath: 'state.token' },
    };
    // Mock returns null (path traversal failed or value isn't a string)
    const browser = makeVerifyBrowser({ localStorageValue: null, currentUrl: 'http://localhost:3002/login' });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification_failed');
  });

  it('token appears on 3rd poll → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'localStorage', key: 'auth-storage' },
    };
    const token = 'a'.repeat(100);
    const browser = makeVerifyBrowser({
      localStorageSequence: [null, null, token],
      currentUrl: 'http://localhost:3002/dashboard',
    });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 500,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifySuccess — dom_signal kind', () => {
  it('selector present immediately → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'dom_signal', selector: '[data-testid="user-menu"]' },
    };
    const browser = makeVerifyBrowser({ domSelectorPresent: true, currentUrl: 'http://localhost:3002/dashboard' });
    const result = await loginInBrowser(browser, makeSurface(plan), DEFAULT_OPTS);
    expect(result.ok).toBe(true);
  });

  it('selector absent → keeps polling → verification_failed', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'dom_signal', selector: '[data-testid="user-menu"]' },
    };
    const browser = makeVerifyBrowser({ domSelectorPresent: false, currentUrl: 'http://localhost:3002/login' });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 50,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('verification_failed');
  });

  it('selector absent for 4 polls then present → ok:true', async () => {
    const plan: DescribeAuthResult = {
      ...FORM_PLAN,
      successCheck: { kind: 'dom_signal', selector: '[data-testid="user-menu"]' },
    };
    const browser = makeVerifyBrowser({
      domSequence: [false, false, false, false, true],
      currentUrl: 'http://localhost:3002/dashboard',
    });
    const result = await loginInBrowser(browser, makeSurface(plan), {
      ...DEFAULT_OPTS,
      verifyTimeoutMs: 500,
      verifyPollMs: 10,
    });
    expect(result.ok).toBe(true);
  });
});
