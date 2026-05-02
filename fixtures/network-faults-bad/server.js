#!/usr/bin/env node
// Synthetic network-fault fixture for v0.20 smoke tests.
// INTENTIONALLY BUGGY — for testing purposes only. Never deploy this.
//
// Four buggy routes, one per BugKind:
//   /optimistic   POST /api/todos  — optimistic success UI never reverts on network failure
//   /unhandled    POST /api/save   — no error UI shown when fetch silently fails
//   /loading      GET  /          — loading skeleton persists under offline (no timeout/error)
//   /retry-storm  POST /api/retry  — retry loop with no backoff (floods RPS)
//
// Each route serves a minimal HTML page with a button / form at #action-btn.

'use strict';

const http = require('node:http');

const PORT = process.env.NETWORK_FAULTS_BAD_PORT
  ? parseInt(process.env.NETWORK_FAULTS_BAD_PORT, 10)
  : 9995;

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// Route: optimistic UI that never reverts
// Bug: POST /api/todos appends the item to the DOM immediately; if the request
// fails, the DOM is never rolled back. Under an offline fault, the item stays.
const OPTIMISTIC_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>optimistic-bad</title></head>
<body>
<ul id="todos"></ul>
<form id="main-form">
  <input id="todo-input" type="text" name="text" value="New todo" />
  <button id="action-btn" type="submit">Add Todo</button>
</form>
<script>
  document.getElementById('main-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('todo-input').value;
    // BUG: optimistic update before the request completes
    const li = document.createElement('li');
    li.className = 'todo-item';
    li.textContent = text;
    document.getElementById('todos').appendChild(li);
    // BUG: no revert on failure
    try {
      await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (_) {
      // BUG: silently swallowed — no DOM revert, no error message
    }
  });
</script>
</body>
</html>`;

// Route: fetch with no error UI
// Bug: POST /api/save fires a request; if it fails, nothing is shown to the user.
const UNHANDLED_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>unhandled-bad</title></head>
<body>
<button id="action-btn">Save</button>
<div id="status"></div>
<script>
  document.getElementById('action-btn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'payload' }),
      });
      if (res.ok) {
        document.getElementById('status').textContent = 'Saved!';
      }
      // BUG: non-ok responses are silently ignored
    } catch (_) {
      // BUG: network errors are silently swallowed — no error UI
    }
  });
</script>
</body>
</html>`;

// Route: loading skeleton that never resolves
// Bug: under offline conditions the loading state never transitions; no timeout or
// error message is displayed.
const LOADING_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>loading-bad</title></head>
<body>
<div id="loading-spinner" aria-label="Loading..." role="status">Loading...</div>
<ul id="items"></ul>
<script>
  async function loadItems() {
    // BUG: no timeout, no error fallback
    const res = await fetch('/api/items');
    const data = await res.json();
    document.getElementById('loading-spinner').style.display = 'none';
    data.items.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      document.getElementById('items').appendChild(li);
    });
  }
  // Invoke on load but never show error if fetch fails
  loadItems().catch(() => {
    // BUG: spinner stays visible — no error state
  });
</script>
</body>
</html>`;

// Route: retry storm (no backoff)
// Bug: on failure, immediately retries in a tight loop with no delay or max attempts.
const RETRY_STORM_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>retry-storm-bad</title></head>
<body>
<button id="action-btn">Submit</button>
<div id="result"></div>
<script>
  document.getElementById('action-btn').addEventListener('click', async () => {
    let attempts = 0;
    // BUG: unbounded retry loop with no backoff
    while (attempts < 20) {
      try {
        const res = await fetch('/api/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (res.ok) {
          document.getElementById('result').textContent = 'Done!';
          return;
        }
      } catch (_) {
        // retry immediately
      }
      attempts++;
    }
    // BUG: even after exhausting retries, no error UI shown
  });
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET') {
    if (pathname === '/optimistic') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(OPTIMISTIC_PAGE);
      return;
    }
    if (pathname === '/unhandled') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(UNHANDLED_PAGE);
      return;
    }
    if (pathname === '/loading' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(LOADING_PAGE);
      return;
    }
    if (pathname === '/retry-storm') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(RETRY_STORM_PAGE);
      return;
    }
    if (pathname === '/api/items') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: ['item-1', 'item-2', 'item-3'] }));
      return;
    }
  }

  if (req.method === 'POST') {
    await parseBody(req);
    if (pathname === '/api/todos') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/api/save') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/api/retry') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`network-faults-bad fixture listening on http://127.0.0.1:${PORT}`);
});

module.exports = { server, PORT };
