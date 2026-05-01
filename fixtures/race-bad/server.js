#!/usr/bin/env node
// Synthetic race-condition fixture for v0.19 smoke tests.
// INTENTIONALLY BUGGY — for testing purposes only. Never deploy this.
//
// Demonstrates one race-condition bug per sub-kind:
//   double_submit:          POST /api/items — accepts duplicate submissions (no idempotency key)
//   click_then_navigate:    POST /api/save  — in-flight request is silently dropped on abandon
//   optimistic_revert:      POST /api/like  — forced-500 path returns 500, UI has no revert logic
//   interleaved_mutations:  POST /api/counter/increment + /api/counter/decrement — non-atomic read-modify-write
//   cross_tab:              POST /api/vote  — last-write-wins, no conflict detection
//
// Each route serves a minimal HTML page with a submit button at #submit-btn.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.RACE_BAD_PORT ? parseInt(process.env.RACE_BAD_PORT, 10) : 9994;

// In-memory state
let itemCount = 0;
let counterValue = 0;
let likeCount = 0;
let voteCount = 0;

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function html(body, formAction) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>race-bad</title></head>
<body>
<form id="main-form" method="POST" action="${formAction}">
  <button id="submit-btn" type="submit">Submit</button>
</form>
<div id="result"></div>
<script>
  document.getElementById('main-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch(e.target.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const text = await res.text();
    document.getElementById('result').textContent = res.ok ? 'success saved' : 'error: ' + text;
  });
</script>
</body>
</html>`;
}

function respond(res, status, body, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // --- GET routes: serve HTML pages ---

  if (req.method === 'GET' && pathname === '/double-submit') {
    respond(res, 200, html('double-submit: POST /api/items', '/api/items'), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathname === '/click-navigate') {
    respond(res, 200, html('click-then-navigate: POST /api/save', '/api/save'), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathname === '/optimistic-revert') {
    respond(res, 200, html('optimistic-revert: POST /api/like', '/api/like'), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathname === '/interleaved') {
    respond(res, 200, html('interleaved: POST /api/counter/increment', '/api/counter/increment'), 'text/html');
    return;
  }
  if (req.method === 'GET' && pathname === '/cross-tab') {
    respond(res, 200, html('cross-tab: POST /api/vote', '/api/vote'), 'text/html');
    return;
  }

  // --- POST routes: the buggy APIs ---

  if (req.method === 'POST' && pathname === '/api/items') {
    // BUG: double_submit — no idempotency check, every POST creates a new item
    await parseBody(req);
    itemCount++;
    respond(res, 201, { id: itemCount, created: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/save') {
    // BUG: click_then_navigate — slow response (200ms) so the caller can navigate away first;
    // the server processes it but the client never sees the response
    await parseBody(req);
    await new Promise(r => { setTimeout(r, 200); });
    respond(res, 200, { saved: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/like') {
    // BUG: optimistic_revert — when X-Force-Fail header present, returns 500
    // The UI shows optimistic success but never reverts on failure
    if (req.headers['x-force-fail'] === '1') {
      respond(res, 500, { error: 'forced failure' });
      return;
    }
    likeCount++;
    respond(res, 200, { likes: likeCount });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/counter/increment') {
    // BUG: interleaved_mutations — non-atomic read-modify-write
    const snapshot = counterValue;
    await new Promise(r => { setTimeout(r, 10); }); // artificial delay for interleaving
    counterValue = snapshot + 1;
    respond(res, 200, { value: counterValue });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/counter/decrement') {
    // BUG: interleaved_mutations — non-atomic read-modify-write (sibling to increment)
    const snapshot = counterValue;
    await new Promise(r => { setTimeout(r, 10); });
    counterValue = snapshot - 1;
    respond(res, 200, { value: counterValue });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/vote') {
    // BUG: cross_tab — last-write-wins, no conflict detection between tabs
    await parseBody(req);
    voteCount++;
    respond(res, 200, { votes: voteCount });
    return;
  }

  // Health check
  if (req.method === 'GET' && pathname === '/health') {
    respond(res, 200, { ok: true });
    return;
  }

  respond(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`race-bad fixture listening on http://127.0.0.1:${PORT}\n`);
});
