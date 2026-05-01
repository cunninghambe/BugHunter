// V25: CSRF detector — emits csrf_missing_on_mutating_route from HAR observations.

import type { BugDetection } from '../types.js';
import type { CsrfObservation } from '../adapters/har-writer.js';
import { CSRF_COOKIE_NAME_PATTERNS, isSessionCookie, parseSetCookie } from './header-rules.js';
import { normalizePath } from '../classify/network.js';
import { log } from '../log.js';

export type CsrfDetectorOptions = {
  /**
   * Cookie name patterns indicating a CSRF token cookie.
   * Default: CSRF_COOKIE_NAME_PATTERNS from header-rules.ts.
   * Pass an empty array ([]) to skip the whole detector.
   */
  cookieNamePatterns?: string[];
  /**
   * Header names that indicate an explicit CSRF token (lowercase).
   * Default: ['x-csrf-token', 'x-xsrf-token', 'csrf-token', 'xsrf-token'].
   */
  tokenHeaderNames?: string[];
};

const DEFAULT_TOKEN_HEADER_NAMES = ['x-csrf-token', 'x-xsrf-token', 'csrf-token', 'xsrf-token'];

/**
 * Detect mutating requests that lack any CSRF token (cookie or header).
 *
 * Skips:
 * - cookieNamePatterns === [] (explicit opt-out, logged once)
 * - requests with Bearer auth (JWT — not CSRF-vulnerable from cross-origin JS)
 * - requests where all session-shaped Set-Cookie values have SameSite=Strict
 */
export function detectMissingCsrf(
  observations: CsrfObservation[],
  options: CsrfDetectorOptions = {},
): BugDetection[] {
  const cookieNamePatterns = options.cookieNamePatterns ?? CSRF_COOKIE_NAME_PATTERNS;
  const tokenHeaderNames = options.tokenHeaderNames ?? DEFAULT_TOKEN_HEADER_NAMES;

  // EC-CSRF-7: explicit empty array is a whole-detector skip
  if (Array.isArray(options.cookieNamePatterns) && options.cookieNamePatterns.length === 0) {
    log.info('csrf-detector: skipped', { reason: 'cookieNamePatterns: []' });
    return [];
  }

  const bugs: BugDetection[] = [];

  for (const obs of observations) {
    // EC-CSRF-3: Bearer token auth is not CSRF-vulnerable from cross-origin JS
    const authHeader = obs.requestHeaders['authorization'] ?? '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      log.info('csrf-detector: skipped', { reason: 'bearer_auth', url: obs.url });
      continue;
    }

    // EC-CSRF-2: SameSite=Strict on all session-shaped cookies is its own CSRF defense
    if (allSessionCookiesAreStrict(obs.responseSetCookieHeaders)) {
      log.info('csrf-detector: skipped', { reason: 'samesite_strict_all_session_cookies', url: obs.url });
      continue;
    }

    const hasCsrfCookie = obs.cookieJar.some(cookieEntry => {
      const name = cookieEntry.split('=')[0] ?? '';
      const nameLower = name.toLowerCase();
      return cookieNamePatterns.some(p => nameLower.includes(p.toLowerCase()));
    });

    const hasCsrfHeader = tokenHeaderNames.some(name => name in obs.requestHeaders);

    if (!hasCsrfCookie && !hasCsrfHeader) {
      const normalizedPath = normalizeRequestPath(obs.url, obs.method);
      bugs.push({
        kind: 'csrf_missing_on_mutating_route',
        rootCause: `Mutating ${obs.method} ${normalizedPath} accepted without CSRF token (no matching cookie or header)`,
        endpoint: `${obs.method} ${normalizedPath}`,
        headerContext: {
          headerName: 'X-CSRF-Token',
          expectedShape: 'present_or_cookie_match',
          observedValue: '',
        },
      });
    }
  }

  return bugs;
}

/**
 * Returns true when every session-shaped cookie in the Set-Cookie list has SameSite=Strict.
 * If there are no session-shaped cookies at all, returns false (no CSRF defense present).
 */
function allSessionCookiesAreStrict(setCookieHeaders: string[]): boolean {
  const sessionCookies = setCookieHeaders
    .map(raw => parseSetCookie(raw))
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
    .filter(({ name, value }) => isSessionCookie(name, value));

  if (sessionCookies.length === 0) return false;
  return sessionCookies.every(({ flags }) => flags.includes('samesite=strict'));
}

function normalizeRequestPath(url: string, method: string): string {
  try {
    const parsed = new URL(url);
    return normalizePath(parsed.pathname);
  } catch {
    // Fall back to raw URL normalized
    log.debug('csrf-detector: URL parse failed; using raw', { url, method });
    return normalizePath(url);
  }
}
