// Phase 3.6: auth-flow detectors — session fixation, password reset token reuse,
// open redirect (v0.7 §4). Runs after execute + cross-user, before classify.
// Opt-in only: requires config.authFlow.enabled === true.

import { createId, makeSeededRng } from '../lib/ids.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { loginInBrowser } from '../discovery/browser-login.js';
import { checkOpenRedirect } from '../security/header-probe.js';
import { OPEN_REDIRECT_PARAM_NAMES } from '../security/header-rules.js';
import type { BugDetection, RunState, TestCase, AuthFlowContext } from '../types.js';
import { log } from '../log.js';

export type AuthFlowOptions = {
  runState: RunState;
  surface: SurfaceMcpAdapter;
  browser?: BrowserMcpAdapter;
  appBaseUrl: string;
  roles: string[];
  maxClusters: number;
  onClusterFound: (key: string) => number;
  /** v0.32: seed for deterministic temp passwords. When set, Math.random() is replaced. */
  seed?: number;
};

export type AuthFlowResult = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  abortReason?: 'budget' | 'max_clusters' | 'auth_unavailable' | 'no_login_role' | 'disabled';
};

export async function runAuthFlow(opts: AuthFlowOptions): Promise<AuthFlowResult> {
  const cfg = opts.runState.config.authFlow;
  if (cfg?.enabled !== true) {
    log.info('auth-flow: disabled (config.authFlow.enabled !== true)');
    return { detections: [], testCases: [], abortReason: 'disabled' };
  }

  const detections: Array<{ testId: string; detection: BugDetection }> = [];
  const testCases: TestCase[] = [];
  const checks = cfg.checks ?? ['session_fixation', 'password_reset_reuse', 'open_redirect'];

  if (checks.includes('session_fixation')) {
    await safeRunSubcheck('session_fixation', () => checkSessionFixation(opts), detections);
  }
  if (checks.includes('password_reset_reuse')) {
    await safeRunSubcheck('password_reset_reuse', () => checkPasswordResetReuse(opts), detections);
  }
  if (checks.includes('open_redirect')) {
    await safeRunSubcheckArray('open_redirect', () => checkOpenRedirectFlow(opts), detections);
  }

  log.info(`auth-flow: ${detections.length} detection(s)`);
  return { detections, testCases };
}

async function safeRunSubcheck(
  name: string,
  fn: () => Promise<{ testId: string; detection: BugDetection } | null>,
  detections: Array<{ testId: string; detection: BugDetection }>,
): Promise<void> {
  try {
    const result = await fn();
    if (result !== null) detections.push(result);
  } catch (err) {
    log.info(`auth-flow: ${name} threw unexpectedly`, { err: String(err) });
  }
}

async function safeRunSubcheckArray(
  name: string,
  fn: () => Promise<Array<{ testId: string; detection: BugDetection }>>,
  detections: Array<{ testId: string; detection: BugDetection }>,
): Promise<void> {
  try {
    const results = await fn();
    detections.push(...results);
  } catch (err) {
    log.info(`auth-flow: ${name} threw unexpectedly`, { err: String(err) });
  }
}

