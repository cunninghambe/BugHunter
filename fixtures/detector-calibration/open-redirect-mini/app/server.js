#!/usr/bin/env node
// open-redirect-mini — fixture for open_redirect detector.
//
// Detector probes ?redirect=https://evil.test (and synonyms). Fires when the
// response is a 3xx and Location header contains "evil.test".

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9913;

function redirect(res, location) {
  res.writeHead(302, { 'Location': location });
  res.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Positive: blindly redirects to whatever ?redirect= says
  if (pathname === '/login') {
    const target = query.redirect ?? '/dashboard';
    redirect(res, String(target));
    return;
  }

  // Positive (different param synonym): ?next=
  if (pathname === '/auth') {
    const target = query.next ?? '/home';
    redirect(res, String(target));
    return;
  }

  // Negative: validates target against allowlist before redirecting
  if (pathname === '/login-safe') {
    const target = String(query.redirect ?? '/dashboard');
    const safe = target.startsWith('/') && !target.startsWith('//');
    redirect(res, safe ? target : '/dashboard');
    return;
  }

  // Negative: route exists but does not honour any redirect param at all
  if (pathname === '/about') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('about page (no redirect)');
    return;
  }

  // Edge: 200 OK that echoes the param into body but never redirects
  if (pathname === '/echo') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`echo: ${String(query.redirect ?? '')}`);
    return;
  }

  // Edge: redirects to fixed location regardless of param — silent
  if (pathname === '/login-fixed-redirect') {
    redirect(res, '/dashboard');
    return;
  }

  // Input degradation: returns malformed Location header (not a URL).
  if (pathname === '/login-malformed-location') {
    const target = query.redirect ?? '';
    redirect(res, `not a real url ${String(target)}`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`open-redirect-mini ready on port ${PORT}\n`);
});
