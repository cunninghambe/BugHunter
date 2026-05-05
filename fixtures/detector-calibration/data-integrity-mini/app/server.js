#!/usr/bin/env node
// data-integrity-mini — fixture for data_integrity_orphan and soft_delete_consistency.
// In-memory store of two related entities (parents and their children) with
// configurable orphan / soft-delete behavior per route.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9803;

// State per route
let state = {};

function reset() {
  state = {
    'orphan-cascade': { parents: [{ id: 1 }], children: [{ id: 10, parentId: 1 }] },
    'orphan-broken': { parents: [{ id: 1 }], children: [{ id: 10, parentId: 1 }] },
    'soft-delete-consistent': { items: [{ id: 1, deletedAt: null }] },
    'soft-delete-inconsistent': { items: [{ id: 1, deletedAt: null }] },
  };
}
reset();

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
    reset();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // ---- data_integrity_orphan ----
  // Positive: deleting parent leaves children orphaned (broken integrity)
  if (pathname === '/api/orphan-broken/delete-parent' && method === 'POST') {
    const before = state['orphan-broken'];
    before.parents = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Negative: cascade-delete keeps integrity (no orphans after delete)
  if (pathname === '/api/orphan-cascade/delete-parent' && method === 'POST') {
    const s = state['orphan-cascade'];
    s.parents = [];
    s.children = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Read endpoints — return current state for the route's set
  if (pathname.startsWith('/api/orphan-') && method === 'GET') {
    const key = pathname.slice('/api/'.length).split('/')[0];
    const s = state[key];
    if (s !== undefined) {
      const orphans = s.children.filter((c) => !s.parents.some((p) => p.id === c.parentId));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ parents: s.parents, children: s.children, orphans }));
      return;
    }
  }

  // ---- soft_delete_consistency ----
  // Positive: soft-delete sets deletedAt but the item still appears in the GET list
  if (pathname === '/api/soft-delete-inconsistent/delete' && method === 'POST') {
    const s = state['soft-delete-inconsistent'];
    s.items = s.items.map((it) => ({ ...it, deletedAt: Date.now() }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Negative: soft-delete works correctly (item filtered from list)
  if (pathname === '/api/soft-delete-consistent/delete' && method === 'POST') {
    const s = state['soft-delete-consistent'];
    s.items = s.items.map((it) => ({ ...it, deletedAt: Date.now() }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // List endpoints
  if (pathname === '/api/soft-delete-inconsistent/list' && method === 'GET') {
    // Bug: returns ALL items including soft-deleted ones
    const s = state['soft-delete-inconsistent'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: s.items }));
    return;
  }
  if (pathname === '/api/soft-delete-consistent/list' && method === 'GET') {
    // Correct: filters soft-deleted items
    const s = state['soft-delete-consistent'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: s.items.filter((it) => it.deletedAt === null) }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`data-integrity-mini ready on port ${PORT}\n`);
});
