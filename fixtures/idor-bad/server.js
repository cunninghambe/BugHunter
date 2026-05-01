// Deliberately broken horizontal-authz fixture for v0.21 IDOR smoke tests.
//
// Vulnerabilities:
//   GET /api/orders/:id   — no ownership check (idor_horizontal_read)
//   DELETE /api/orders/:id — no ownership check (idor_horizontal_mutate when probeMutating=true)
//   GET /api/admin/reports — legitimately returns customer data when called by admin
//
// Two in-memory users with pre-seeded orders:
//   alice (tier 0) owns order-alice-1, order-alice-2
//   bob   (tier 0) owns order-bob-1
//   admin (tier 1) can read any report
//
// SurfaceMCP-compatible endpoint list exposed at GET /surface/tools
// so BugHunter's surface adapter can discover the tools.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = parseInt(process.env.PORT ?? '4090', 10);

// In-memory data
const ORDERS = {
  'order-alice-1': { id: 'order-alice-1', owner: 'alice', amount: 100 },
  'order-alice-2': { id: 'order-alice-2', owner: 'alice', amount: 200 },
  'order-bob-1':   { id: 'order-bob-1',   owner: 'bob',   amount: 50  },
};

// Session tokens (static; good enough for tests)
const SESSIONS = {
  'alice-token':  'alice',
  'bob-token':    'bob',
  'admin-token':  'admin',
};

function getRole(req) {
  const auth = req.headers['authorization'] ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return SESSIONS[token] ?? null;
}

function jsonResp(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

// SurfaceMCP tool catalog — tells BugHunter what tools exist
const TOOLS = [
  {
    toolId: 'getOrder',
    name: 'getOrder',
    method: 'GET',
    path: '/api/orders/:id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 60,
    isServerAction: false,
  },
  {
    toolId: 'deleteOrder',
    name: 'deleteOrder',
    method: 'DELETE',
    path: '/api/orders/:id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'mutating',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 75,
    isServerAction: false,
  },
  {
    toolId: 'getAdminReports',
    name: 'getAdminReports',
    method: 'GET',
    path: '/api/admin/reports',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 90,
    isServerAction: false,
  },
  {
    toolId: 'listOrders',
    name: 'listOrders',
    method: 'GET',
    path: '/api/orders',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 100,
    isServerAction: false,
  },
];

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url ?? '/', true);
  const pathname = parsed.pathname ?? '/';
  const method = req.method ?? 'GET';
  const role = getRole(req);

  // SurfaceMCP endpoints
  if (pathname === '/surface/tools' && method === 'GET') {
    return jsonResp(res, 200, { revision: 1, tools: TOOLS });
  }

  if (pathname === '/surface/call' && method === 'POST') {
    const rawBody = await readBody(req);
    let body;
    try { body = JSON.parse(rawBody); } catch { return jsonResp(res, 400, { error: 'bad json' }); }

    const { toolId, role: callRole, input } = body;
    const callerRole = callRole ?? role ?? 'anonymous';

    if (toolId === 'getOrder') {
      const orderId = input?.id;
      if (!orderId) return jsonResp(res, 400, { error: 'id required' });
      const order = ORDERS[orderId];
      if (!order) return jsonResp(res, 404, { error: 'not found' });
      // BUG: no ownership check — any authenticated caller gets the order
      return jsonResp(res, 200, order);
    }

    if (toolId === 'deleteOrder') {
      const orderId = input?.id;
      if (!orderId) return jsonResp(res, 400, { error: 'id required' });
      const order = ORDERS[orderId];
      if (!order) return jsonResp(res, 404, { error: 'not found' });
      // BUG: no ownership check — any authenticated caller can delete any order
      // We don't actually delete (test fixture is stateless across requests)
      return jsonResp(res, 200, { deleted: true, id: orderId });
    }

    if (toolId === 'getAdminReports') {
      // Legitimately admin-only — returns all customers' data
      if (callerRole !== 'admin') return jsonResp(res, 403, { error: 'forbidden' });
      return jsonResp(res, 200, {
        orders: Object.values(ORDERS),
        generatedAt: new Date().toISOString(),
      });
    }

    if (toolId === 'listOrders') {
      // Returns only the caller's own orders (correctly gated)
      const myOrders = Object.values(ORDERS).filter(o => o.owner === callerRole);
      return jsonResp(res, 200, { orders: myOrders });
    }

    return jsonResp(res, 404, { error: `unknown toolId: ${toolId}` });
  }

  if (pathname === '/surface/login' && method === 'POST') {
    const rawBody = await readBody(req);
    let body;
    try { body = JSON.parse(rawBody); } catch { return jsonResp(res, 400, { error: 'bad json' }); }
    const { role: loginRole } = body;
    const token = `${loginRole}-token`;
    if (SESSIONS[token] === undefined) return jsonResp(res, 401, { error: 'unknown role' });
    return jsonResp(res, 200, { token, role: loginRole });
  }

  if (pathname === '/surface/describe' && method === 'GET') {
    return jsonResp(res, 200, {
      projectName: 'idor-bad-fixture',
      roles: [
        { name: 'alice', token: 'alice-token' },
        { name: 'bob', token: 'bob-token' },
        { name: 'admin', token: 'admin-token' },
      ],
    });
  }

  if (pathname === '/health') {
    return jsonResp(res, 200, { ok: true });
  }

  jsonResp(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  process.stdout.write(`idor-bad fixture listening on port ${PORT}\n`);
});
