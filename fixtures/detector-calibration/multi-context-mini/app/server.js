#!/usr/bin/env node
// multi-context-mini — fixture for V56.4.13 (Bucket F) multi_context_state_divergence.
// Pushes (StateDivergencePlan, observationsByContext) via setMultiContextDivergence.

'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9653;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const obs = (overrides) => Object.assign({
  offsetMs: 0, url: 'http://x', consoleErrorCount: 0,
  targetSelectorHash: 'h0', toastVisible: false, targetSelectorState: 'pre',
}, overrides);

const ROUTES = {
  // ---- divergence fires (3 contexts, 2 different final hashes) ----
  '/divergence-fires': html('divergence', `
    window.__bh.setMultiContextDivergence({
      plan: { variant: { kind: 'state_divergence', n: 3, settleMs: 5000 }, toolId: 'update-counter', toolPath: '/api/counter', pageRoute: '/counter' },
      observationsByContext: [
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-A', targetSelectorState: 'final' }))}],
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-B', targetSelectorState: 'final' }))}],
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-A', targetSelectorState: 'final' }))}],
      ],
    });
  `),

  // ---- silent: all contexts agree ----
  '/divergence-silent': html('divergence silent', `
    window.__bh.setMultiContextDivergence({
      plan: { variant: { kind: 'state_divergence', n: 3, settleMs: 5000 }, toolId: 'update-counter', toolPath: '/api/counter', pageRoute: '/counter' },
      observationsByContext: [
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' }))}],
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' }))}],
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' }))}],
      ],
    });
  `),

  // ---- silent: missing observations on one context (returns null) ----
  '/divergence-missing-obs': html('divergence missing obs', `
    window.__bh.setMultiContextDivergence({
      plan: { variant: { kind: 'state_divergence', n: 3, settleMs: 5000 }, toolId: 'update-counter', toolPath: '/api/counter', pageRoute: '/counter' },
      observationsByContext: [
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-A', targetSelectorState: 'final' }))}],
        [],
        [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-A', targetSelectorState: 'final' }))}],
      ],
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
  process.stdout.write(`multi-context-mini ready on port ${PORT}\n`);
});
