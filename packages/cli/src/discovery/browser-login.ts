// Browser-side login for the discover phase (BugHunter v0.3).
// Drives the in-browser login form via camofox MCP tools and verifies success
// using the cookie jar (including HttpOnly) or URL-change detection.

import type { BrowserMcpAdapter, CookieEntry } from '../adapters/browser-mcp.js';
import type { DescribeAuthResult, SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { StructuredSelector } from '../adapters/browser-mcp-snapshot.js';
import { parsePlaywrightHasText } from '../adapters/browser-mcp-snapshot.js';
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
// True when domName already looks like a CSS selector (#id, .class, [attr=...],
// or contains a combinator/space). Covers the case where a user puts the
// actual selector in `uiLoginFields` instead of a name/id fragment.
export function looksLikeCssSelector(domName: string): boolean {
  const trimmed = domName.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('.') || trimmed.startsWith('[')) return true;
  if (/[\s>+~]/.test(trimmed)) return true;
  return false;
}

export function fieldCandidates(credKey: string, domName: string): string[] {
  const pwKey = credKey === 'password' || domName.toLowerCase().includes('password');
  const emailKey = !pwKey && (credKey.includes('email') || domName.toLowerCase().includes('email'));
  const candidates: string[] = [];
  // 1. Honor a user-supplied CSS selector verbatim — highest priority.
  if (looksLikeCssSelector(domName)) {
    candidates.push(domName);
  }
  // 2. Default attribute-fragment expansion.
  candidates.push(
    `input[name="${domName}"]`,
    `input[id="${domName}"]`,
    `input[name="${credKey}"]`,
    `input[id="${credKey}"]`,
    `input[id="auth-${domName}"]`,
    `input[id="auth-${credKey}"]`,
  );
  if (pwKey) candidates.push(`input[type="password"]`);
  else if (emailKey) candidates.push(`input[type="email"]`);
  candidates.push(`input[placeholder*="${credKey}" i]`);
  return candidates;
}

const SUBMIT_LABELS = ['Sign in', 'Log in', 'Login', 'Continue', 'Submit'];

// Settle delays for the evaluate-only modal flow (see §7 of spec).
const MODAL_SETTLE_MS = 250;
const FIELD_SETTLE_MS = 50;
const SUBMIT_SETTLE_MS = 50;

// ---------------------------------------------------------------------------
// Evaluate-only helpers (used when uiTriggerSelector is a :has-text() form).
//
// IMPORTANT: These helpers MUST NOT call browser.snapshot(), browser.click(),
// or browser.type() with a string selector. Camofox's snapshot tool
// auto-dismisses overlay dialogs (clicking [aria-label="Close"]), which closes
// the auth modal before the form can be filled. All DOM interaction during the
// modal-open window must go through browser.evaluate() only.
// ---------------------------------------------------------------------------

/** Returns true if the selector is a Playwright :has-text() form. */
export function isHasTextSelector(selector: string | undefined): boolean {
  return selector !== undefined && parsePlaywrightHasText(selector) !== null;
}

/**
 * Click the first visible element matching `tag` whose text content includes
 * `text` (case-insensitive). Prefers an exact trim match; falls back to
 * substring. Dispatches a real MouseEvent so React's delegated listeners fire.
 * Returns true on success, false if no element matched.
 */
async function tryClickByText(
  browser: BrowserMcpAdapter,
  tag: string,
  text: string
): Promise<boolean> {
  const script = `(function(){
    var tag=${JSON.stringify(tag)};
    var text=${JSON.stringify(text.toLowerCase())};
    var els=Array.from(document.querySelectorAll(tag));
    function visible(el){
      var r=el.getBoundingClientRect();
      return el.offsetParent!==null||(r.width>0&&r.height>0);
    }
    var candidates=els.filter(visible);
    var target=candidates.find(function(el){
      return (el.textContent||'').trim().toLowerCase()===text;
    })||candidates.find(function(el){
      return (el.textContent||'').toLowerCase().includes(text);
    });
    if(!target)return false;
    target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));
    return true;
  })()`;
  try {
    const result = await browser.evaluate(script);
    return result.value === true;
  } catch (err) {
    log.warn(`tryClickByText(${tag}, ${JSON.stringify(text)}) evaluate failed: ${String(err)}`);
    return false;
  }
}

/**
 * Click the first visible element matching the given CSS selector via evaluate.
 * Uses MouseEvent dispatch (not el.click()) for React compatibility.
 */
