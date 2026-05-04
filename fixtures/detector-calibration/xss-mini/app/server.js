#!/usr/bin/env node
// xss-mini: minimal fixture for xss_reflected detector calibration.
// INTENTIONALLY VULNERABLE — for testing purposes only. Never deploy this.
//
// Three reflected XSS plants:
// P1: GET /api/echo?msg=  — reflects raw HTML from query param
// P2: GET /api/search?q=  — renders query into HTML snippet without escaping
// P3: POST /api/comments  — stores body.comment; GET /api/comments returns inline HTML

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.XSS_MINI_PORT ? parseInt(process.env.XSS_MINI_PORT, 10) : 9971;

// In-memory comment store (reset via /__bughunter_reset)
let comments = [];

function respond(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // P1: GET /api/echo?msg= — reflects raw HTML (no escaping)
  if (req.method === 'GET' && pathname === '/api/echo') {
    const msg = typeof query.msg === 'string' ? query.msg : '';
    // INTENTIONALLY UNSAFE — msg reflected directly into HTML
    respond(res, 200, 'text/html', `<p>${msg}</p>`);
    return;
  }

  // P2: GET /api/search?q= — reflects query into HTML snippet without escaping
  if (req.method === 'GET' && pathname === '/api/search') {
    const q = typeof query.q === 'string' ? query.q : '';
    // INTENTIONALLY UNSAFE — q interpolated into HTML
    respond(res, 200, 'text/html', `<div class="results">Search results for: ${q}</div>`);
    return;
  }

  // P3a: POST /api/comments — stores body.comment
  if (req.method === 'POST' && pathname === '/api/comments') {
    const raw = await readBody(req);
    let comment = '';
    try {
      comment = JSON.parse(raw).comment ?? '';
    } catch {
      comment = raw;
    }
    comments.push(comment);
    respond(res, 201, 'application/json', JSON.stringify({ ok: true }));
    return;
  }

  // P3b: GET /api/comments — returns stored comments as raw inline HTML
  if (req.method === 'GET' && pathname === '/api/comments') {
    // INTENTIONALLY UNSAFE — stored comment reflected into HTML without escaping
    const html = comments.map(c => `<li>${c}</li>`).join('\n');
    respond(res, 200, 'text/html', `<ul>${html}</ul>`);
    return;
  }

  // Reset endpoint — clears in-memory state
  if (req.method === 'POST' && pathname === '/__bughunter_reset') {
    comments = [];
    respond(res, 200, 'application/json', JSON.stringify({ reset: true }));
    return;
  }

  respond(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`xss-mini fixture listening on http://127.0.0.1:${PORT}\nREADY\n`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
