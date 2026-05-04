#!/usr/bin/env node
// CSP-mini fixture for missing_csp_header detector calibration.
// P1 (fires/major):  / — no CSP header at all.
// P2 (fires/major):  /admin — CSP-Report-Only only, no enforced CSP.
// Negative (silent): /secure — strong enforced CSP; detector must be silent.
// Edge (fires/info): /report-only — Report-Only only; fires with info severity (V56 §17).
//                    Rationale: Report-Only provides zero runtime protection.
// Edge (fires/info): /unsafe-inline — CSP present but allows unsafe-inline for script-src.
//                    Rationale: unsafe-inline defeats XSS protection; policy is present but weak.
// Skipped:           no_response — harness skips when fixture returns no response (network error).

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9973;

function respond(res, status, headers, body) {
  res.writeHead(status, { 'Content-Type': 'text/html', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // Reset endpoint
  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // P1: root — no CSP header at all
  if (pathname === '/') {
    respond(res, 200, {}, '<html><body><h1>Home</h1></body></html>');
    return;
  }

  // P2: /admin — CSP-Report-Only only, no enforced header
  if (pathname === '/admin') {
    respond(res, 200, {
      'Content-Security-Policy-Report-Only': "default-src 'self'",
    }, '<html><body><h1>Admin</h1></body></html>');
    return;
  }

  // Negative: /secure — strong enforced CSP; detector must be silent.
  if (pathname === '/secure') {
    respond(res, 200, {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    }, '<html><body><h1>Secure</h1></body></html>');
    return;
  }

  // Edge: /report-only — Report-Only header only, no enforced CSP.
  if (pathname === '/report-only') {
    respond(res, 200, {
      'Content-Security-Policy-Report-Only': "default-src 'self'; script-src 'self'",
    }, '<html><body><h1>Report Only</h1></body></html>');
    return;
  }

  // Edge: /unsafe-inline — CSP present but allows unsafe-inline for script-src.
  if (pathname === '/unsafe-inline') {
    respond(res, 200, {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
    }, '<html><body><h1>Unsafe Inline</h1></body></html>');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`csp-mini ready on port ${PORT}\n`);
});
