#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9513;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- viewport_100vh_break ----
  '/viewport-vh-fires': html('viewport 100vh fires', `
    window.__bh.pushSentinelEvent({
      kind: 'viewport_100vh_break', severity: 'minor',
      rootCause: 'Element with height:100vh overflows on iOS Safari — mobile browser address bar not accounted for (use 100dvh or env(safe-area-inset))',
    });
  `),
  '/viewport-vh-silent': html('viewport 100vh silent', '/* no sentinel — viewport height handled correctly */'),

  // ---- soft_keyboard_occlusion ----
  '/soft-keyboard-fires': html('soft keyboard fires', `
    window.__bh.pushSentinelEvent({
      kind: 'soft_keyboard_occlusion', severity: 'minor',
      rootCause: 'Input field #email-input occluded by soft keyboard on Android — no scroll or resize handling observed',
    });
  `),
  '/soft-keyboard-silent': html('soft keyboard silent', '/* no sentinel — input scrolled into view on keyboard open */'),

  // ---- orientation_change_layout_break ----
  '/orientation-break-fires': html('orientation change fires', `
    window.__bh.pushSentinelEvent({
      kind: 'orientation_change_layout_break', severity: 'minor',
      rootCause: 'Portrait→landscape orientation change: fixed-width .sidebar 280px overflows 375px landscape viewport',
    });
  `),
  '/orientation-break-silent': html('orientation break silent', '/* no sentinel — layout reflows on orientation change */'),

  // ---- pull_to_refresh_conflict ----
  '/pull-refresh-fires': html('pull to refresh fires', `
    window.__bh.pushSentinelEvent({
      kind: 'pull_to_refresh_conflict', severity: 'minor',
      rootCause: 'Custom pull-to-refresh gesture conflicts with browser native pull-to-refresh — both fire simultaneously, causing double reload',
    });
  `),
  '/pull-refresh-silent': html('pull to refresh silent', '/* no sentinel — pull gesture handled cleanly */'),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`mobile-responsive-mini ready on port ${PORT}\n`));
