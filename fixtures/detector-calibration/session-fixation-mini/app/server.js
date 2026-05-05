#!/usr/bin/env node
// session-fixation-mini — fixture for auth_session_fixation.
//
// Each /login route models a different session-management strategy.
// Harness probes:
//   1. GET /login (capture pre-login session cookie)
//   2. POST /login with creds (capture post-login session cookie)
//   3. Compare: if same value, fires.

'use strict';

const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9793;

let preLoginSid = 'PRE-LOGIN-FIXED-VALUE';

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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Positive: pre-login cookie is reused after login (fixation).
  if (pathname === '/login-fixated') {
    if (method === 'GET') {
      res.writeHead(200, { 'Set-Cookie': `sessionid=${preLoginSid}; HttpOnly; Path=/`, 'Content-Type': 'text/html' });
      res.end('<form>login</form>');
      return;
    }
    if (method === 'POST') {
      // Bug: server keeps the pre-login session cookie after auth.
      res.writeHead(200, { 'Set-Cookie': `sessionid=${preLoginSid}; HttpOnly; Path=/`, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // Negative: server rotates the session ID on successful login.
  if (pathname === '/login-rotated') {
    if (method === 'GET') {
      res.writeHead(200, { 'Set-Cookie': `sessionid=PRE-LOGIN-12345; HttpOnly; Path=/`, 'Content-Type': 'text/html' });
      res.end('<form>login</form>');
      return;
    }
    if (method === 'POST') {
      const newSid = crypto.randomBytes(16).toString('hex');
      res.writeHead(200, { 'Set-Cookie': `sessionid=POSTLOGIN-${newSid}; HttpOnly; Path=/`, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // Edge: login does not set a cookie at all (token-based auth) — silent.
  if (pathname === '/login-token-only') {
    if (method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<form>login</form>');
      return;
    }
    if (method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: 'jwt-here' }));
      return;
    }
  }

  // Edge: GET issues cookie A; POST keeps A but also sets a SECOND auth cookie.
  // Detector still fires because the primary sessionid is reused.
  if (pathname === '/login-secondary-cookie') {
    if (method === 'GET') {
      res.writeHead(200, { 'Set-Cookie': `sessionid=PRE-A; HttpOnly; Path=/`, 'Content-Type': 'text/html' });
      res.end('<form>login</form>');
      return;
    }
    if (method === 'POST') {
      res.writeHead(200, {
        'Set-Cookie': [
          `sessionid=PRE-A; HttpOnly; Path=/`,
          `auth-token=NEW-${crypto.randomBytes(8).toString('hex')}; HttpOnly; Path=/`,
        ],
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`session-fixation-mini ready on port ${PORT}\n`);
});
