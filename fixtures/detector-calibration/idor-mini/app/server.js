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
  // Numeric IDs (easier to iterate via increment — edge shape: numeric-id-iteration)
  '1001': { id: '1001', owner: 'alice', total: 15.00, item: 'notebook' },
  '1002': { id: '1002', owner: 'bob',   total: 27.50, item: 'pen'      },
};

// UUID-keyed orders — same missing ownership check, but harder to enumerate by brute-force
// (edge shape: uuid-iteration)
const UUID_ORDERS = {
  '01HW9XMKQ2P8VB3N5T6R7YCF4A': { id: '01HW9XMKQ2P8VB3N5T6R7YCF4A', owner: 'alice', total: 88.00, item: 'keyboard' },
  '01HW9XMKQ2P8VB3N5T6R7YCF4B': { id: '01HW9XMKQ2P8VB3N5T6R7YCF4B', owner: 'bob',   total: 55.00, item: 'mouse'    },
};

// Protected orders — GET enforces ownership (no read-IDOR); PUT/DELETE also enforce ownership.
// Used for the negative case (alice reading alice-protected-1 is legitimate) and for
// confirming that read-IDOR fires when alice accesses bob-protected-1.
const PROTECTED_ORDERS = {
  'alice-protected-1': { id: 'alice-protected-1', owner: 'alice', total: 10.00, item: 'sticker' },
  'bob-protected-1':   { id: 'bob-protected-1',   owner: 'bob',   total: 20.00, item: 'badge'   },
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

  // Edge: GET /api/orders/uuid/:id — UUIDv7-keyed orders.
  // PLANT: same missing ownership check as P1, but harder to iterate.
  // Must be matched before the generic /api/orders/:id route.
  const uuidOrderMatch = pathname.match(/^\/api\/orders\/uuid\/([^/]+)$/);
  if (uuidOrderMatch && req.method === 'GET') {
    const order = UUID_ORDERS[uuidOrderMatch[1]];
    if (!order) { json(res, 404, { error: 'not found' }); return; }
    // INTENTIONALLY MISSING: if (order.owner !== user.id) { return 403; }
    json(res, 200, order);
    return;
  }

  // Correctly secured: GET /api/orders/protected/:id enforces ownership on reads.
  // PUT/DELETE also check ownership. Used for negative and read-with-403-on-mutate-only shapes.
  const protectedOrderMatch = pathname.match(/^\/api\/orders\/protected\/([^/]+)$/);
  if (protectedOrderMatch) {
    const order = PROTECTED_ORDERS[protectedOrderMatch[1]];
    if (!order) { json(res, 404, { error: 'not found' }); return; }
    if (order.owner !== user.id) { json(res, 403, { error: 'forbidden' }); return; }
    if (req.method === 'GET') { json(res, 200, order); return; }
    if (req.method === 'PUT' || req.method === 'DELETE') { json(res, 200, { ok: true }); return; }
  }

  // P1: GET /api/orders/:id (numeric and named IDs)
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