async function checkSessionFixation(
  opts: AuthFlowOptions,
): Promise<{ testId: string; detection: BugDetection } | null> {
  const { browser, surface, appBaseUrl, runState } = opts;
  if (browser === undefined) {
    log.info('session-fixation: skipped (no browser adapter)');
    return null;
  }

  const loginRole = runState.config.browserLogin?.role ?? runState.config.roles?.[0];
  if (loginRole === undefined || loginRole === '') {
    log.info('session-fixation: skipped (no login role configured)');
    return null;
  }

  const authMeta = await surface.surface_describe_auth({ role: loginRole });
  if (authMeta.authKind !== 'form' && authMeta.authKind !== 'nextauth') {
    log.info('session-fixation: skipped (auth kind not form-based)', { authKind: authMeta.authKind });
    return null;
  }

  const cookieName = authMeta.cookieName ?? findSessionCookieName(authMeta.successCheck);
  if (cookieName === undefined) {
    log.info('session-fixation: skipped (could not determine session cookie name)');
    return null;
  }

  const timeoutMs = runState.config.authFlow?.cookieCaptureTimeoutMs ?? 5000;
  const preCookie = await captureCookie(browser, appBaseUrl, authMeta.uiLoginPath, cookieName, timeoutMs);

  const loginResult = await loginInBrowser(browser, surface, {
    role: loginRole,
    baseUrl: appBaseUrl,
    verifyTimeoutMs: runState.config.browserLogin?.verifyTimeoutMs ?? 10_000,
    verifyPollMs: runState.config.browserLogin?.verifyPollMs ?? 500,
  });

  if (!loginResult.ok) {
    log.info('session-fixation: login failed; skipping', { reason: loginResult.reason });
    return null;
  }

  const postCookie = await captureCookie(browser, appBaseUrl, authMeta.uiLoginPath, cookieName, timeoutMs);

  if (preCookie !== null && postCookie !== null && preCookie === postCookie) {
    const authFlowContext: AuthFlowContext = {
      invariant: 'session_id_rotates',
      cookieName,
      preValuePrefix: preCookie.slice(0, 8),
      postValuePrefix: postCookie.slice(0, 8),
    };
    return {
      testId: createId(),
      detection: {
        kind: 'auth_session_fixation',
        rootCause: `Session cookie '${cookieName}' did not change after login`,
        endpoint: authMeta.uiLoginPath,
        authFlowContext,
      },
    };
  }

  return null;
}

async function checkPasswordResetReuse(
  opts: AuthFlowOptions,
): Promise<{ testId: string; detection: BugDetection } | null> {
  const { authFlow: cfg } = opts.runState.config;
  const reqId = cfg?.requestResetToolId;
  const consId = cfg?.consumeResetToolId;

  if (reqId === undefined || consId === undefined) {
    log.info('reset-reuse: skipped (toolIds missing)');
    return null;
  }

  // cfg is defined here because reqId and consId came from it; non-null assertion is safe
  const email = (cfg?.testEmail)
    ?? opts.runState.config.authProbe?.testAccountUsername
    ?? 'bughunter-probe-user@invalid.test';

  const r1 = await opts.surface.surface_call({ toolId: reqId, role: 'anonymous', input: { email }, noAutoRelogin: true });
  const r2 = await opts.surface.surface_call({ toolId: reqId, role: 'anonymous', input: { email }, noAutoRelogin: true });

  const t1 = extractResetToken(r1.body);
  const t2 = extractResetToken(r2.body);

  if (t1 === null || t2 === null) {
    log.info('reset-reuse: skipped (no token in response body — email-only delivery not supported in v0.7)');
    return null;
  }

  if (t1 === t2) {
    return {
      testId: createId(),
      detection: {
        kind: 'password_reset_token_reuse',
        rootCause: 'Reset endpoint returned identical token on two consecutive requests',
        endpoint: reqId,
        authFlowContext: { invariant: 'reset_token_single_use', reuseCount: 0 },
      },
    };
  }

  // v0.32: use seeded RNG when --seed is set (OQ-conservative: same seed → same passwords).
  const rng = opts.seed !== undefined ? makeSeededRng(opts.seed) : Math.random;
  const tempPw1 = `TempReset!${rng().toString(36).slice(2, 10)}`;
  const tempPw2 = `TempReset2!${rng().toString(36).slice(2, 10)}`;
  const c1 = await opts.surface.surface_call({ toolId: consId, role: 'anonymous', input: { token: t1, password: tempPw1 }, noAutoRelogin: true });
  const c2 = await opts.surface.surface_call({ toolId: consId, role: 'anonymous', input: { token: t1, password: tempPw2 }, noAutoRelogin: true });

  const c1Status = c1.status ?? 0;
  const c2Status = c2.status ?? 0;

  if (c1Status >= 200 && c1Status < 300 && c2Status >= 200 && c2Status < 300) {
    return {
      testId: createId(),
      detection: {
        kind: 'password_reset_token_reuse',
        rootCause: `Reset token redeemed twice (statuses ${c1Status}/${c2Status})`,
        endpoint: consId,
        authFlowContext: { invariant: 'reset_token_single_use', reuseCount: 2 },
      },
    };
  }

  return null;
}

