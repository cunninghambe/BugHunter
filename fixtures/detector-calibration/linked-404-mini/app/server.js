#!/usr/bin/env node
// linked-404-mini — fixture for 404_for_linked_route detector.
// Each "page" route serves HTML with internal <a href="/path"> links;
// the harness extracts links and probes each. Fires when a linked path 404s.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9893;

function html(body) {
  return { status: 200, body };
}

const ROUTES = {
  // Positive: page links to a path that does not exist
  '/page-with-broken-link': html(
    '<!doctype html><html><head><title>Broken</title></head><body><h1>Broken</h1>'
    + '<a href="/api/missing-endpoint">missing</a></body></html>',
  ),
  // Negative: page links only to existing paths
  '/page-with-good-links': html(
    '<!doctype html><html><head><title>Good</title></head><body><h1>Good</h1>'
    + '<a href="/api/existing">existing</a> <a href="/api/also-real">also</a></body></html>',
  ),
  // Edge: page links to fragment within page (#section) — should NOT fire
  '/page-with-fragments': html(
    '<!doctype html><html><head><title>Fragments</title></head><body><h1>Fragments</h1>'
    + '<a href="#top">top</a> <a href="#section">section</a></body></html>',
  ),
  // Edge: page links to absolute URL on different origin — should NOT fire
  '/page-with-external-link': html(
    '<!doctype html><html><head><title>External</title></head><body><h1>Ext</h1>'
    + '<a href="https://example.com/external">external</a></body></html>',
  ),
  // Edge: mailto:/tel: links — non-HTTP — should NOT fire
  '/page-with-mailto': html(
    '<!doctype html><html><head><title>Mailto</title></head><body><h1>Mail</h1>'
    + '<a href="mailto:hi@example.com">email</a> <a href="tel:+15551234">phone</a></body></html>',
  ),
  // Edge: page links to multiple paths, only one is broken — should fire
  '/page-with-mixed-links': html(
    '<!doctype html><html><head><title>Mixed</title></head><body><h1>Mixed</h1>'
    + '<a href="/api/existing">good</a> <a href="/api/also-missing">bad</a></body></html>',
  ),
  // Input degradation: page is malformed HTML but link is still extractable
  '/page-malformed': html(
    '<!doctype html><html<><head><title>Mal</title></head<><body<><a href="/api/another-missing"<>broken</a></body></html>',
  ),

  // Real endpoints linked by good pages
  '/api/existing': { status: 200, body: 'exists' },
  '/api/also-real': { status: 200, body: 'also exists' },
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const route = ROUTES[pathname];
  if (route !== undefined) {
    res.writeHead(route.status, {
      'Content-Type': pathname.startsWith('/api/') ? 'text/plain' : 'text/html; charset=utf-8',
    });
    res.end(route.body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`linked-404-mini ready on port ${PORT}\n`);
});
