#!/usr/bin/env node
// BugHunter self-test API server — deliberately vulnerable endpoints.
// Each route demonstrates exactly one wired BugKind with a SELF-TEST comment.
// INTENTIONALLY VULNERABLE — DO NOT DEPLOY.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.SELF_API_PORT ? parseInt(process.env.SELF_API_PORT, 10) : 5791;

// Token store for password_reset_token_reuse: tracks consumed tokens.
const usedResetTokens = new Set();

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

function text(res, status, body, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...extraHeaders });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // --- SELF-TEST: triggers network_5xx ---
  if (pathname === '/api/boom') {
    json(res, 500, { error: 'Internal Server Error' });
    return;
  }

  // --- SELF-TEST: triggers network_4xx_unexpected ---
  if (pathname === '/api/teapot') {
    json(res, 418, { error: "I'm a teapot" });
    return;
  }

  // --- SELF-TEST: triggers surface_call_failed (always rejects) ---
  if (pathname === '/api/refuse') {
    json(res, 503, { error: 'Service unavailable', code: 'ECONNRESET' });
    return;
  }

  // --- SELF-TEST: triggers xss_reflected ---
  if (pathname === '/api/echo') {
    const q = query.q ?? '';
    // INTENTIONALLY UNSAFE: reflects user input into HTML body without escaping
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body>${q}</body></html>`);
    return;
  }

  // --- SELF-TEST: triggers auth_session_fixation ---
  if (pathname === '/api/login-fixation') {
    // INTENTIONALLY UNSAFE: accepts client-supplied session id
    const sessionId = query.sessionId ?? 'default-session-' + Date.now();
    json(res, 200, { sessionId, user: 'self-test-user' });
    return;
  }

  // --- SELF-TEST: triggers password_reset_token_reuse ---
  if (pathname === '/api/reset') {
    const token = query.token ?? '';
    if (token === '') {
      json(res, 400, { error: 'token required' });
      return;
    }
    // INTENTIONALLY UNSAFE: does NOT invalidate used tokens
    usedResetTokens.add(token);
    json(res, 200, { ok: true, token });
    return;
  }

  // --- SELF-TEST: triggers missing_csp_header ---
  if (pathname === '/headers/no-csp') {
    // INTENTIONALLY MISSING: no Content-Security-Policy header
    json(res, 200, { ok: true });
    return;
  }

  // --- SELF-TEST: triggers permissive_cors ---
  if (pathname === '/headers/wide-cors') {
    // INTENTIONALLY UNSAFE: wildcard CORS with credentials allowed
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- SELF-TEST: triggers cookie_security_flags ---
  if (pathname === '/headers/bad-cookie') {
    // INTENTIONALLY UNSAFE: cookie without Secure, HttpOnly, SameSite
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'sid=self-test-session-foo',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- SELF-TEST: triggers open_redirect ---
  if (pathname === '/redirect') {
    // INTENTIONALLY UNSAFE: follows arbitrary user-supplied URL
    const to = query.to ?? '/';
    res.writeHead(302, { Location: to });
    res.end();
    return;
  }

  // --- SELF-TEST: triggers sensitive_data_in_url ---
  if (pathname === '/api/transfer') {
    // INTENTIONALLY UNSAFE: ssn and token appear in URL query string
    const ssn = query.ssn ?? '';
    const token = query.token ?? '';
    json(res, 200, { transferred: true, ssn, token });
    return;
  }

  // --- SELF-TEST: triggers stack_trace_leak_in_response ---
  if (pathname === '/api/throw') {
    // INTENTIONALLY UNSAFE: returns raw Node stack trace in response body
    const err = new Error('SELF-TEST INTENTIONAL THROW');
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}\n${err.stack}`);
    return;
  }

  // --- SELF-TEST: triggers csrf_missing_on_mutating_route ---
  if (pathname === '/api/csrf-mutate') {
    // INTENTIONALLY UNSAFE: mutating POST endpoint with no CSRF token check
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify({ mutated: true }));
    return;
  }

  // --- API items for n_plus_one fixture page ---
  if (pathname.startsWith('/api/item/')) {
    const id = pathname.slice('/api/item/'.length);
    json(res, 200, { id, name: `Item ${id}`, value: Math.random() });
    return;
  }

  // --- API endpoint for request_dedup_missing fixture ---
  if (pathname === '/api/foo') {
    json(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  // --- Slow image for slow_lcp fixture ---
  if (pathname === '/slow.png') {
    setTimeout(() => {
      const png1x1 = Buffer.from([
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
        0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
        0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xde,
        0x00,0x00,0x00,0x0c,0x49,0x44,0x41,0x54,0x08,0xd7,0x63,0xf8,0xcf,0xc0,0x00,0x00,
        0x00,0x02,0x00,0x01,0xe2,0x21,0xbc,0x33,
        0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
      ]);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png1x1);
    }, 4000);
    return;
  }

  json(res, 404, { error: 'Not found', path: pathname });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`self-test API server listening on http://127.0.0.1:${PORT}\n`);
});