async function checkOpenRedirectFlow(
  opts: AuthFlowOptions,
): Promise<Array<{ testId: string; detection: BugDetection }>> {
  const cfg = opts.runState.config.authFlow;
  const paramNames = cfg?.redirectParamNames ?? OPEN_REDIRECT_PARAM_NAMES;

  const candidateUrls: string[] = (cfg?.redirectRoutes ?? []).map(r =>
    r.startsWith('http') ? r : `${opts.appBaseUrl}${r}`
  );

  const discovered = opts.runState.discovery?.pages ?? [];
  for (const page of discovered) {
    const url = page.route.startsWith('http') ? page.route : `${opts.appBaseUrl}${page.route}`;
    try {
      const u = new URL(url);
      for (const param of paramNames) {
        if (u.searchParams.has(param)) {
          candidateUrls.push(url);
          break;
        }
      }
      if (/login|signin|signout|logout|callback|auth/i.test(u.pathname)) {
        candidateUrls.push(url);
      }
    } catch {
      // Skip unparseable URL
    }
  }

  const unique = [...new Set(candidateUrls)].slice(0, cfg?.maxRedirectProbes ?? 30);
  const out: Array<{ testId: string; detection: BugDetection }> = [];

  for (const url of unique) {
    try {
      const detections = await checkOpenRedirect(url, paramNames);
      for (const d of detections) {
        out.push({ testId: createId(), detection: d });
      }
    } catch (err) {
      log.info('open-redirect: probe failed', { url, err: String(err) });
    }
  }

  return out;
}

/** Read a named cookie from document.cookie via browser.evaluate. */
async function captureCookie(
  browser: BrowserMcpAdapter,
  baseUrl: string,
  loginPath: string,
  cookieName: string,
  timeoutMs: number,
): Promise<string | null> {
  const loginUrl = loginPath.startsWith('http') ? loginPath : `${baseUrl}${loginPath}`;
  try {
    const scope = await openTabAndGetScope(browser, loginUrl, timeoutMs);
    if (scope === null) return null;
    const result = await scope.evaluate(`document.cookie`);
    const cookieStr = typeof result.value === 'string' ? result.value : '';
    return parseCookieValue(cookieStr, cookieName);
  } catch (err) {
    log.info('session-fixation: cookie capture failed', { err: String(err), cookieName });
    return null;
  }
}

/** Navigate to a URL in a new tab and return a minimal scope for evaluate. */
async function openTabAndGetScope(
  browser: BrowserMcpAdapter,
  url: string,
  _timeoutMs: number,
): Promise<{ evaluate: (script: string) => Promise<{ value: unknown }> } | null> {
  try {
    let capturedScope: { evaluate: (script: string) => Promise<{ value: unknown }> } | null = null;
    await browser.withTab(url, {}, (scope) => {
      capturedScope = scope;
      return Promise.resolve();
    });
    return capturedScope;
  } catch {
    return null;
  }
}

function parseCookieValue(cookieStr: string, name: string): string | null {
  for (const part of cookieStr.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key.trim() === name) return rest.join('=').trim();
  }
  return null;
}

function findSessionCookieName(
  successCheck: { kind: string; name?: string },
): string | undefined {
  if (successCheck.kind === 'cookie' && typeof successCheck.name === 'string') {
    return successCheck.name;
  }
  return undefined;
}

export function extractResetToken(body: unknown): string | null {
  if (typeof body === 'string') {
    const m = body.match(/(?:reset[_-]?)?token["']?\s*[:=]\s*["']([a-zA-Z0-9_-]{8,256})["']/i);
    return m?.[1] ?? null;
  }
  if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['token', 'resetToken', 'reset_token', 'verificationToken']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length >= 8) return v;
    }
    const data = obj['data'];
    if (data !== null && typeof data === 'object') {
      return extractResetToken(data);
    }
  }
  return null;
}
