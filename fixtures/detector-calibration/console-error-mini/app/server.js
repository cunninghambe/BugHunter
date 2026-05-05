#!/usr/bin/env node
// console-error-mini — fixture for console_error detector.
// Each route serves a tiny HTML page that calls console.error/warn/log inside
// a setTimeout so the V56.4 browser harness's bootstrap (which late-injects
// when camofox lacks init_script support) has time to install before the
// call. 50ms delay is well within the 1500ms settle window. This shape also
// matches real apps better — they log errors during interaction, not at
// module-top-level.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9763;

// V56.4 browser-harness bootstrap, inlined at the head of every fixture page.
// Camofox's `evaluate` runs in an isolated world; only an inline page script
// can install console-overrides that the page's own scripts will see.
// Mirrors BOOTSTRAP_INSTALL_SCRIPT in packages/cli/src/harness/browser-executor.ts
// — keep the two in lockstep (idempotency check protects against double-install).
const BOOTSTRAP = `(() => {
  if (window.__bh && window.__bh.installed) return;
  const bh = {
    installed: true,
    consoleEvents: [],
    uncaughtErrors: [],
    unhandledRejections: [],
    performanceEntries: [],
    resourceRequests: [],
    harvestWarnings: [],
  };
  window.__bh = bh;
  ['log','info','warn','error'].forEach(level => {
    const orig = console[level];
    console[level] = function() {
      try {
        const args = Array.prototype.slice.call(arguments);
        const msg = args.map(a => {
          if (a === null || a === undefined) return String(a);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_e) { return String(a); }
        }).join(' ');
        bh.consoleEvents.push({ level: level, message: msg.slice(0, 2000) });
      } catch (_e) {
        bh.harvestWarnings.push('console_capture_threw:' + String(_e));
      }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', (ev) => {
    try {
      bh.uncaughtErrors.push({
        message: String(ev.message || '').slice(0, 1000),
        filename: ev.filename, lineno: ev.lineno, colno: ev.colno,
        stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4000) : undefined,
      });
    } catch (_e) { bh.harvestWarnings.push('error_capture_threw:' + String(_e)); }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const r = ev.reason;
      const reasonStr = r instanceof Error ? r.message : (typeof r === 'string' ? r : JSON.stringify(r));
      bh.unhandledRejections.push({
        reason: String(reasonStr || 'unknown').slice(0, 1000),
        stack: r && r.stack ? String(r.stack).slice(0, 4000) : undefined,
      });
    } catch (_e) { bh.harvestWarnings.push('rejection_capture_threw:' + String(_e)); }
  });
})();`;

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>console-error</title><script>${BOOTSTRAP}</script></head><body>${body}</body></html>`;
}

const ROUTES = {
  // Positive: console.error called shortly after load
  '/console-error-load': html(`<h1>Boom</h1><script>setTimeout(() => console.error('boom! deferred error'), 50);</script>`),
  // Positive: console.error inside a microtask after the same delay
  '/console-error-microtask': html(`<h1>Microtask</h1><script>setTimeout(() => queueMicrotask(() => console.error('microtask boom')), 50);</script>`),
  // Negative: page renders but never logs an error
  '/console-error-clean': html(`<h1>Clean</h1><p>nothing logged</p>`),
  // Edge: console.warn (not error) — should NOT fire console_error
  '/console-warn-only': html(`<h1>Warn</h1><script>setTimeout(() => console.warn('only a warning'), 50);</script>`),
  // Edge: console.log (info) — should NOT fire console_error
  '/console-log-only': html(`<h1>Log</h1><script>setTimeout(() => console.log('just a log'), 50);</script>`),
  // Input degradation: malformed HTML still triggers console.error after delay
  '/console-error-malformed': html(`<h1<>Mal</h1<><script>setTimeout(() => console.error('still fires under malformed html'), 50);</script>`),
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
  process.stdout.write(`console-error-mini ready on port ${PORT}\n`);
});