async function tryClickByCssSelector(
  browser: BrowserMcpAdapter,
  cssSelector: string
): Promise<boolean> {
  const script = `(function(){
    var el=document.querySelector(${JSON.stringify(cssSelector)});
    if(!el)return false;
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));
    return true;
  })()`;
  try {
    const result = await browser.evaluate(script);
    return result.value === true;
  } catch (err) {
    log.warn(`tryClickByCssSelector(${JSON.stringify(cssSelector)}) evaluate failed: ${String(err)}`);
    return false;
  }
}

/**
 * Type into an input or textarea found by CSS selector. Uses the prototype's
 * native value setter so React's input tracking sees the change, then fires
 * synthetic input + change events. Returns true on success.
 */
async function tryTypeByCssSelector(
  browser: BrowserMcpAdapter,
  cssSelector: string,
  value: string
): Promise<boolean> {
  const script = `(function(){
    var el=document.querySelector(${JSON.stringify(cssSelector)});
    if(!el)return false;
    var proto=el instanceof HTMLTextAreaElement
      ?HTMLTextAreaElement.prototype
      :HTMLInputElement.prototype;
    var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
    setter.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`;
  try {
    const result = await browser.evaluate(script);
    return result.value === true;
  } catch (err) {
    log.warn(`tryTypeByCssSelector(${JSON.stringify(cssSelector)}) evaluate failed: ${String(err)}`);
    return false;
  }
}

/**
 * Try each candidate label in order, clicking the first matching visible button.
 * Used as submit fallback when no uiSubmitSelector is configured.
 */
