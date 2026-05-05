#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9603;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  '/rtl-high-certainty-overlap': html('rtl overlap', `
    window.__bh.pushRtlGeoFinding({
      kind: 'overlap', certainty: 'high',
      selector: 'header > .menu', pairSelector: '.user-name',
    });
  `),
  '/rtl-high-certainty-overflow': html('rtl overflow', `
    window.__bh.pushRtlGeoFinding({
      kind: 'overflow', certainty: 'high',
      selector: '.product-title',
    });
  `),
  '/rtl-low-certainty': html('rtl low certainty', `
    window.__bh.pushRtlGeoFinding({
      kind: 'overlap', certainty: 'low',
      selector: '.minor-element',
    });
  `),
  '/rtl-medium-certainty': html('rtl medium certainty', `
    window.__bh.pushRtlGeoFinding({
      kind: 'overflow', certainty: 'medium',
      selector: '.medium-element',
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
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`rtl-mini ready on port ${PORT}\n`));
