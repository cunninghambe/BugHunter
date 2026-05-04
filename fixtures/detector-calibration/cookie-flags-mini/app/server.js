#!/usr/bin/env node
// cookie-flags-mini — fixture for cookie_security_flags detector.
//
// Detector fires per missing-flag on session-shaped cookies:
//   - Secure (skipped on localhost by default; harness uses 'flag' mode)
//   - HttpOnly (CSRF cookies exempt)
//   - SameSite

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9933;

function respond(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Positive: session cookie with no security flags whatsoever
  if (pathname === '/no-flags') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=',
    }, 'no flags');
    return;
  }

  // Negative: session cookie with all three flags set
  if (pathname === '/all-flags') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; Secure; HttpOnly; SameSite=Strict',
    }, 'all flags');
    return;
  }

  // Edge: missing only HttpOnly (Secure + SameSite present)
  if (pathname === '/missing-httponly') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; Secure; SameSite=Lax',
    }, 'missing httponly');
    return;
  }

  // Edge: missing only SameSite
  if (pathname === '/missing-samesite') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'sessionid=abc123def456ghi789jklmnop1234567890=; Secure; HttpOnly',
    }, 'missing samesite');
    return;
  }

  // Negative edge: non-session cookie (short value, generic name) — should NOT fire
  if (pathname === '/non-session-cookie') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'preference=dark; Path=/',
    }, 'non-session');
    return;
  }

  // Negative edge: CSRF cookie missing HttpOnly — exempt by name
  if (pathname === '/csrf-cookie-no-httponly') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'csrf-token=abc123def456ghi789jklmnop1234567890=; Secure; SameSite=Strict',
    }, 'csrf no httponly is ok');
    return;
  }

  // Input degradation: malformed Set-Cookie value (no = sign) — should not fire and not crash
  if (pathname === '/malformed-set-cookie') {
    respond(res, 200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'malformedcookieheader',
    }, 'malformed');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`cookie-flags-mini ready on port ${PORT}\n`);
});
