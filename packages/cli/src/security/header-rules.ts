// Header-probe rule data (v0.5 T12).
// Pure data — no IO. Rules are applied by header-probe.ts.

/** Cookie names that indicate a session/auth token. */
export const SESSION_COOKIE_NAME_PATTERNS = [
  'session', 'sid', 'sess', 'auth', 'token',
  'tj_sess', 'connect.sid', 'next-auth',
];

/** Cookie names that are explicitly CSRF tokens — exempt from no_http_only check. */
export const CSRF_COOKIE_NAME_PATTERNS = ['csrf', 'xsrf', '_csrf'];

/** Open-redirect param names to probe. */
export const OPEN_REDIRECT_PARAM_NAMES = [
  'redirect', 'return_to', 'returnTo', 'next', 'url', 'continue', 'redirectUrl',
];

/** Sensitive URL param names that should not appear in query strings. */
export const SENSITIVE_URL_PARAMS = [
  'password', 'pwd', 'token', 'api_key', 'apiKey', 'secret', 'email',
];

/** Regex patterns that indicate a stack trace frame in a response body. */
export const STACK_TRACE_PATTERNS = [
  /at \/[^"]+\.(js|ts):\d+/,
  /at Object\.<anonymous> \([^)]+:\d+:\d+\)/,
  /Error: .+\n\s+at /,
];

/**
 * Detect whether a cookie value is session-shaped:
 * - Name matches SESSION_COOKIE_NAME_PATTERNS, or
 * - Value >= 32 chars and matches opaque-token pattern.
 */
export function isSessionCookie(name: string, value: string): boolean {
  const lowerName = name.toLowerCase();
  if (SESSION_COOKIE_NAME_PATTERNS.some(p => lowerName.includes(p))) return true;
  return value.length >= 32 && /^[A-Za-z0-9_+/=.~-]+$/.test(value);
}

/** Returns true if cookie name contains a CSRF pattern (exempt from no_http_only check). */
export function isCsrfCookie(name: string): boolean {
  const lowerName = name.toLowerCase();
  return CSRF_COOKIE_NAME_PATTERNS.some(p => lowerName.includes(p));
}

/** Parse a Set-Cookie header value into { name, value, flags }. */
export function parseSetCookie(raw: string): { name: string; value: string; flags: string[] } | null {
  const parts = raw.split(';').map(p => p.trim());
  const nameValue = parts[0] ?? '';
  if (nameValue.length === 0) return null;
  const eqIdx = nameValue.indexOf('=');
  if (eqIdx === -1) return null;
  const name = nameValue.slice(0, eqIdx).trim();
  const value = nameValue.slice(eqIdx + 1).trim();
  const flags = parts.slice(1).map(p => p.toLowerCase());
  return { name, value, flags };
}

/** Returns true if the given origin is localhost (http://localhost*). */
export function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  } catch {
    return false;
  }
}

/** Fingerprint the first N path segments of a stack frame path. */
export function fingerprintFramePath(framePath: string, segments = 3): string {
  const parts = framePath.split('/').filter(p => p !== '');
  return parts.slice(0, segments).join('/');
}
