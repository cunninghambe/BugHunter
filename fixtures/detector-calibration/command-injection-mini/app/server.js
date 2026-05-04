#!/usr/bin/env node
// INTENTIONALLY VULNERABLE command-injection-mini fixture.
// Plants: command_injection — direct shell concatenation in admin health endpoints.
// DO NOT DEPLOY to any public network.

'use strict';

const http = require('node:http');
const { exec } = require('node:child_process');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9979;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname === '/__bughunter_reset') {
    text(res, 200, 'ok');
    return;
  }

  if (pathname === '/') {
    text(res, 200, 'command-injection-mini fixture');
    return;
  }

  if (pathname === '/api/admin/health' && req.method === 'POST') {
    const body = await readBody(req);

    // P1: { target } → exec('ping -c 1 ' + target) — direct shell concat
    if (typeof body.target === 'string') {
      // INTENTIONALLY UNSAFE — shell injection via string concatenation
      exec('ping -c 1 ' + body.target, { timeout: 5000 }, (err, stdout, stderr) => {
        json(res, 200, { output: stdout + stderr, error: err ? err.message : null });
      });
      return;
    }

    // P2: { domain } → exec('nslookup ' + domain) — same pattern, different field
    if (typeof body.domain === 'string') {
      // INTENTIONALLY UNSAFE — shell injection via string concatenation
      exec('nslookup ' + body.domain, { timeout: 5000 }, (err, stdout, stderr) => {
        json(res, 200, { output: stdout + stderr, error: err ? err.message : null });
      });
      return;
    }

    json(res, 400, { error: 'missing target or domain field' });
    return;
  }

  text(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`command-injection-mini ready on port ${PORT}\n`);
});
