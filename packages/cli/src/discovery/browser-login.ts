// Browser-side login for the discover phase (BugHunter v0.3).
// Drives the in-browser login form via camofox MCP tools and verifies success
// using the cookie jar (including HttpOnly) or URL-change detection.

import type { BrowserMcpAdapter, CookieEntry, TabScope } from '../adapters/browser-mcp.js';
import type { DescribeAuthResult, SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { StructuredSelector } from '../adapters/browser-mcp-snapshot.js';
import type { AuthConfig } from '../types.js';
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

/**
 * v0.40: exported alias for BrowseableAuthPlan. Used by multi-context-runner which
 * resolves the plan once per test (via surface_describe_auth) then passes it to
 * loginInTabScope for each parallel tab.
 */
export type BrowserLoginPlan = BrowseableAuthPlan;

/** V55.2: cookie-endpoint plan shape from DescribeAuthResult or synthesised from BugHunter config. */
export type CookieEndpointPlan = Extract<DescribeAuthResult, { authKind: 'cookie_endpoint' }>;

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
  // 3. aria-label fallback — modern forms commonly use <input aria-label="Password">
  // with no name/id. Try credKey first; also domName when it's not a CSS selector.
  candidates.push(`input[aria-label*="${credKey}" i]`);
  if (!looksLikeCssSelector(domName) && domName !== credKey) {
    candidates.push(`input[aria-label*="${domName}" i]`);
  }
  return candidates;
}

/**
 * Candidate label-text fragments to search for when no CSS selector matches.
 * Returned as lowercased substrings — labelText match is case-insensitive.
 */
export function labelTextCandidates(credKey: string, domName: string): string[] {
  const out = new Set<string>();
  out.add(credKey.toLowerCase());
  if (!looksLikeCssSelector(domName)) out.add(domName.toLowerCase());
  // Common humanized aliases
  if (credKey === 'email' || domName.toLowerCase().includes('email')) {
    out.add('email');
    out.add('email address');
    out.add('username');
  }
  if (credKey === 'password' || domName.toLowerCase().includes('password')) {
    out.add('password');
  }
  return Array.from(out).filter(s => s !== '');
}

/**
 * Type into the input associated with a `<label>` whose text contains
 * `labelText` (case-insensitive). Resolves the input via `label.htmlFor`
 * → `getElementById`, or falls back to a descendant `<input>/<textarea>/<select>`.
 * Uses the native value setter so React tracks the change. Returns true on
 * success, false if no matching label-input pair is found.
 */
