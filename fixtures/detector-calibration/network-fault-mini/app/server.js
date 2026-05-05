#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9643;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const PRE = { url: '/page', title: 'Page', consoleErrorCount: 0 };
const cleanPost = (overrides) => Object.assign({
  url: '/page', title: 'Page', consoleErrors: [],
  networkRequests: [], domErrorTextDetected: false,
  mutationObserverWindowMs: 1500,
}, overrides);

const ROUTES = {
  // ---- network_fault_unhandled ----
  '/unhandled-fires': html('unhandled', `
    window.__bh.setNetworkFaultUnhandledInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost())},
      fault: { kind: 'offline' },
      retryStormThresholdRps: 5,
      asyncMaxWaitMs: 3000,
    });
  `),
  '/unhandled-silent-error-ui': html('error ui shown', `
    window.__bh.setNetworkFaultUnhandledInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost({ domErrorTextDetected: true }))},
      fault: { kind: 'offline' },
      retryStormThresholdRps: 5, asyncMaxWaitMs: 3000,
    });
  `),
  '/unhandled-silent-non-error-fault': html('non-error fault', `
    window.__bh.setNetworkFaultUnhandledInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost())},
      fault: { kind: 'slow' },
      retryStormThresholdRps: 5, asyncMaxWaitMs: 3000,
    });
  `),
  '/unhandled-silent-network-console-error': html('network console error', `
    window.__bh.setNetworkFaultUnhandledInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost({ consoleErrors: [{ level: 'error', text: 'fetch failed' }] }))},
      fault: { kind: 'offline' },
      retryStormThresholdRps: 5, asyncMaxWaitMs: 3000,
    });
  `),

  // ---- network_fault_optimistic_no_revert ----
  '/optimistic-fires': html('optimistic', `
    window.__bh.setOptimisticNoRevertInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost())},
      fault: { kind: 'server_5xx' },
      optimisticSnapshot: { snapshot: '<div>like-button.active</div>', capturedAtOffsetMs: 200 },
      retryStormThresholdRps: 5,
    });
  `),
  '/optimistic-silent-no-snapshot': html('no snapshot', `
    window.__bh.setOptimisticNoRevertInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost())},
      fault: { kind: 'server_5xx' },
      optimisticSnapshot: null,
      retryStormThresholdRps: 5,
    });
  `),
  '/optimistic-silent-error-ui': html('error ui shown', `
    window.__bh.setOptimisticNoRevertInput({
      preState: ${JSON.stringify(PRE)},
      postState: ${JSON.stringify(cleanPost({ domErrorTextDetected: true }))},
      fault: { kind: 'server_5xx' },
      optimisticSnapshot: { snapshot: '<div>active</div>', capturedAtOffsetMs: 200 },
      retryStormThresholdRps: 5,
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
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`network-fault-mini ready on port ${PORT}\n`));
