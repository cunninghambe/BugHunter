#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9633;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- service_worker_stale ----
  '/sw-stale-installing': html('sw stale installing', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'service_worker_stale', scope: '/app',
      ageMs: 60000, hasInstalling: true, hasWaiting: false,
      isFirstVisit: false, controllerChangedDuringWindow: false,
      thresholdMs: 30000,
    });
  `),
  '/sw-silent-first-visit': html('sw first-visit skip', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'service_worker_stale', scope: '/app',
      ageMs: 60000, hasInstalling: true, hasWaiting: false,
      isFirstVisit: true, controllerChangedDuringWindow: false,
      thresholdMs: 30000,
    });
  `),
  '/sw-silent-controller-changed': html('sw controller changed', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'service_worker_stale', scope: '/app',
      ageMs: 60000, hasInstalling: true, hasWaiting: false,
      isFirstVisit: false, controllerChangedDuringWindow: true,
      thresholdMs: 30000,
    });
  `),
  '/sw-silent-under-threshold': html('sw under threshold', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'service_worker_stale', scope: '/app',
      ageMs: 5000, hasInstalling: true, hasWaiting: false,
      isFirstVisit: false, controllerChangedDuringWindow: false,
      thresholdMs: 30000,
    });
  `),

  // ---- web_worker_error ----
  '/worker-error-fires': html('worker error', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'web_worker_error', scriptUrl: '/workers/calc.js',
      eventKind: 'error', errorMsg: 'Uncaught ReferenceError: foo is not defined',
    });
  `),
  '/worker-error-dedup': html('worker error dedup', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'web_worker_error', scriptUrl: '/workers/dup.js',
      eventKind: 'error', errorMsg: 'first',
    });
    window.__bh.pushBrowserPlatformDetection({
      kind: 'web_worker_error', scriptUrl: '/workers/dup.js',
      eventKind: 'error', errorMsg: 'second',
    });
  `),

  // ---- webrtc_ice_failure ----
  '/webrtc-fires': html('webrtc fail', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'webrtc_ice_failure', connectionId: 'conn-1',
      finalState: 'failed', hadHandler: false,
    });
  `),
  '/webrtc-silent-with-handler': html('webrtc with handler', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'webrtc_ice_failure', connectionId: 'conn-2',
      finalState: 'failed', hadHandler: true,
    });
  `),
  '/webrtc-silent-not-failed': html('webrtc not failed', `
    window.__bh.pushBrowserPlatformDetection({
      kind: 'webrtc_ice_failure', connectionId: 'conn-3',
      finalState: 'connected', hadHandler: false,
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
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`browser-platform-probe-mini ready on port ${PORT}\n`));