async function tryTypeByLabelText(
  browser: BrowserMcpAdapter,
  labelText: string,
  value: string
): Promise<boolean> {
  const script = `(function(){
    var needle=${JSON.stringify(labelText.toLowerCase())};
    var labels=Array.from(document.querySelectorAll('label'));
    var match=labels.find(function(l){
      return (l.textContent||'').toLowerCase().includes(needle);
    });
    if(!match)return false;
    var input=null;
    if(match.htmlFor){input=document.getElementById(match.htmlFor);}
    if(!input){input=match.querySelector('input,textarea,select');}
    if(!input)return false;
    if(input.tagName==='SELECT'){
      input.value=${JSON.stringify(value)};
      input.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    }
    var proto=input instanceof HTMLTextAreaElement
      ?HTMLTextAreaElement.prototype
      :HTMLInputElement.prototype;
    var setter=Object.getOwnPropertyDescriptor(proto,'value').set;
    setter.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`;
  try {
    const result = await browser.evaluate(script);
    return result.value === true;
  } catch (err) {
    log.warn(`tryTypeByLabelText(${JSON.stringify(labelText)}) evaluate failed: ${String(err)}`);
    return false;
  }
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

function assertNever(x: never): never {
  throw new Error(`Unhandled successCheck kind: ${String((x as { kind: string }).kind)}`);
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
    const sc = plan.successCheck;

    if (sc.kind === 'cookie') {
      const cookieNames = await getCookieNames(browser, baseUrl);
      if (cookieNames.includes(sc.name)) {
        const cookies = await getCookies(browser, baseUrl);
        return { ok: true, cookies, finalUrl: currentUrl };
      }
    } else if (sc.kind === 'redirect') {
      if (currentUrl.includes(sc.to)) {
        const cookies = await getCookies(browser, baseUrl);
        return { ok: true, cookies, finalUrl: currentUrl };
      }
    } else if (sc.kind === 'status') {
      // URL changed + no error alert.
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
    } else if (sc.kind === 'localStorage') {
      try {
        const pathExpr = sc.tokenJsonPath !== undefined
          ? `try{var obj=JSON.parse(raw);var path=${JSON.stringify(sc.tokenJsonPath)}.split('.');var v=obj;for(var i=0;i<path.length;i++){if(v==null)return null;v=v[path[i]];}return typeof v==='string'?v:null;}catch(e){return null;}`
          : 'return raw;';
        const result = await browser.evaluate(
          `(function(){var raw=localStorage.getItem(${JSON.stringify(sc.key)});if(raw===null||raw==='')return null;${pathExpr}})()`
        );
        const token = String(result.value ?? '');
        const minLen = sc.minLength ?? 16;
        if (token.length >= minLen && token !== 'null' && token !== 'undefined') {
          log.info(`browser_login: localStorage token present`, { key: sc.key, tokenLength: token.length });
          const cookies = await getCookies(browser, baseUrl);
          return { ok: true, cookies, finalUrl: currentUrl };
        }
      } catch { /* keep polling */ }
    } else if (sc.kind === 'dom_signal') { // eslint-disable-line @typescript-eslint/no-unnecessary-condition
      try {
        const result = await browser.evaluate(
          `document.querySelector(${JSON.stringify(sc.selector)})!==null`
        );
        if (result.value === true) {
          const cookies = await getCookies(browser, baseUrl);
          return { ok: true, cookies, finalUrl: currentUrl };
        }
      } catch { /* keep polling */ }
    } else {
      assertNever(sc);
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
    // Final fallback: walk <label> elements for matching text → resolve to input.
    if (!typed) {
      for (const labelText of labelTextCandidates(credKey, domName)) {
        if (await tryTypeByLabelText(browser, labelText, value)) {
          typed = true;
          break;
        }
      }
    }
    if (!typed) {
      const tried = candidates.map(s => `"${s}"`).join(', ');
      const labelTried = labelTextCandidates(credKey, domName).map(s => `"${s}"`).join(', ');
      log.warn(`browser_login: field_not_found (credKey=${credKey}, domName=${domName}); css tried: [${tried}]; label-text tried: [${labelTried}]`);
      return {
        ok: false,
        reason: 'field_not_found',
        detail: `No input matched any candidate selector for credential key "${credKey}" (domName "${domName}"). CSS tried: [${tried}]. Label-text tried: [${labelTried}].`,
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
  const labelTexts = new Set<string>();
  for (const [credKey, domName] of Object.entries(plan.fields)) {
    candidateSelectors.push(...fieldCandidates(credKey, domName));
    for (const text of labelTextCandidates(credKey, domName)) labelTexts.add(text);
  }
  const selectorsJson = JSON.stringify(candidateSelectors);
  const labelsJson = JSON.stringify(Array.from(labelTexts));
  const deadline = Date.now() + LOGIN_FORM_READY_MAX_MS;
  while (Date.now() < deadline) {
    try {
      const res = await browser.evaluate(
        `(function(){
          var sels=${selectorsJson};
          for(var i=0;i<sels.length;i++){if(document.querySelector(sels[i]))return true;}
          var labels=Array.from(document.querySelectorAll('label'));
          var needles=${labelsJson};
          for(var j=0;j<labels.length;j++){
            var t=(labels[j].textContent||'').toLowerCase();
            for(var k=0;k<needles.length;k++){if(t.includes(needles[k]))return true;}
          }
          return false;
        })()`
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
    // Final fallback: walk <label> elements for matching text → resolve to input.
    if (!typed) {
      for (const labelText of labelTextCandidates(credKey, domName)) {
        if (await tryTypeByLabelText(browser, labelText, value)) {
          typed = true;
          break;
        }
      }
    }
    if (!typed) {
      const tried = candidates.map(s => `"${s}"`).join(', ');
      const labelTried = labelTextCandidates(credKey, domName).map(s => `"${s}"`).join(', ');
      log.warn(`browser_login: field_not_found (credKey=${credKey}, domName=${domName}); css tried: [${tried}]; label-text tried: [${labelTried}]`);
      return {
        ok: false,
        reason: 'field_not_found',
        detail: `No input matched any candidate selector for credential key "${credKey}" (domName "${domName}"). CSS tried: [${tried}]. Label-text tried: [${labelTried}].`,
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

/**
 * v0.40: Login in a specific browser TabScope using a pre-resolved BrowserLoginPlan.
 * Unlike loginInBrowser, the caller has already fetched the plan via surface_describe_auth.
 * This allows N tabs to log in concurrently with a single plan fetch.
 *
 * TabScope is structurally compatible with BrowserMcpAdapter for all operations
 * loginInBrowser performs (navigate, click, type, evaluate). Cookies are not returned
 * because TabScope does not expose a cookies() method; callers that need cookie
 * verification should use loginInBrowser instead.
 */
export async function loginInTabScope(
  scope: TabScope,
  _role: string,
  plan: BrowserLoginPlan,
  opts?: { verifyTimeoutMs?: number; verifyPollMs?: number },
): Promise<LoginResult> {
  const verifyTimeoutMs = opts?.verifyTimeoutMs ?? 10_000;
  const verifyPollMs = opts?.verifyPollMs ?? 500;

  const scopeAsBrowser: BrowserMcpAdapter = {
    ...scope,
    listTabs: async () => ({ tabs: [] }),
    closeTab: async () => ({ closed: false }),
    openTab: async () => ({ tabId: '', finalUrl: '' }),
    closeTabExplicit: async () => undefined,
    withTab: <T>(_u: string, _h: Record<string, string> | undefined, fn: (s: TabScope) => Promise<T>) => fn(scope),
    cookies: async () => ({ tabId: '', cookies: [] }),
  };
  const loginUrl = plan.uiLoginPath;

  try {
    await scope.navigate(loginUrl);
  } catch (err) {
    return { ok: false, reason: 'login_page_load_failed', detail: String(err) };
  }

  await waitForLoginFormReady(scopeAsBrowser, plan);

  try {
    const captchaResult = await scope.evaluate(
      `(function(){` +
      `const c=!!document.querySelector('iframe[src*="captcha"],[class*="captcha"],[id*="captcha"],[aria-label*="captcha" i]');` +
      `const f=!!document.querySelector('input[name*="otp" i],input[name*="totp" i],input[autocomplete="one-time-code"]');` +
      `return{captcha:c,twoFa:f};` +
      `})()`
    );
    const val = captchaResult.value as { captcha?: boolean; twoFa?: boolean } | null;
    if (val?.captcha === true) return { ok: false, reason: 'captcha_detected', detail: 'captcha element detected' };
    if (val?.twoFa === true) return { ok: false, reason: 'two_factor_detected', detail: '2FA input detected' };
  } catch { /* ignore detect errors */ }

  if (isHasTextSelector(plan.uiTriggerSelector)) {
    return loginViaModalEvaluate(
      scopeAsBrowser, plan, plan.uiTriggerSelector ?? '',
      loginUrl, loginUrl, verifyTimeoutMs, verifyPollMs,
    );
  }

  if (plan.uiTriggerSelector !== undefined) {
    const clicked = await tryClick(scopeAsBrowser, plan.uiTriggerSelector);
    if (!clicked) {
      return { ok: false, reason: 'trigger_not_found', detail: plan.uiTriggerSelector };
    }
    await sleep(250);
  }

  for (const [credKey, domName] of Object.entries(plan.fields)) {
    const value = plan.values[domName] ?? '';
    const candidates = fieldCandidates(credKey, domName);
    let typed = false;
    for (const selector of candidates) {
      if (await tryTypeByCssSelector(scopeAsBrowser, selector, value)) { typed = true; break; }
      if (await tryType(scopeAsBrowser, selector, value)) { typed = true; break; }
    }
    if (!typed) {
      for (const labelText of labelTextCandidates(credKey, domName)) {
        if (await tryTypeByLabelText(scopeAsBrowser, labelText, value)) { typed = true; break; }
      }
    }
    if (!typed) {
      return { ok: false, reason: 'field_not_found', detail: `credential key "${credKey}" (domName "${domName}")` };
    }
  }

  const submitSelector = await findSubmitSelector(scopeAsBrowser, plan.uiSubmitSelector);
  if (submitSelector === null) {
    return { ok: false, reason: 'submit_not_found', detail: 'submit button not found in tab scope' };
  }

  try {
    await scope.click(submitSelector);
  } catch (err) {
    const errMsg = String(err);
    return {
      ok: false,
      reason: errMsg.includes('not found') ? 'submit_not_found' : 'submit_failed',
      detail: errMsg,
    };
  }

  // Verify: poll for URL change (cookie check not available in TabScope)
  const deadline = Date.now() + verifyTimeoutMs;
  const initialUrl = await scope.evaluate('window.location.href').then(r => String(r.value ?? '')).catch(() => '');
  while (Date.now() < deadline) {
    const currentUrl = await scope.evaluate('window.location.href').then(r => String(r.value ?? '')).catch(() => '');
    if (currentUrl !== '' && currentUrl !== loginUrl && currentUrl !== initialUrl) {
      return { ok: true, cookies: [], finalUrl: currentUrl };
    }
    await sleep(verifyPollMs);
  }
  return {
    ok: false,
    reason: 'verification_failed',
    detail: `URL did not change from ${loginUrl} within ${verifyTimeoutMs}ms`,
  };
}

/**
 * V55.2: Cookie-endpoint login executor.
 * Issues a programmatic POST to the login API endpoint and verifies that the
 * expected session cookie is set on the browser context afterward.
 *
 * A 4xx from the server returns LoginResult.ok=false with reason='submit_failed'.
 * A 5xx returns reason='login_page_load_failed'.
 * A missing session cookie after a 2xx returns reason='verification_failed'.
 */
export async function loginViaCookieEndpoint(
  browser: BrowserMcpAdapter,
  plan: CookieEndpointPlan,
  auth: Extract<AuthConfig, { kind: 'cookie' }>,
  role: string,
  baseUrl: string,
): Promise<LoginResult> {
  const creds = auth.credentials[role];
  if (creds === undefined) {
    log.warn(`browser_login: cookie_endpoint: no credentials for role="${role}"`);
    return { ok: false, reason: 'role_has_no_credentials', detail: `No credentials for role "${role}"` };
  }

  const usernameField = plan.usernameField;
  const passwordField = plan.passwordField;
  const usernameValue = creds.email ?? creds.username ?? '';
  const passwordValue = creds.password ?? '';

  const bodyShape = plan.loginEndpoint.bodyShape;
  const body = bodyShape === 'json'
    ? JSON.stringify({ [usernameField]: usernameValue, [passwordField]: passwordValue })
    : new URLSearchParams({ [usernameField]: usernameValue, [passwordField]: passwordValue }).toString();
  const contentType = bodyShape === 'json'
    ? 'application/json'
    : 'application/x-www-form-urlencoded';

  const endpointUrl = plan.loginEndpoint.url.startsWith('http')
    ? plan.loginEndpoint.url
    : new URL(plan.loginEndpoint.url, baseUrl).toString();

  const script = `(async function(){
    var resp = await fetch(${JSON.stringify(endpointUrl)}, {
      method: 'POST',
      headers: { 'Content-Type': ${JSON.stringify(contentType)} },
      body: ${JSON.stringify(body)},
      credentials: 'include',
    });
    return { status: resp.status, ok: resp.ok };
  })()`;

  let status: number;
  let fetchOk: boolean;
  try {
    const result = await browser.evaluate(script);
    const val = result.value as { status?: number; ok?: boolean } | null;
    status = val?.status ?? 0;
    fetchOk = val?.ok ?? false;
  } catch (err) {
    return { ok: false, reason: 'login_page_load_failed', detail: `fetch to login endpoint failed: ${String(err)}` };
  }

  if (status >= 500) {
    return { ok: false, reason: 'login_page_load_failed', detail: `login endpoint returned ${status}` };
  }
  if (!fetchOk) {
    return { ok: false, reason: 'submit_failed', detail: `login endpoint returned ${status}` };
  }

  // Verify the session cookie was set
  const cookieNames = await getCookieNames(browser, baseUrl);
  if (!cookieNames.includes(plan.cookieName)) {
    log.warn(`browser_login: cookie_endpoint: expected cookie "${plan.cookieName}" not set after login; present=[${cookieNames.join(',')}]`);
    return {
      ok: false,
      reason: 'verification_failed',
      detail: `expected cookie "${plan.cookieName}" not set after POST to ${endpointUrl}`,
    };
  }

  const cookies = await getCookies(browser, baseUrl);
  log.info(`browser_login: cookie_endpoint success`, { role, cookieName: plan.cookieName, cookieCount: cookies.length });
  return { ok: true, cookies, finalUrl: baseUrl };
}

/**
 * V55.2: Synthesises a CookieEndpointPlan from BugHunter's own config.auth block
 * when SurfaceMCP returns authKind:'none' or doesn't support cookie_endpoint yet.
 */
export function cookieEndpointPlanFromConfig(
  auth: Extract<AuthConfig, { kind: 'cookie' }>,
): CookieEndpointPlan {
  return {
    authKind: 'cookie_endpoint',
    loginEndpoint: {
      method: 'POST',
      url: auth.loginEndpoint.url,
      bodyShape: auth.loginEndpoint.bodyShape,
    },
    usernameField: auth.loginEndpoint.usernameField,
    passwordField: auth.loginEndpoint.passwordField,
    cookieName: auth.cookieName,
    successCheck: { kind: 'cookie', name: auth.cookieName },
  };
}
