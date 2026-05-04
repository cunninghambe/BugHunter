#!/usr/bin/env node
// rate-limit-mini — fixture for no_rate_limit_on_login.
// Each route is a "login" endpoint that responds differently to repeated POSTs.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9853;

// Per-route attempt counters (reset on /__bughunter_reset)
const counters = new Map();

function reset() { counters.clear(); }
function bump(route) {
  const n = (counters.get(route) ?? 0) + 1;
  counters.set(route, n);
  return n;
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    reset();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Positive: never rate-limits — accepts unlimited 401s
  if (pathname === '/login-no-rate-limit') {
    bump(pathname);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid credentials' }));
    return;
  }

  // Negative: returns 429 after 5 attempts
  if (pathname === '/login-rate-limited-429') {
    const n = bump(pathname);
    if (n >= 5) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'too many attempts' }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid credentials' }));
    return;
  }

  // Edge: returns 423 (locked) after 3 attempts — also satisfies the detector
  if (pathname === '/login-rate-limited-423') {
    const n = bump(pathname);
    if (n >= 3) {
      res.writeHead(423, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'account locked' }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid credentials' }));
    return;
  }

  // Edge: returns 200 always (login that always succeeds — pathological but possible)
  if (pathname === '/login-always-200') {
    bump(pathname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Input degradation: server returns connection-reset on 6th attempt; harness
  // should still detect "no rate limit" because no 429/423 was seen.
  if (pathname === '/login-rst-on-6th') {
    const n = bump(pathname);
    if (n >= 6) {
      res.destroy();
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid credentials' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`rate-limit-mini ready on port ${PORT}\n`);
});
