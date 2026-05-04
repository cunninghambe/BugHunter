#!/usr/bin/env node
// CSP-mini fixture for missing_csp_header detector calibration.
// P1: / returns no Content-Security-Policy header.
// P2: /admin returns only CSP-Report-Only, no enforced CSP.
// /safe returns a proper enforced CSP (negative control).

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

  // Negative control: /safe returns a proper enforced CSP
  if (pathname === '/safe') {
    respond(res, 200, {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'",
    }, '<html><body><h1>Safe</h1></body></html>');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`csp-mini ready on port ${PORT}\n`);
});
