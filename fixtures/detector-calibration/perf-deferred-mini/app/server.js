#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9543;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- unbounded_list_render ----
  '/unbounded-list-fires': html('unbounded list fires', `
    window.__bh.pushSentinelEvent({
      kind: 'unbounded_list_render', severity: 'major',
      rootCause: 'List at /feed rendered 12543 DOM nodes without virtualization (threshold: 500)',
    });
  `),
  '/unbounded-list-silent': html('unbounded list silent', '/* no sentinel — list virtualized */'),

  // ---- oversized_bundle ----
  '/oversized-bundle-fires': html('oversized bundle fires', `
    window.__bh.pushSentinelEvent({
      kind: 'oversized_bundle', severity: 'major',
      rootCause: 'JS bundle main.js is 4.2MB gzipped (threshold: 500KB) — no code splitting detected',
    });
  `),
  '/oversized-bundle-silent': html('oversized bundle silent', '/* no sentinel — bundle within limit */'),

  // ---- excessive_re_renders ----
  '/excessive-renders-fires': html('excessive re-renders fires', `
    window.__bh.pushSentinelEvent({
      kind: 'excessive_re_renders', severity: 'minor',
      rootCause: 'Component <UserList> re-rendered 87 times during 3s interaction (threshold: 20)',
    });
  `),
  '/excessive-renders-silent': html('excessive re-renders silent', '/* no sentinel — render count acceptable */'),

  // ---- memory_leak_suspected ----
  '/memory-leak-suspected-fires': html('memory leak suspected fires', `
    window.__bh.pushSentinelEvent({
      kind: 'memory_leak_suspected', severity: 'major',
      rootCause: 'Heap grew from 45MB to 312MB over 50-iteration stress loop at /dashboard — no GC recovery',
    });
  `),
  '/memory-leak-suspected-silent': html('memory leak suspected silent', '/* no sentinel — heap stable */'),

  // ---- memory_leak_attributed ----
  '/memory-leak-attributed-fires': html('memory leak attributed fires', `
    window.__bh.pushSentinelEvent({
      kind: 'memory_leak_attributed', severity: 'major',
      rootCause: 'Detached DOM subtree retaining 18MB attributed to event listener on removed <DataGrid> component',
    });
  `),
  '/memory-leak-attributed-silent': html('memory leak attributed silent', '/* no sentinel — no attribution */'),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`perf-deferred-mini ready on port ${PORT}\n`));
