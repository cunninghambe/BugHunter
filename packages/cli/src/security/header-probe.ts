// Header-probe module (v0.5 T12).
// Pure HTTP request + response analysis for CSP, CORS, cookie, CSRF, redirect,
// sensitive-URL, and stack-trace security checks.

import type { BugDetection } from '../types.js';
import {
  isSessionCookie, isCsrfCookie, parseSetCookie, isLocalhostOrigin,
  fingerprintFramePath, STACK_TRACE_PATTERNS, OPEN_REDIRECT_PARAM_NAMES,
  SENSITIVE_URL_PARAMS,
} from './header-rules.js';

export type HeaderProbeRequest = {
  url: string;
  method: 'GET' | 'OPTIONS' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
};

export type HeaderProbeResult = {
  status: number;
  responseHeaders: Record<string, string>;
  setCookieHeaders: string[];
  durationMs: number;
};

export async function probeHeaders(req: HeaderProbeRequest): Promise<HeaderProbeResult> {
  const start = Date.now();
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual',
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });

  // getSetCookie is available in Node.js 18+ fetch; collect all Set-Cookie values
  const setCookieRaw = response.headers.get('set-cookie');
  const setCookieHeaders = setCookieRaw !== null ? [setCookieRaw] : [];

  return {
    status: response.status,
    responseHeaders,
    setCookieHeaders,
    durationMs: Date.now() - start,
  };
}

/** All security checks from §3.2. Returns detections (empty = clean). */
export function analyzeProbeResult(
  probeResult: HeaderProbeResult,
  url: string,
  options: {
    cspLocalhostMode?: 'skip' | 'flag';
    cookieLocalhostMode?: 'skip' | 'flag';
    csrfCookieNamePatterns?: string[];
    stackTraceFingerprintLength?: number;
  } = {}
): BugDetection[] {
  const detections: BugDetection[] = [];
  const isLocalhost = isLocalhostOrigin(url);
  const origin = extractOrigin(url);
  const route = extractRoute(url);

  detections.push(...checkCsp(probeResult, origin, isLocalhost, options.cspLocalhostMode ?? 'skip'));
  detections.push(...checkCors(probeResult, route));
  detections.push(...checkCookies(probeResult, isLocalhost, options.cookieLocalhostMode ?? 'skip'));
  detections.push(...checkStackTrace(probeResult, route, options.stackTraceFingerprintLength ?? 3));

  return detections;
}

/** Check CSP header presence and weakness. */
function checkCsp(
  result: HeaderProbeResult,
  origin: string,
  isLocalhost: boolean,
  localhostMode: 'skip' | 'flag'
): BugDetection[] {
  if (isLocalhost && localhostMode === 'skip') return [];

  const csp = result.responseHeaders['content-security-policy'] ?? '';
  if (csp.length === 0) {
    return [{
      kind: 'missing_csp_header',
      rootCause: `Content-Security-Policy header absent on ${origin}`,
      headerContext: {
        headerName: 'Content-Security-Policy',
        expectedShape: 'present',
        observedValue: origin,
      },
    }];
  }

  // Check for unsafe-inline in script-src
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    return [{
      kind: 'missing_csp_header',
      rootCause: `CSP present but script-src includes 'unsafe-inline' on ${origin}`,
      headerContext: {
        headerName: 'Content-Security-Policy',
        expectedShape: 'inline_scripts_allowed',
        observedValue: origin,
      },
    }];
  }

  return [];
}

/** Check for permissive CORS configuration. */
function checkCors(result: HeaderProbeResult, route: string): BugDetection[] {
  const acao: string | undefined = result.responseHeaders['access-control-allow-origin'];
  const acac: string | undefined = result.responseHeaders['access-control-allow-credentials'];

  if (acao !== '*') return [];

  if (acac === 'true') {
    return [{
      kind: 'permissive_cors',
      rootCause: `CORS: Access-Control-Allow-Origin: * combined with Allow-Credentials: true on ${route}`,
      endpoint: route,
      headerContext: { headerName: 'Access-Control-Allow-Origin', observedValue: '*', expectedShape: 'permissive_credentialed' },
    }];
  }

  return [];
}

