#!/usr/bin/env node
// INTENTIONALLY VULNERABLE idor-mini fixture.
// Plants: idor_horizontal_read — bearer-token auth, no ownership check on resource reads.
// DO NOT DEPLOY to any public network.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9978;

// Seed users and their resources
const USERS = {
  'alice-token': { id: 'alice', name: 'Alice' },
  'bob-token':   { id: 'bob',   name: 'Bob'   },
};

const ORDERS = {
  'alice-order-1': { id: 'alice-order-1', owner: 'alice', total: 42.00, item: 'widget' },
  'bob-order-1':   { id: 'bob-order-1',   owner: 'bob',   total: 99.50, item: 'gadget' },
};

const PROFILES = {
  alice: { id: 'alice', name: 'Alice', email: 'alice@example.com', role: 'member' },
  bob:   { id: 'bob',   name: 'Bob',   email: 'bob@example.com',   role: 'member' },
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

function resolveBearer(req) {
  const auth = req.headers.authorization ?? '';
  const match = auth.match(/^Bearer (.+)$/i);
  if (!match) return null;
  return USERS[match[1]] ?? null;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname === '/__bughunter_reset') {
    text(res, 200, 'ok');
    return;
  }

  if (pathname === '/') {
    text(res, 200, 'idor-mini fixture');
    return;
  }

  // Authenticate all API routes
  const user = resolveBearer(req);
  if (pathname.startsWith('/api/') && user === null) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  // P1: GET /api/orders/:id
  // PLANT: no ownership check — any authenticated user can read any order.
  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && req.method === 'GET') {
    const order = ORDERS[orderMatch[1]];
    if (!order) { json(res, 404, { error: 'not found' }); return; }
    // INTENTIONALLY MISSING: if (order.owner !== user.id) { return 403; }
    json(res, 200, order);
    return;
  }

  // P2: GET /api/users/:id/profile
  // PLANT: no check that req user matches path user.
  const profileMatch = pathname.match(/^\/api\/users\/([^/]+)\/profile$/);
  if (profileMatch && req.method === 'GET') {
    const profile = PROFILES[profileMatch[1]];
    if (!profile) { json(res, 404, { error: 'not found' }); return; }
    // INTENTIONALLY MISSING: if (profileMatch[1] !== user.id) { return 403; }
    json(res, 200, profile);
    return;
  }

  text(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`idor-mini ready on port ${PORT}\n`);
});
