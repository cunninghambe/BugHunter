#!/usr/bin/env node
// browser-platform-headers-mini — fixture for static-heuristic harness paths of:
//   subresource_integrity_violation
//   coop_coep_violation
//   trusted_types_violation
// All three production detectors require browser runtime; the harness implements
// a focused static check matching the most-common-case 80% detection.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9873;

function html(status, headers, body) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body };
}

const ROUTES = {
  // ---- SRI routes ----
  // Positive: external <script> with no integrity attribute
  '/sri-external-no-integrity': html(200, {}, '<!doctype html><html><head><script src="https://cdn.example.com/lib.js"></script></head><body>x</body></html>'),
  // Negative: external <script> with integrity attribute
  '/sri-external-with-integrity': html(200, {}, '<!doctype html><html><head><script src="https://cdn.example.com/lib.js" integrity="sha384-abc123" crossorigin="anonymous"></script></head><body>x</body></html>'),
  // Negative edge: same-origin script (no SRI required)
  '/sri-same-origin-script': html(200, {}, '<!doctype html><html><head><script src="/local.js"></script></head><body>x</body></html>'),
  // Edge: external link rel="stylesheet" without integrity — also flagged
  '/sri-external-stylesheet-no-integrity': html(200, {}, '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/style.css"></head><body>x</body></html>'),
  // Input degradation: malformed HTML still has external script without integrity
  '/sri-malformed': html(200, {}, '<!doctype html><html<><head><script src="https://cdn.example.com/lib.js"<<></script></head<><body<>x</body></html>'),

  // ---- COOP/COEP routes ----
  // Positive: page references SharedArrayBuffer but no COOP/COEP headers set
  '/coop-coep-sab-no-headers': html(200, {}, '<!doctype html><html><head><script>const buf = new SharedArrayBuffer(1024);</script></head><body>x</body></html>'),
  // Negative: COOP + COEP both set correctly
  '/coop-coep-with-headers': html(200, {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  }, '<!doctype html><html><head><script>const buf = new SharedArrayBuffer(1024);</script></head><body>x</body></html>'),
  // Negative edge: page does not use SharedArrayBuffer at all — COOP/COEP not required
  '/coop-coep-no-sab-usage': html(200, {}, '<!doctype html><html><head><script>console.log("hello");</script></head><body>x</body></html>'),
  // Edge: SAB referenced via typeof (feature detection only) — should NOT fire
  '/coop-coep-sab-typeof-only': html(200, {}, '<!doctype html><html><head><script>if (typeof SharedArrayBuffer !== "undefined") { console.log("supported"); }</script></head><body>x</body></html>'),

  // ---- Trusted Types routes ----
  // Positive: CSP requires-trusted-types-for but has no trusted-types policy declared
  '/tt-require-without-policy': html(200, {
    'Content-Security-Policy': "require-trusted-types-for 'script'",
  }, '<!doctype html><html><head></head><body>x</body></html>'),
  // Negative: CSP both requires AND declares trusted-types policy
  '/tt-policy-declared': html(200, {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types myPolicy",
  }, '<!doctype html><html><head></head><body>x</body></html>'),
  // Negative edge: no Trusted Types directive at all — silent
  '/tt-no-directive': html(200, {
    'Content-Security-Policy': "default-src 'self'",
  }, '<!doctype html><html><head></head><body>x</body></html>'),
  // Edge: trusted-types policy with default keyword — silent
  '/tt-default-policy': html(200, {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types 'default'",
  }, '<!doctype html><html><head></head><body>x</body></html>'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const route = ROUTES[pathname];
  if (route !== undefined) {
    res.writeHead(route.status, route.headers);
    res.end(route.body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`browser-platform-headers-mini ready on port ${PORT}\n`);
});
