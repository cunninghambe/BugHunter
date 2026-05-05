#!/usr/bin/env node
// cache-staleness-mini — fixture for cache_staleness static-heuristic harness.
//
// Production detector uses DB invariants (post-mutation observation). Harness
// uses Cache-Control header heuristic: API/JSON responses with caching directives
// that may serve stale data after a mutation.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9823;

function respond(res, status, headers, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    respond(res, 200, {}, JSON.stringify({ ok: true }));
    return;
  }

  // Positive: long max-age cache on JSON API endpoint — stale data risk
  if (pathname === '/api/users') {
    return respond(res, 200, { 'Cache-Control': 'public, max-age=86400' }, JSON.stringify([{ id: 1 }]));
  }
  // Positive: explicit Expires far in the future
  if (pathname === '/api/products') {
    return respond(res, 200, { 'Expires': 'Wed, 01 Jan 2099 00:00:00 GMT' }, JSON.stringify([{ id: 1 }]));
  }
  // Negative: no-cache directive — appropriate for dynamic data
  if (pathname === '/api/dashboard') {
    return respond(res, 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' }, JSON.stringify({ users: 1 }));
  }
  // Negative: short max-age (≤60s) — acceptable for API
  if (pathname === '/api/feed') {
    return respond(res, 200, { 'Cache-Control': 'public, max-age=30' }, JSON.stringify([{ id: 1 }]));
  }
  // Negative edge: private cache only — not shared, lower risk
  if (pathname === '/api/profile') {
    return respond(res, 200, { 'Cache-Control': 'private, max-age=86400' }, JSON.stringify({ name: 'me' }));
  }
  // Negative: HTML page (not API) — caching long-lived HTML is fine here
  if (pathname === '/about') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=86400' });
    res.end('<!doctype html><html><body>About</body></html>');
    return;
  }
  // Edge: max-age in seconds explicitly large (3600+) on JSON API
  if (pathname === '/api/inventory') {
    return respond(res, 200, { 'Cache-Control': 'public, max-age=3600' }, JSON.stringify([{ stock: 10 }]));
  }
  // Negative: explicit must-revalidate even with max-age
  if (pathname === '/api/settings') {
    return respond(res, 200, { 'Cache-Control': 'public, max-age=86400, must-revalidate' }, JSON.stringify({ theme: 'dark' }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`cache-staleness-mini ready on port ${PORT}\n`);
});
