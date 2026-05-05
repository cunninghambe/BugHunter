#!/usr/bin/env node
// unhandled-exception-mini — fixture for unhandled_exception.
//
// Each route either throws an uncaught exception (positive) or stays clean.
// The window.error event handler in the bootstrap captures uncaught throws.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9753;

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>unhandled-exception</title><script>${BOOTSTRAP_SOURCE}</script></head><body>${body}</body></html>`;
}

const ROUTES = {
  // Positive: throw from a setTimeout (uncaught — bubbles to window.error)
  '/throw-from-timeout': html(`<h1>Throw</h1><script>setTimeout(() => { throw new Error('uncaught timeout error'); }, 50);</script>`),
  // Positive: throw from a microtask
  '/throw-from-microtask': html(`<h1>Microtask Throw</h1><script>setTimeout(() => queueMicrotask(() => { throw new Error('microtask uncaught'); }), 50);</script>`),
  // Positive: unhandled promise rejection — captured separately but populates uncaughtErrors path via window.error in some browsers; we use unhandledrejection event instead
  '/unhandled-rejection': html(`<h1>Rejection</h1><script>setTimeout(() => { Promise.reject(new Error('unhandled rejection')); }, 50);</script>`),
  // Negative: catches its own error
  '/throw-caught': html(`<h1>Caught</h1><script>setTimeout(() => { try { throw new Error('caught'); } catch (_e) {} }, 50);</script>`),
  // Negative: page renders cleanly
  '/clean': html(`<h1>Clean</h1><p>nothing throws</p>`),
  // Edge: throw IS captured even on malformed HTML
  '/throw-malformed': html(`<h1<>Mal</h1<><script>setTimeout(() => { throw new Error('thrown despite malformed html'); }, 50);</script>`),
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
  process.stdout.write(`unhandled-exception-mini ready on port ${PORT}\n`);
});
