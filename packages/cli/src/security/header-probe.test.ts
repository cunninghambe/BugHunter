// Tests for header-probe module (v0.5 T12).

import { describe, it, expect } from 'vitest';
import { analyzeProbeResult, analyzeResponseBody, analyzeSensitiveUrl } from './header-probe.js';
import type { HeaderProbeResult } from './header-probe.js';

function makeResult(overrides: Partial<HeaderProbeResult> = {}): HeaderProbeResult {
  return {
    status: 200,
    responseHeaders: {},
    setCookieHeaders: [],
    durationMs: 10,
    ...overrides,
  };
}

describe('CSP checks', () => {
  it('emits missing_csp_header when CSP header absent (non-localhost)', () => {
    const detections = analyzeProbeResult(
      makeResult(),
      'https://myapp.example.com/dashboard'
    );
    expect(detections.some(d => d.kind === 'missing_csp_header')).toBe(true);
  });

  it('suppresses missing_csp_header on localhost by default', () => {
    const detections = analyzeProbeResult(
      makeResult(),
      'http://localhost:3002/dashboard'
    );
    expect(detections.some(d => d.kind === 'missing_csp_header')).toBe(false);
  });

  it('flags localhost when localhostMode=flag', () => {
    const detections = analyzeProbeResult(
      makeResult(),
      'http://localhost:3002/dashboard',
      { cspLocalhostMode: 'flag' }
    );
    expect(detections.some(d => d.kind === 'missing_csp_header')).toBe(true);
  });

  it('emits missing_csp_header with inline_scripts_allowed when CSP has unsafe-inline', () => {
    const detections = analyzeProbeResult(
      makeResult({ responseHeaders: { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'" } }),
      'https://myapp.example.com/',
    );
    const cspDetection = detections.find(d => d.kind === 'missing_csp_header');
    expect(cspDetection).toBeDefined();
    expect(cspDetection?.headerContext?.expectedShape).toBe('inline_scripts_allowed');
  });

  it('emits inline_scripts_allowed for TraiderJo exact CSP (localhost, localhostMode=flag)', () => {
    // TraiderJo's exact header: script-src 'self' 'unsafe-inline'
    const traiderJoCsp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;";
    const detections = analyzeProbeResult(
      makeResult({ responseHeaders: { 'content-security-policy': traiderJoCsp } }),
      'http://127.0.0.1:8787/',
      { cspLocalhostMode: 'flag' },
    );
    const cspDetection = detections.find(d => d.kind === 'missing_csp_header');
    expect(cspDetection).toBeDefined();
    expect(cspDetection?.headerContext?.expectedShape).toBe('inline_scripts_allowed');
  });

  it('no detection when CSP is properly set', () => {
    const detections = analyzeProbeResult(
      makeResult({ responseHeaders: { 'content-security-policy': "default-src 'self'" } }),
      'https://myapp.example.com/'
    );
    expect(detections.some(d => d.kind === 'missing_csp_header')).toBe(false);
  });
});

describe('CORS checks', () => {
  it('emits permissive_cors when ACAO=* and ACAC=true', () => {
    const detections = analyzeProbeResult(
      makeResult({
        responseHeaders: {
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
          'content-security-policy': "default-src 'self'",
        },
      }),
      'https://myapp.example.com/api/data'
    );
    const cors = detections.find(d => d.kind === 'permissive_cors');
    expect(cors).toBeDefined();
    expect(cors?.headerContext?.expectedShape).toBe('permissive_credentialed');
  });

  it('no detection when ACAO is a specific origin', () => {
    const detections = analyzeProbeResult(
      makeResult({
        responseHeaders: {
          'access-control-allow-origin': 'https://myapp.example.com',
          'content-security-policy': "default-src 'self'",
        },
      }),
      'https://myapp.example.com/api/data'
    );
    expect(detections.some(d => d.kind === 'permissive_cors')).toBe(false);
  });
});

describe('Cookie security checks', () => {
  it('emits cookie_security_flags for session cookie missing HttpOnly', () => {
    const detections = analyzeProbeResult(
      makeResult({
        responseHeaders: { 'content-security-policy': "default-src 'self'" },
        setCookieHeaders: ['session=abc123defghij0123456789abcdef01234567; Path=/; SameSite=Strict'],
      }),
      'https://myapp.example.com/'
    );
    const httpOnly = detections.find(d =>
      d.kind === 'cookie_security_flags' && d.headerContext?.expectedShape === 'no_http_only'
    );
    expect(httpOnly).toBeDefined();
  });

  it('does NOT flag CSRF cookies for no_http_only', () => {
    const detections = analyzeProbeResult(
      makeResult({
        responseHeaders: { 'content-security-policy': "default-src 'self'" },
        setCookieHeaders: ['tj_csrf=abc123defghij0123456789abcdef01234567; Path=/; SameSite=Strict'],
      }),
      'https://myapp.example.com/'
    );
    const httpOnly = detections.find(d =>
      d.kind === 'cookie_security_flags' && d.headerContext?.expectedShape === 'no_http_only'
    );
    expect(httpOnly).toBeUndefined();
  });

  it('suppresses no_secure on localhost by default', () => {
    const detections = analyzeProbeResult(
      makeResult({
        setCookieHeaders: ['tj_sess=abc123defghij0123456789abcdef01234567; HttpOnly; SameSite=Strict; Path=/'],
      }),
      'http://localhost:3002/'
    );
    expect(detections.some(d =>
      d.kind === 'cookie_security_flags' && d.headerContext?.expectedShape === 'no_secure'
    )).toBe(false);
  });

  it('ignores non-session-shaped cookies', () => {
    const detections = analyzeProbeResult(
      makeResult({
        responseHeaders: { 'content-security-policy': "default-src 'self'" },
        setCookieHeaders: ['theme=dark; Path=/'],
      }),
      'https://myapp.example.com/'
    );
    expect(detections.filter(d => d.kind === 'cookie_security_flags')).toHaveLength(0);
  });
});

describe('analyzeResponseBody (stack trace leak)', () => {
  it('detects Node.js stack trace in response body', () => {
    const body = 'Error: Something failed\n    at /app/server/src/index.js:397:15\n    at Object.<anonymous>';
    const detections = analyzeResponseBody(body, '/api/trades');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('stack_trace_leak_in_response');
  });

  it('no detection for normal response body', () => {
    const body = '{"data": [], "message": "ok"}';
    const detections = analyzeResponseBody(body, '/api/trades');
    expect(detections).toHaveLength(0);
  });
});

describe('analyzeSensitiveUrl', () => {
  it('detects password in URL query string', () => {
    const detections = analyzeSensitiveUrl('https://example.com/reset?password=hunter2&email=test@test.com');
    expect(detections.some(d => d.kind === 'sensitive_data_in_url' && d.headerContext?.headerName === 'password')).toBe(true);
    expect(detections.some(d => d.kind === 'sensitive_data_in_url' && d.headerContext?.headerName === 'email')).toBe(true);
  });

  it('no detection for clean URL', () => {
    const detections = analyzeSensitiveUrl('https://example.com/trades?page=1&sort=asc');
    expect(detections).toHaveLength(0);
  });
});
