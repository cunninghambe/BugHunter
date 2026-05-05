#!/usr/bin/env node
// dom-error-text-mini — fixture for dom_error_text.
// Page DOM contains text matching /(something went wrong|an error occurred|
// unable to|failed to)/i — the production CHECK_DOM_ERROR_SCRIPT walker pattern.
// Harness reads envelope.domState.bodyTextSample and applies the same regex.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9733;

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>dom-error-text</title><script>${BOOTSTRAP_SOURCE}</script></head><body>${body}</body></html>`;
}

const ROUTES = {
  '/error-something-went-wrong': html(`<h1>Oops</h1><p>Something went wrong while loading your data.</p>`),
  '/error-an-error-occurred':    html(`<h1>Hmm</h1><p>An error occurred. Please try again.</p>`),
  '/error-unable-to':            html(`<h1>Trouble</h1><p>Unable to fetch your profile.</p>`),
  '/error-failed-to':            html(`<h1>Oops</h1><p>Failed to save your changes.</p>`),
  '/clean-success':              html(`<h1>Welcome</h1><p>Your data loaded successfully.</p>`),
  '/clean-empty':                html(`<h1>Loading…</h1>`),
  '/error-mixed-case':           html(`<h1>Edge</h1><p>SOMETHING WENT WRONG with the order.</p>`),
  '/error-malformed':            html(`<h1<>Mal</h1<><p>Something went wrong on this malformed page.</p>`),
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
  process.stdout.write(`dom-error-text-mini ready on port ${PORT}\n`);
});
