#!/usr/bin/env node
// csrf-missing-mini — fixture for csrf_missing_on_mutating_route.
//
// Each route accepts POST. The harness probes each with appropriate
// auth/cookie/header context and observes whether the CSRF detector fires.
// Detector skips: Bearer auth, SameSite=Strict on all session cookies,
// requests with CSRF cookie or X-CSRF-Token header.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9903;

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Set a session cookie on response so the harness can capture it for the cookieJar
  // observed on the next request. Different routes set different SameSite policies.

  // Positive: cookie-auth mutating endpoint, SameSite=Lax (CSRF-vulnerable).
  if (pathname === '/api/posts/create') {
    res.writeHead(req.method === 'POST' ? 201 : 200, {
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; HttpOnly; SameSite=Lax',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Positive (different method): PUT mutating route
  if (pathname === '/api/users/update') {
    res.writeHead(200, {
      'Set-Cookie': 'sid=abc123def456ghi789jklmnop1234567890=; HttpOnly; SameSite=Lax',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Negative: SameSite=Strict on session cookie — its own CSRF defense, detector skips.
  if (pathname === '/api/strict-session/mutate') {
    res.writeHead(200, {
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; HttpOnly; SameSite=Strict',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Negative: route returns 200 GET only — harness does not POST to it.
  if (pathname === '/api/read-only') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: 'read-only' }));
    return;
  }

  // Edge: route exists but the test plan sends a request with X-CSRF-Token header
  // — detector should skip when the header is present.
  if (pathname === '/api/with-csrf-header/mutate') {
    res.writeHead(200, {
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; HttpOnly; SameSite=Lax',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Edge: route exists with Bearer auth (JWT) — detector exempt.
  if (pathname === '/api/bearer-auth/mutate') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Edge: route exists with CSRF cookie present — detector exempt.
  if (pathname === '/api/with-csrf-cookie/mutate') {
    res.writeHead(200, {
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; HttpOnly; SameSite=Lax',
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`csrf-missing-mini ready on port ${PORT}\n`);
});
