#!/usr/bin/env node
// audit-log-mini — fixture for audit_log_missing_for_mutation.
//
// Production detector uses DB invariants (post-mutation log row count).
// Harness model: probe issues a mutating request, then GETs /audit/recent
// and checks whether an audit-log entry references the mutated route.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9813;

// In-memory audit log
let auditLog = [];

function appendAudit(entry) { auditLog.push({ ...entry, ts: Date.now() }); }

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/__bughunter_reset') {
    auditLog = [];
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname === '/audit/recent' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(auditLog));
    return;
  }

  // Helper: respond OK and optionally log
  function respondOk(logged) {
    if (logged) appendAudit({ route: pathname, method });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  // Positive: mutating route that does NOT log to audit
  if (pathname === '/api/posts/delete' && method === 'POST') return respondOk(false);
  if (pathname === '/api/users/update' && method === 'PUT') return respondOk(false);
  // Negative: mutating routes that DO log
  if (pathname === '/api/payments/charge' && method === 'POST') return respondOk(true);
  if (pathname === '/api/admin/grant-role' && method === 'POST') return respondOk(true);
  // Edge: read-only route — no audit needed (probed but not mutating)
  if (pathname === '/api/users/list' && method === 'GET') return respondOk(false);
  // Edge: mutating route that logs to a DIFFERENT route name (audit pattern works on any logged entry)
  if (pathname === '/api/orders/cancel' && method === 'POST') {
    appendAudit({ route: '/orders/cancel-event', method: 'INTERNAL' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`audit-log-mini ready on port ${PORT}\n`);
});
