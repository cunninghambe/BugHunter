#!/usr/bin/env node
// perf-mini — fixture for 7 perf-metric kinds.
// Each route's HTML synthesises performanceEntries via window.__bh.pushPerf and
// resourceRequests via window.__bh.pushResource at known thresholds.
// Calibrates the classifier+harness pipeline; production gets real entries
// from the browser's PerformanceObserver.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9713;

// Each route has an "inject" script that pushes simulated entries shortly after
// page load. The 100ms delay is well within the 1500ms settle window.
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
  // ---- slow_lcp (threshold 4000ms) ----
  '/lcp-slow': html('LCP slow', `
    window.__bh.pushPerf({ entryType: 'largest-contentful-paint', name: '', startTime: 5000, duration: 0, value: 5000 });
  `),
  '/lcp-fast': html('LCP fast', `
    window.__bh.pushPerf({ entryType: 'largest-contentful-paint', name: '', startTime: 1500, duration: 0, value: 1500 });
  `),
  '/lcp-just-under': html('LCP just under', `
    window.__bh.pushPerf({ entryType: 'largest-contentful-paint', name: '', startTime: 3900, duration: 0, value: 3900 });
  `),

  // ---- slow_inp (threshold 200ms) ----
  '/inp-slow': html('INP slow', `
    window.__bh.pushPerf({ entryType: 'first-input', name: 'pointerdown', startTime: 100, duration: 350, value: 350 });
  `),
  '/inp-fast': html('INP fast', `
    window.__bh.pushPerf({ entryType: 'first-input', name: 'pointerdown', startTime: 100, duration: 50, value: 50 });
  `),

  // ---- high_cls (threshold 0.25) ----
  '/cls-high': html('CLS high', `
    window.__bh.pushPerf({ entryType: 'layout-shift', name: '', startTime: 200, duration: 0, value: 0.4 });
    window.__bh.pushPerf({ entryType: 'layout-shift', name: '', startTime: 400, duration: 0, value: 0.15 });
  `),
  '/cls-low': html('CLS low', `
    window.__bh.pushPerf({ entryType: 'layout-shift', name: '', startTime: 200, duration: 0, value: 0.05 });
  `),

  // ---- main_thread_blocked (longtask > 50ms) ----
  '/longtask-bad': html('Long task', `
    window.__bh.pushPerf({ entryType: 'longtask', name: 'self', startTime: 500, duration: 250 });
  `),
  '/longtask-clean': html('No long task', `/* nothing pushed */`),

  // ---- n_plus_one_api_calls (≥5 same-shape calls) ----
  '/n-plus-one-bad': html('N+1', `
    for (var i = 1; i <= 6; i++) {
      window.__bh.pushResource({ url: 'http://api.local/items/' + i, method: 'GET', status: 200, duration: 10 });
    }
  `),
  '/n-plus-one-clean': html('clean', `
    window.__bh.pushResource({ url: 'http://api.local/items', method: 'GET', status: 200, duration: 20 });
  `),

  // ---- request_dedup_missing (≥3 identical concurrent fetches) ----
  '/dedup-bad': html('dedup', `
    for (var i = 0; i < 3; i++) {
      window.__bh.pushResource({ url: 'http://api.local/users', method: 'GET', status: 200, duration: 30, startTime: 100 });
    }
  `),
  '/dedup-ok': html('clean', `
    window.__bh.pushResource({ url: 'http://api.local/users', method: 'GET', status: 200, duration: 30 });
  `),

  // ---- request_cancellation_missing — production looks at HAR + nav events; we encode
  //      a sentinel in resourceRequests with an `inflightOnNav: true` marker.
  '/cancel-missing': html('cancel-missing', `
    window.__bh.pushResource({ url: 'http://api.local/long-poll', method: 'GET', status: 200, duration: 5000, inflightOnNav: true });
  `),
  '/cancel-clean': html('cancel-ok', `
    window.__bh.pushResource({ url: 'http://api.local/quick', method: 'GET', status: 200, duration: 30 });
  `),
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
  process.stdout.write(`perf-mini ready on port ${PORT}\n`);
});
