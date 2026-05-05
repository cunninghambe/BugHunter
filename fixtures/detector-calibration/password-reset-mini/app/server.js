#!/usr/bin/env node
// password-reset-mini — fixture for password_reset_token_reuse.
//
// Each /reset-* route models a different token-management strategy.
// Harness probes:
//   1. POST /<route>/request to get a reset token.
//   2. POST /<route>/consume with the token (first use — should succeed).
//   3. POST /<route>/consume with the same token again (second use — must be rejected).

'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9783;

let usedTokens = {};

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url).pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/__bughunter_reset') {
    usedTokens = {};
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Helper for issuing a token
  function issueToken(route) {
    return crypto.randomBytes(16).toString('hex');
  }

  // Positive: server allows token to be reused (broken)
  if (pathname === '/reset-broken/request' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: issueToken('reset-broken') }));
    return;
  }
  if (pathname === '/reset-broken/consume' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.token === 'string' && body.token.length > 0) {
      // Bug: always accepts — never marks token as used.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token required' }));
    return;
  }

  // Negative: server marks token as used and rejects second use
  if (pathname === '/reset-correct/request' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: issueToken('reset-correct') }));
    return;
  }
  if (pathname === '/reset-correct/consume' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.token !== 'string' || body.token.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token required' }));
      return;
    }
    const key = `correct:${body.token}`;
    if (usedTokens[key] === true) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token already used' }));
      return;
    }
    usedTokens[key] = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Edge: server returns 200 OK on second use but with body indicating failure.
  // Detector should still recognize the second-use rejection.
  if (pathname === '/reset-200-but-rejects/request' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: issueToken('reset-200') }));
    return;
  }
  if (pathname === '/reset-200-but-rejects/consume' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.token !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token required' }));
      return;
    }
    const key = `200:${body.token}`;
    if (usedTokens[key] === true) {
      // 200 OK but body says failure
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'token already used' }));
      return;
    }
    usedTokens[key] = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`password-reset-mini ready on port ${PORT}\n`);
});
