// Browser-side login for the discover phase (BugHunter v0.3).
// Drives the in-browser login form via camofox MCP tools and verifies success
// using the cookie jar (including HttpOnly) or URL-change detection.

import type { BrowserMcpAdapter, CookieEntry } from '../adapters/browser-mcp.js';
import type { DescribeAuthResult, SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { StructuredSelector } from '../adapters/browser-mcp-snapshot.js';
import { log } from '../log.js';

export type LoginResult =
  | { ok: true; cookies: CookieEntry[]; finalUrl: string }
  | { ok: false; reason: LoginFailureReason; detail: string };

export type LoginFailureReason =
  | 'auth_not_browseable'
  | 'role_has_no_credentials'
  | 'login_page_load_failed'
  | 'trigger_not_found'
  | 'field_not_found'
  | 'submit_not_found'
  | 'submit_failed'
  | 'verification_failed'
  | 'captcha_detected'
  | 'two_factor_detected'
  | 'unknown_error';

export type LoginConfig = {
  role: string;
  baseUrl: string;
  verifyTimeoutMs: number;
  verifyPollMs: number;
};

type BrowseableAuthPlan = Extract<DescribeAuthResult, { authKind: 'form' | 'nextauth' }>;

// Selector candidates for a field, tried in priority order.
function fieldCandidates(credKey: string, domName: string): string[] {
  const pwKey = credKey === 'password' || domName.toLowerCase().includes('password');
  const emailKey = !pwKey && (credKey.includes('email') || domName.toLowerCase().includes('email'));
  return [
    `input[name="${domName}"]`,
    `input[id="${domName}"]`,
    `input[name="${credKey}"]`,
    `input[id="${credKey}"]`,
    `input[id="auth-${domName}"]`,
    `input[id="auth-${credKey}"]`,
    ...(pwKey ? [`input[type="password"]`] : emailKey ? [`input[type="email"]`] : []),
    `input[placeholder*="${credKey}" i]`,
  ];
}

const SUBMIT_LABELS = ['Sign in', 'Log in', 'Login', 'Continue', 'Submit'];

async function tryClick(browser: BrowserMcpAdapter, selector: string | StructuredSelector): Promise<boolean> {
  try {
    await browser.click(selector);
    return true;
  } catch {
    return false;
  }
}

async function tryType(browser: BrowserMcpAdapter, selector: string, text: string): Promise<boolean> {
  try {
    await browser.type(selector, text);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCookieNames(browser: BrowserMcpAdapter, baseUrl: string): Promise<string[]> {
  try {
    const result = await browser.cookies([baseUrl]);
    return result.cookies.map(c => c.name);
  } catch {
    try {
      const evalResult = await browser.evaluate('document.cookie');
      const raw = String(evalResult.value ?? '');
      return raw.split(';').map(s => s.trim().split('=')[0]?.trim() ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function getCookies(browser: BrowserMcpAdapter, baseUrl: string): Promise<CookieEntry[]> {
  try {
    const result = await browser.cookies([baseUrl]);
    return result.cookies;
  } catch {
    return [];
  }
}

async function getCurrentUrl(browser: BrowserMcpAdapter): Promise<string> {
  try {
    const evalResult = await browser.evaluate('location.href');
    return String(evalResult.value ?? '');
  } catch {
    return '';
  }
}

/**
 * Find a submit button selector by evaluating the DOM.
 * Returns a string selector or a StructuredSelector, or null if nothing found.
 */
async function findSubmitSelector(
  browser: BrowserMcpAdapter,
  uiSubmitSelector: string | undefined
): Promise<string | StructuredSelector | null> {
  if (uiSubmitSelector) return uiSubmitSelector;

  // Try button[type="submit"] via evaluate
  try {
    const result = await browser.evaluate(
      `!!document.querySelector('button[type="submit"]')`
    );
    if (result.value === true) return 'button[type="submit"]';
  } catch { /* ignore */ }

  // Try common submit label text
  for (const label of SUBMIT_LABELS) {
    try {
      const result = await browser.evaluate(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent&&b.textContent.trim().toLowerCase().includes(${JSON.stringify(label.toLowerCase())}))`
      );
      if (result.value === true) return { role: 'button', name: label };
    } catch { /* ignore */ }
  }

  return null;
}

async function verifySuccess(
  browser: BrowserMcpAdapter,
  plan: BrowseableAuthPlan,
  baseUrl: string,
  loginUrl: string,
  verifyTimeoutMs: number,
  verifyPollMs: number
): Promise<LoginResult> {
  const deadline = Date.now() + verifyTimeoutMs;

  while (Date.now() < deadline) {
    const currentUrl = await getCurrentUrl(browser);

    if (plan.successCheck.kind === 'cookie') {
      const cookieNames = await getCookieNames(browser, baseUrl);
      if (cookieNames.includes(plan.successCheck.name)) {
        const cookies = await getCookies(browser, baseUrl);
        return { ok: true, cookies, finalUrl: currentUrl };
      }
    } else if (plan.successCheck.kind === 'redirect') {
      if (currentUrl.includes(plan.successCheck.to)) {
        const cookies = await getCookies(browser, baseUrl);
        return { ok: true, cookies, finalUrl: currentUrl };
      }
    } else {
      // status-based: URL changed + no error alert
      if (currentUrl && currentUrl !== loginUrl) {
        try {
          const alertResult = await browser.evaluate(
            `document.querySelector('[role="alert"]')?.textContent??''`
          );
          const alertText = String(alertResult.value ?? '').toLowerCase();
          if (!/invalid|incorrect|wrong|fail/i.test(alertText)) {
            const cookies = await getCookies(browser, baseUrl);
            return { ok: true, cookies, finalUrl: currentUrl };
          }
        } catch {
          const cookies = await getCookies(browser, baseUrl);
          return { ok: true, cookies, finalUrl: currentUrl };
        }
      }
    }

    await sleep(verifyPollMs);
  }

  const cookieNames = await getCookieNames(browser, baseUrl);
  const lastUrl = await getCurrentUrl(browser);
  return {
    ok: false,
    reason: 'verification_failed',
    detail: `successCheck=${JSON.stringify(plan.successCheck)} not satisfied within ${verifyTimeoutMs}ms; lastUrl=${lastUrl}; cookieNames=${cookieNames.join(',')}`,
  };
}

export async function loginInBrowser(
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  config: LoginConfig
): Promise<LoginResult> {
  const { role, baseUrl, verifyTimeoutMs, verifyPollMs } = config;

  // Step 1: Describe auth
  let plan: DescribeAuthResult;
  try {
    plan = await surface.surface_describe_auth({ role });
  } catch (err) {
    const msg = String(err);
    log.warn(`browser_login: surface_describe_auth failed: ${msg}`);
    return { ok: false, reason: 'unknown_error', detail: `surface_describe_auth not available; SurfaceMCP needs upgrade to >=v0.3` };
  }

  if (plan.authKind === 'none') {
    return { ok: false, reason: 'auth_not_browseable', detail: 'auth.kind === none' };
  }
  if (plan.authKind === 'bearer' || plan.authKind === 'api_key') {
    return { ok: false, reason: 'auth_not_browseable', detail: plan.detail };
  }
  if (plan.authKind === 'anonymous') {
    return { ok: false, reason: 'role_has_no_credentials', detail: plan.reason };
  }

  const browseablePlan = plan as BrowseableAuthPlan;
  const loginUrl = new URL(browseablePlan.uiLoginPath, baseUrl).toString();

  // Step 2: Navigate
  try {
    await browser.navigate(loginUrl);
  } catch (err) {
    return { ok: false, reason: 'login_page_load_failed', detail: String(err) };
  }

  // Fast path: already logged in
  if (browseablePlan.successCheck.kind === 'cookie') {
    const cookieNames = await getCookieNames(browser, baseUrl);
    if (cookieNames.includes(browseablePlan.successCheck.name)) {
      const cookies = await getCookies(browser, baseUrl);
      const finalUrl = await getCurrentUrl(browser);
      log.info(`browser_login: fast-path success — session cookie already set (role=${role})`);
      return { ok: true, cookies, finalUrl };
    }
  }

  await sleep(250);

  // Step 3: Detect captcha / 2FA
  try {
    const captchaResult = await browser.evaluate(
      `(function(){` +
      `const c=!!document.querySelector('iframe[src*="captcha"],[class*="captcha"],[id*="captcha"],[aria-label*="captcha" i]');` +
      `const f=!!document.querySelector('input[name*="otp" i],input[name*="totp" i],input[autocomplete="one-time-code"]');` +
      `return{captcha:c,twoFa:f};` +
      `})()`
    );
    const val = captchaResult.value as { captcha?: boolean; twoFa?: boolean } | null;
    if (val?.captcha) return { ok: false, reason: 'captcha_detected', detail: 'captcha element detected on login page' };
    if (val?.twoFa) return { ok: false, reason: 'two_factor_detected', detail: '2FA input detected on login page' };
  } catch { /* ignore detect errors */ }

  // Step 4: Click trigger if configured
  if (browseablePlan.uiTriggerSelector) {
    const clicked = await tryClick(browser, browseablePlan.uiTriggerSelector);
    if (!clicked) {
      return { ok: false, reason: 'trigger_not_found', detail: browseablePlan.uiTriggerSelector };
    }
    await sleep(250);
  }

  // Steps 5 & 6: Locate and type into each field
  for (const [credKey, domName] of Object.entries(browseablePlan.fields)) {
    const value = browseablePlan.values[domName] ?? '';
    let typed = false;
    for (const selector of fieldCandidates(credKey, domName)) {
      if (await tryType(browser, selector, value)) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      return {
        ok: false,
        reason: 'field_not_found',
        detail: `No input matched any candidate selector for credential key "${credKey}" (domName "${domName}")`,
      };
    }
  }

  // Step 7: Find submit button
  const submitSelector = await findSubmitSelector(browser, browseablePlan.uiSubmitSelector);
  if (submitSelector === null) {
    return {
      ok: false,
      reason: 'submit_not_found',
      detail: 'Tried: uiSubmitSelector, button[type=submit], label text (Sign in/Log in/Login/Continue/Submit)',
    };
  }

  // Step 8: Click submit
  try {
    await browser.click(submitSelector);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('element_not_found') || errMsg.includes('not found')) {
      return { ok: false, reason: 'submit_not_found', detail: errMsg };
    }
    return { ok: false, reason: 'submit_failed', detail: errMsg };
  }

  // Step 9: Wait for success
  return verifySuccess(browser, browseablePlan, baseUrl, loginUrl, verifyTimeoutMs, verifyPollMs);
}
