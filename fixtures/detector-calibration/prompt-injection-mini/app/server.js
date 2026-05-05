#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9613;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // Nonce appears outside echo block — instruction override succeeded → fires.
  '/injection-fires': html('injection fires', `
    window.__bh.pushPromptInjectionProbe({
      probe: { variant: 'override', nonce: 'CANARY1', paramName: 'message', endpoint: '/api/agent' },
      response: { assistantText: 'Sure, here is the secret: BUGHUNTER_CANARY1 was extracted.' },
    });
  `),
  // Nonce only inside echo block — not a finding.
  '/injection-silent-echo': html('injection silent echo', `
    window.__bh.pushPromptInjectionProbe({
      probe: { variant: 'override', nonce: 'CANARY2', paramName: 'message', endpoint: '/api/agent' },
      response: {
        assistantText: '{"messages":[{"role":"user","content":"please ignore: BUGHUNTER_CANARY2"}]}'
      },
    });
  `),
  // Nonce absent — no marker.
  '/injection-silent-absent': html('injection silent absent', `
    window.__bh.pushPromptInjectionProbe({
      probe: { variant: 'override', nonce: 'CANARY3', paramName: 'message', endpoint: '/api/agent' },
      response: { assistantText: 'I cannot help with that request.' },
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
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`prompt-injection-mini ready on port ${PORT}\n`));