async function tryClickFirstMatchingButton(
  browser: BrowserMcpAdapter,
  candidateTexts: string[]
): Promise<boolean> {
  for (const text of candidateTexts) {
    if (await tryClickByText(browser, 'button', text)) return true;
  }
  return false;
}

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
  return new Promise(resolve => { setTimeout(resolve, ms); });
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
  if (uiSubmitSelector !== undefined) return uiSubmitSelector;

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
      // status-based: URL changed + no error alert.
      // Empty currentUrl means page is in a transient/unready state — treat as "still on login".
      if (currentUrl !== '' && currentUrl !== loginUrl) {
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

/**
 * Evaluate-only form fill + submit for :has-text() trigger selectors.
 * Called from loginInBrowser when isHasTextSelector(plan.uiTriggerSelector) is true.
 * Never calls browser.snapshot(), browser.click(), or browser.type() — only
 * browser.evaluate() and browser.cookies() — so camofox's auto-dismiss does
 * not close the modal between trigger-click and submit.
 */
async function loginViaModalEvaluate(
  browser: BrowserMcpAdapter,
  plan: BrowseableAuthPlan,
  triggerSelector: string,
  baseUrl: string,
  loginUrl: string,
  verifyTimeoutMs: number,
  verifyPollMs: number
): Promise<LoginResult> {
  // Step 4: Click trigger via evaluate
  const parsed = parsePlaywrightHasText(triggerSelector);
  if (parsed === null) {
    return { ok: false, reason: 'trigger_not_found', detail: triggerSelector };
  }
  const triggerClicked = await tryClickByText(browser, parsed.tag, parsed.text);
  if (!triggerClicked) {
    return { ok: false, reason: 'trigger_not_found', detail: triggerSelector };
  }
  await sleep(MODAL_SETTLE_MS);

  // Steps 5 & 6: Fill each field via evaluate
  for (const [credKey, domName] of Object.entries(plan.fields)) {
    const value = plan.values[domName] ?? '';
    const candidates = fieldCandidates(credKey, domName);
    let typed = false;
    for (const selector of candidates) {
      if (await tryTypeByCssSelector(browser, selector, value)) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      const tried = candidates.map(s => `"${s}"`).join(', ');
      log.warn(`browser_login: field_not_found (credKey=${credKey}, domName=${domName}); tried: [${tried}]`);
      return {
        ok: false,
        reason: 'field_not_found',
        detail: `No input matched any candidate selector for credential key "${credKey}" (domName "${domName}"). Tried: [${tried}]`,
      };
    }
    await sleep(FIELD_SETTLE_MS);
  }

  await sleep(SUBMIT_SETTLE_MS);

  // Step 7 & 8: Click submit via evaluate
  const submitOk = await clickSubmitEvaluate(browser, plan.uiSubmitSelector);
  if (!submitOk) {
    return {
      ok: false,
      reason: 'submit_not_found',
      detail: 'Tried: uiSubmitSelector, SUBMIT_LABELS fallback',
    };
  }

  // Step 9: Wait for success (evaluate-based; does not call snapshot)
  return verifySuccess(browser, plan, baseUrl, loginUrl, verifyTimeoutMs, verifyPollMs);
}

async function clickSubmitEvaluate(
  browser: BrowserMcpAdapter,
  uiSubmitSelector: string | undefined
): Promise<boolean> {
  if (uiSubmitSelector === undefined || uiSubmitSelector === '') {
    return tryClickFirstMatchingButton(browser, SUBMIT_LABELS);
  }
  const hasText = parsePlaywrightHasText(uiSubmitSelector);
  if (hasText !== null) {
    return tryClickByText(browser, hasText.tag, hasText.text);
  }
  // Plain CSS selector
  return tryClickByCssSelector(browser, uiSubmitSelector);
}

const LOGIN_FORM_READY_MAX_MS = 2500;
const LOGIN_FORM_READY_POLL_MS = 100;

async function waitForLoginFormReady(
  browser: BrowserMcpAdapter,
  plan: BrowseableAuthPlan
): Promise<void> {
  const candidateSelectors: string[] = [];
  for (const [credKey, domName] of Object.entries(plan.fields)) {
    candidateSelectors.push(...fieldCandidates(credKey, domName));
  }
  const selectorsJson = JSON.stringify(candidateSelectors);
  const deadline = Date.now() + LOGIN_FORM_READY_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const res = await browser.evaluate(
        `(function(){const sels=${selectorsJson};for(const s of sels){if(document.querySelector(s))return true;}return false;})()`
      );
      if (res.value === true) return;
    } catch {
      // ignore — keep polling
    }
    await sleep(LOGIN_FORM_READY_POLL_MS);
  }
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

  // Poll for the first field selector to appear (max 5000ms) — covers
  // SPA cold-start hydration that exceeds a fixed 250ms wait.
  await waitForLoginFormReady(browser, browseablePlan);

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
    if (val?.captcha === true) return { ok: false, reason: 'captcha_detected', detail: 'captcha element detected on login page' };
    if (val?.twoFa === true) return { ok: false, reason: 'two_factor_detected', detail: '2FA input detected on login page' };
  } catch { /* ignore detect errors */ }

  // Steps 4–8: Fill and submit the login form.
  //
  // When uiTriggerSelector is a Playwright :has-text() form, we use a fully
  // evaluate-only path that never calls browser.snapshot(), browser.click(), or
  // browser.type() with a string selector. Camofox's snapshot tool
  // auto-dismisses overlay dialogs by clicking [aria-label="Close"], which
  // would close the auth modal between trigger-click and form-fill. The only
  // safe operations between modal-open and submit-verify are browser.evaluate()
  // and browser.cookies().
  if (isHasTextSelector(browseablePlan.uiTriggerSelector)) {
    return loginViaModalEvaluate(
      browser, browseablePlan, browseablePlan.uiTriggerSelector ?? '',
      baseUrl, loginUrl, verifyTimeoutMs, verifyPollMs
    );
  }

  // Step 4: Click trigger if configured (snapshot-driven path)
  if (browseablePlan.uiTriggerSelector !== undefined) {
    const clicked = await tryClick(browser, browseablePlan.uiTriggerSelector);
    if (!clicked) {
      return { ok: false, reason: 'trigger_not_found', detail: browseablePlan.uiTriggerSelector };
    }
    await sleep(250);
  }

  // Steps 5 & 6: Locate and type into each field. Prefer evaluate-based type
  // (raw document.querySelector + native value setter) because camofox's
  // snapshot-based type rejects inputs without accessible names.
  for (const [credKey, domName] of Object.entries(browseablePlan.fields)) {
    const value = browseablePlan.values[domName] ?? '';
    const candidates = fieldCandidates(credKey, domName);
    let typed = false;
    for (const selector of candidates) {
      if (await tryTypeByCssSelector(browser, selector, value)) {
        typed = true;
        break;
      }
      if (await tryType(browser, selector, value)) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      const tried = candidates.map(s => `"${s}"`).join(', ');
      log.warn(`browser_login: field_not_found (credKey=${credKey}, domName=${domName}); tried: [${tried}]`);
      return {
        ok: false,
        reason: 'field_not_found',
        detail: `No input matched any candidate selector for credential key "${credKey}" (domName "${domName}"). Tried: [${tried}]`,
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
