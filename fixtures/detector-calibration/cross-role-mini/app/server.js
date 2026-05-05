#!/usr/bin/env node
// cross-role-mini — fixture for V56.4.13 (Bucket F) IDOR kinds:
// idor_horizontal, idor_horizontal_mutate, idor_vertical_role_escalate,
// idor_vertical_suspicious. Each route pushes an IDOR replay shape
// through window.__bh.pushIdorReplay; harness dispatches through production
// classifyIdorOutcome (modern) or applies the V05 rule (legacy) per shape.

'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9673;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- idor_horizontal_mutate (modern) ----
  '/horizontal-mutate-fires': html('horizontal mutate', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'mutating', status: 200,
        body: { id: 42, ok: true }, resourceType: 'order',
        idorConfig: undefined,
      },
    });
  `),

  // ---- idor_vertical_suspicious (modern) ----
  '/vertical-suspicious-fires': html('vertical suspicious', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'admin',
        sideEffectClass: 'safe', status: 200,
        body: { adminPanel: true }, resourceType: 'admin-data',
        idorConfig: undefined,
      },
    });
  `),

  // ---- idor_horizontal (legacy V05) ----
  '/legacy-horizontal-fires': html('legacy horizontal', `
    window.__bh.pushIdorReplay({
      shape: 'legacy_horizontal',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'safe', status: 200,
        body: { id: 7 }, resourceType: 'profile',
        idorConfig: undefined,
      },
    });
  `),

  // ---- idor_vertical_role_escalate (legacy V05) ----
  '/legacy-vertical-escalate-fires': html('legacy vertical escalate', `
    window.__bh.pushIdorReplay({
      shape: 'legacy_vertical_role_escalate',
      input: {
        sourceRole: 'alice', targetRole: 'alice',
        sideEffectClass: 'safe', status: 200,
        body: { adminUserList: [] }, resourceType: 'admin-tool',
        idorConfig: undefined,
      },
      toolId: 'admin_list_users',
      accessorRole: 'alice',
    });
  `),

  // ---- silent: 404 (status not 2xx) ----
  '/replay-404': html('replay 404', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'mutating', status: 404,
        body: { error: 'not found' }, resourceType: 'order',
        idorConfig: undefined,
      },
    });
  `),

  // ---- silent: empty body ----
  '/replay-empty-body': html('replay empty', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'mutating', status: 200,
        body: { data: [] }, resourceType: 'order',
        idorConfig: undefined,
      },
    });
  `),

  // ---- silent: 429 rate-limit ----
  '/replay-429': html('replay 429', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'safe', status: 429,
        body: { error: 'rate-limited' }, resourceType: 'order',
        idorConfig: undefined,
      },
    });
  `),

  // ---- silent: external sideEffectClass ----
  '/replay-external': html('replay external', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'bob',
        sideEffectClass: 'external', status: 200,
        body: { ok: true }, resourceType: 'webhook',
        idorConfig: undefined,
      },
    });
  `),

  // ---- silent: legitimized hierarchy suppresses ----
  '/replay-legitimized': html('replay legitimized', `
    window.__bh.pushIdorReplay({
      shape: 'modern',
      input: {
        sourceRole: 'alice', targetRole: 'admin',
        sideEffectClass: 'safe', status: 200,
        body: { ok: true }, resourceType: 'profile',
        idorConfig: { legitimizedHierarchies: [{ from: 'admin', to: 'alice' }] },
      },
    });
  `),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`cross-role-mini ready on port ${PORT}\n`);
});