/** Check cookie security flags. */
function checkCookies(
  result: HeaderProbeResult,
  isLocalhost: boolean,
  localhostMode: 'skip' | 'flag'
): BugDetection[] {
  const detections: BugDetection[] = [];

  for (const rawCookie of result.setCookieHeaders) {
    const parsed = parseSetCookie(rawCookie);
    if (parsed === null) continue;
    if (!isSessionCookie(parsed.name, parsed.value)) continue;

    const { name, flags } = parsed;
    const hasSecure = flags.includes('secure');
    const hasHttpOnly = flags.includes('httponly');
    const hasSameSite = flags.some(f => f.startsWith('samesite'));

    // no_secure: skip on localhost by default
    if (!hasSecure && !(isLocalhost && localhostMode === 'skip')) {
      detections.push({
        kind: 'cookie_security_flags',
        rootCause: `Cookie '${name}' missing Secure flag`,
        headerContext: { headerName: name, expectedShape: 'no_secure' },
      });
    }

    // no_http_only: exempt CSRF cookies
    if (!hasHttpOnly && !isCsrfCookie(name)) {
      detections.push({
        kind: 'cookie_security_flags',
        rootCause: `Cookie '${name}' missing HttpOnly flag`,
        headerContext: { headerName: name, expectedShape: 'no_http_only' },
      });
    }

    if (!hasSameSite) {
      detections.push({
        kind: 'cookie_security_flags',
        rootCause: `Cookie '${name}' missing SameSite flag`,
        headerContext: { headerName: name, expectedShape: 'no_same_site' },
      });
    }
  }

  return detections;
}

/** Check for stack traces leaked in response bodies.
 * Full body analysis is done by analyzeResponseBody (called by the execute phase with the body text).
 * This hook only checks status — header-only probes cannot read the body.
 */
function checkStackTrace(
  result: HeaderProbeResult,
  _route: string,
  _fingerprintLength: number
): BugDetection[] {
  if (result.status < 500) return [];
  // Cannot read body from a HeaderProbeResult — body analysis uses analyzeResponseBody separately.
  return [];
}

/** Analyze a raw response body for stack trace leaks (called separately when body is available). */
export function analyzeResponseBody(
  body: string,
  route: string,
  fingerprintLength = 3
): BugDetection[] {
  for (const pattern of STACK_TRACE_PATTERNS) {
    const match = pattern.exec(body);
    if (match !== null) {
      const framePath = extractFramePath(match[0]);
      const fingerprint = fingerprintFramePath(framePath, fingerprintLength);
      return [{
        kind: 'stack_trace_leak_in_response',
        rootCause: `Stack trace leaked in ${route} response body`,
        endpoint: route,
        headerContext: { headerName: 'response-body', expectedShape: fingerprint },
      }];
    }
  }
  return [];
}

/** Analyze observed URLs for sensitive query parameters. */
export function analyzeSensitiveUrl(
  url: string,
  customPatterns?: string[]
): BugDetection[] {
  const patterns = customPatterns ?? SENSITIVE_URL_PARAMS;
  const urlObj = (() => { try { return new URL(url); } catch { return null; } })();
  if (urlObj === null) return [];

  const route = urlObj.pathname;
  const detections: BugDetection[] = [];

  for (const [param] of urlObj.searchParams.entries()) {
    const lowerParam = param.toLowerCase();
    if (patterns.some(p => lowerParam === p.toLowerCase())) {
      detections.push({
        kind: 'sensitive_data_in_url',
        rootCause: `Sensitive parameter '${param}' found in URL on ${route}`,
        endpoint: route,
        headerContext: { headerName: param, expectedShape: 'sensitive_param' },
      });
    }
  }

  return detections;
}

/** Check for open redirect by probing with evil.test as redirect target. */
export async function checkOpenRedirect(
  baseUrl: string,
  paramNames: string[] = OPEN_REDIRECT_PARAM_NAMES
): Promise<BugDetection[]> {
  const detections: BugDetection[] = [];
  const urlObj = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (urlObj === null) return [];

  for (const param of paramNames) {
    const testUrl = new URL(baseUrl);
    testUrl.searchParams.set(param, 'https://evil.test');

    try {
      const result = await probeHeaders({ url: testUrl.toString(), method: 'GET' });
      if (result.status >= 300 && result.status < 400) {
        const location = result.responseHeaders['location'] ?? '';
        if (location.includes('evil.test')) {
          detections.push({
            kind: 'open_redirect',
            rootCause: `Open redirect via '${param}' parameter on ${urlObj.pathname}`,
            endpoint: urlObj.pathname,
            headerContext: { headerName: param, expectedShape: 'redirect_to_evil_test' },
          });
        }
      }
    } catch {
      // Network error on this param — continue
    }
  }

  return detections;
}

function extractOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function extractRoute(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function extractFramePath(stackLine: string): string {
  const match = /\(?(\/[^):\s]+)/.exec(stackLine);
  return match?.[1] ?? stackLine;
}
