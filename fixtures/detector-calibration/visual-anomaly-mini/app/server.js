#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9623;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  '/visual-major': html('major', `
    window.__bh.pushVisualAnomaly({
      description: 'Logo overlaps headline', severity: 'major',
      category: 'overlap', element: 'header > .logo',
    });
  `),
  '/visual-critical': html('critical', `
    window.__bh.pushVisualAnomaly({
      description: 'Pay button hidden behind cookie banner', severity: 'critical',
      category: 'occlusion', element: '#pay-button',
    });
  `),
  '/visual-minor': html('minor', `
    window.__bh.pushVisualAnomaly({
      description: 'Slight padding inconsistency', severity: 'minor',
      category: 'spacing', element: '.card',
    });
  `),
  '/visual-invalid-severity': html('invalid severity', `
    window.__bh.pushVisualAnomaly({
      description: 'unknown severity', severity: 'fatal',
      category: 'overlap', element: '.x',
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
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`visual-anomaly-mini ready on port ${PORT}\n`));
