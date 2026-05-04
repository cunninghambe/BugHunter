// auth-bypass-mini — Express fixture server.
// Intentionally exposes admin/authenticated routes without auth checks.
// Plants two auth_bypass_via_unauthed_route vulnerabilities:
//   P1: GET /api/admin/users — should require admin auth, accepts anonymous
//   P2: GET /api/orders     — should require auth, accepts anonymous
// DO NOT deploy this server to any public network.

'use strict';

const http = require('http');
const PORT = parseInt(process.env.AUTH_BYPASS_PORT ?? '9976', 10);

// Minimal in-memory state — reset via POST /__bughunter_reset
const USERS = [
  { id: 1, email: 'alice@example.com', role: 'admin' },
  { id: 2, email: 'bob@example.com', role: 'member' },
];

const ORDERS = [
  { id: 'ord-1', userId: 2, total: 42.00 },
  { id: 'ord-2', userId: 2, total: 7.99 },
];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // POST /__bughunter_reset — restore state
  if (method === 'POST' && url === '/__bughunter_reset') {
    json(res, 200, { ok: true });
    return;
  }

  // GET /health
  if (method === 'GET' && url === '/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // GET /healthz — public by design, no sensitive data
  if (method === 'GET' && url === '/healthz') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // GET /api/items — returns 200 but filters by user; anonymous gets empty list.
  // Not a bypass: no data is leaked. Detector fires at info severity (potential, not confirmed).
  if (method === 'GET' && url === '/api/items') {
    const auth = req.headers['authorization'];
    const userId = auth ? 2 : null;
    const items = userId === null ? [] : [{ id: 'item-1', userId: 2, name: 'Widget' }];
    json(res, 200, { items });
    return;
  }

  // P1: GET /api/admin/users
  // BUG: no auth check — should require admin session/token but doesn't.
  if (method === 'GET' && url === '/api/admin/users') {
    json(res, 200, { users: USERS });
    return;
  }

  // P2: GET /api/orders
  // BUG: no auth check — should require authenticated session but doesn't.
  if (method === 'GET' && url === '/api/orders') {
    json(res, 200, { orders: ORDERS });
    return;
  }

  // P3: POST /api/users/:id/role/admin (optional plant)
  // BUG: escalates any user to admin without checking that caller is admin.
  const roleEscMatch = url.match(/^\/api\/users\/(\d+)\/role\/admin$/);
  if (method === 'POST' && roleEscMatch !== null) {
    const userId = parseInt(roleEscMatch[1], 10);
    const user = USERS.find(u => u.id === userId);
    if (user === undefined) {
      json(res, 404, { error: 'user not found' });
      return;
    }
    user.role = 'admin';
    json(res, 200, { user });
    return;
  }

  // Authenticated route that correctly returns 401 for anonymous
  if (method === 'GET' && url === '/api/me') {
    const auth = req.headers['authorization'];
    if (!auth) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    json(res, 200, { user: USERS[0] });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`auth-bypass-mini ready on port ${PORT}\n`);
});
