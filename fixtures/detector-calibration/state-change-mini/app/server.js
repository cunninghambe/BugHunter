#!/usr/bin/env node
// state-change-mini — fixture for V56.4.11 (Bucket B remainder):
// missing_state_change + surface_call_failed.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9683;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() {
  if (!window.__bh) return;
  ${injectScript}
}, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- missing_state_change: action with no observable effect ----
  '/missing-no-effect': html('missing — no effect', `
    window.__bh.setMissingStateChangeInput({
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0 },
      post: {
        url: '/page', title: 'Page', consoleErrors: [],
        networkRequests: [], domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
      },
      action: { kind: 'click', selector: '#do-thing', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // /url-changed — silent: URL changed in post; classifier returns null
  '/url-changed': html('url changed', `
    window.__bh.setMissingStateChangeInput({
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0 },
      post: {
        url: '/page/done', title: 'Done', consoleErrors: [],
        networkRequests: [], domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
      },
      action: { kind: 'click', selector: '#do-thing', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // /network-completed — silent: network request fired
  '/network-completed': html('network completed', `
    window.__bh.setMissingStateChangeInput({
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0 },
      post: {
        url: '/page', title: 'Page', consoleErrors: [],
        networkRequests: [{ method: 'POST', path: '/api/save', status: 200, duration: 30 }],
        domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
      },
      action: { kind: 'click', selector: '#save', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // /aria-popover — silent: aria-expanded flipped → portal opened
  '/aria-popover': html('aria popover', `
    window.__bh.setMissingStateChangeInput({
      pre: {
        url: '/page', title: 'Page', consoleErrorCount: 0,
        ariaSnapshot: { expanded: false, haspopup: true, controls: 'menu-1' },
      },
      post: {
        url: '/page', title: 'Page', consoleErrors: [],
        networkRequests: [], domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
        ariaSnapshot: { expanded: true, haspopup: true, controls: 'menu-1' },
      },
      action: { kind: 'click', selector: '#trigger', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // /portal-appeared — silent: newPortalCount > 0
  '/portal-appeared': html('portal appeared', `
    window.__bh.setMissingStateChangeInput({
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0 },
      post: {
        url: '/page', title: 'Page', consoleErrors: [],
        networkRequests: [], domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
        newPortalCount: 1,
      },
      action: { kind: 'click', selector: '#trigger', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // /render-action — silent: kind === 'render'
  '/render-action': html('render action', `
    window.__bh.setMissingStateChangeInput({
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0 },
      post: {
        url: '/page', title: 'Page', consoleErrors: [],
        networkRequests: [], domErrorTextDetected: false,
        mutationObserverWindowMs: 1500,
      },
      action: { kind: 'render', via: 'browser', expectedOutcome: 'success', palette: 'happy' },
    });
  `),

  // ---- surface_call_failed ----
  '/surface-fail-404': html('surface 404', `
    window.__bh.pushSurfaceCallResult({
      ok: false, status: 404, palette: 'happy',
      toolId: 'get_user', endpoint: 'GET /users/:id',
      errorMessage: 'User not found',
    });
  `),
  '/surface-fail-422': html('surface 422', `
    window.__bh.pushSurfaceCallResult({
      ok: false, status: 422, palette: 'happy',
      toolId: 'create_post', endpoint: 'POST /posts',
      errorMessage: 'Title required',
    });
  `),

  // /surface-edge-skip — palette 'edge' → silent (only happy palette fires)
  '/surface-edge-skip': html('surface edge skip', `
    window.__bh.pushSurfaceCallResult({
      ok: false, status: 400, palette: 'edge',
      toolId: 'create_post', endpoint: 'POST /posts',
    });
  `),

  // /surface-validation-rejection — silent (mutator validation rejection)
  '/surface-validation-rejection': html('surface validation rejection', `
    window.__bh.pushSurfaceCallResult({
      ok: false, status: 400, palette: 'happy',
      toolId: 'create_post', endpoint: 'POST /posts',
      isValidationRejection: true,
    });
  `),

  // /surface-5xx-skip — silent (5xx handled by network_5xx, not surface_call_failed)
  '/surface-5xx-skip': html('surface 5xx skip', `
    window.__bh.pushSurfaceCallResult({
      ok: false, status: 500, palette: 'happy',
      toolId: 'create_post', endpoint: 'POST /posts',
    });
  `),

  '/surface-ok': html('surface ok', `
    window.__bh.pushSurfaceCallResult({
      ok: true, status: 200, palette: 'happy',
      toolId: 'get_user', endpoint: 'GET /users/:id',
    });
  `),

  '/clean': html('clean', `/* nothing */`),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const body = ROUTES[pathname];
  if (body !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`state-change-mini ready on port ${PORT}\n`);
});
