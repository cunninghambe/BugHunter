#!/usr/bin/env node
// cors-mini — minimal CORS hygiene fixture for permissive_cors.
//
// Detector fires when Access-Control-Allow-Origin: * AND
// Access-Control-Allow-Credentials: true. Other combinations are silent.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9943;

function respond(res, status, headers, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Positive: ACAO:* + ACAC:true (the dangerous combination)
  if (pathname === '/wide-open') {
    respond(res, 200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    }, 'wide open');
    return;
  }

  // Negative: ACAO:* but no ACAC (safe — wildcard without credentials)
  if (pathname === '/wildcard-no-creds') {
    respond(res, 200, {
      'Access-Control-Allow-Origin': '*',
    }, 'wildcard no creds');
    return;
  }

  // Negative: specific origin + credentials (safe — explicit allowlist)
  if (pathname === '/origin-with-creds') {
    respond(res, 200, {
      'Access-Control-Allow-Origin': 'https://trusted.example.com',
      'Access-Control-Allow-Credentials': 'true',
    }, 'specific origin');
    return;
  }

  // Negative: no CORS headers at all (same-origin only)
  if (pathname === '/no-cors') {
    respond(res, 200, {}, 'no cors');
    return;
  }

  // Edge: ACAC: false explicitly (safe even with wildcard)
  if (pathname === '/wildcard-creds-false') {
    respond(res, 200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'false',
    }, 'wildcard creds-false');
    return;
  }

  // Input degradation: 500 response with the bad combo. Detector should still
  // observe headers and fire (header-probe doesn't depend on body).
  if (pathname === '/error-with-bad-cors') {
    respond(res, 500, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    }, 'internal error');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`cors-mini ready on port ${PORT}\n`);
});
