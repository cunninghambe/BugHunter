#!/usr/bin/env node
// react-error-mini — fixture for react_error AND hydration_mismatch.
// Production classifier inspects console.error text against React-specific
// patterns. We synthesise the patterns directly via console.error calls.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9743;

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>react-error</title><script>${BOOTSTRAP_SOURCE}</script></head><body>${body}</body></html>`;
}

const ROUTES = {
  // ---- react_error ----
  '/react-warning':       html(`<h1>Warn</h1><script>setTimeout(() => console.error('Warning: Each child in a list should have a unique "key" prop.'), 50);</script>`),
  '/react-state-update':  html(`<h1>State</h1><script>setTimeout(() => console.error('Cannot update during an existing state transition'), 50);</script>`),
  '/react-invalid-hook':  html(`<h1>Hook</h1><script>setTimeout(() => console.error('Invalid hook call. Hooks can only be called inside the body of a function component.'), 50);</script>`),
  '/react-clean':         html(`<h1>Clean</h1><p>nothing logged</p>`),
  // ---- hydration_mismatch ----
  '/hydration-failed':    html(`<h1>Hydrate</h1><script>setTimeout(() => console.error('Hydration failed because the initial UI does not match what was rendered on the server.'), 50);</script>`),
  '/hydration-text':      html(`<h1>Text</h1><script>setTimeout(() => console.error('Text content does not match server-rendered HTML'), 50);</script>`),
  // Edge: generic console.error that does not match React/hydration patterns
  '/non-react-error':     html(`<h1>Other</h1><script>setTimeout(() => console.error('a generic error message that is not a React warning'), 50);</script>`),
  // Input degradation: malformed HTML still has the React warning
  '/react-malformed':     html(`<h1<>Mal</h1<><script>setTimeout(() => console.error('Warning: Each child in a list should have a unique "key" prop.'), 50);</script>`),
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
  process.stdout.write(`react-error-mini ready on port ${PORT}\n`);
});
