#!/usr/bin/env node
// hallucinated-route-mini — fixture for hallucinated_route detector.
//
// Production detector: planner-discovered pages that 404 on their own
// navigation are "hallucinated" — they were referenced (filesystem-routed
// or sitemap'd) but don't exist on the server.
//
// Harness model: /sitemap.xml lists claimed routes; harness probes each.
// A route in the sitemap that 404s is a hallucinated_route detection.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9833;

// Routes that exist (200)
const REAL_ROUTES = new Set([
  '/',
  '/about',
  '/products',
]);

// Sitemap claims these routes:
const SITEMAP_CLAIMS = [
  '/',
  '/about',
  '/products',
  '/team',          // hallucinated — does not exist
  '/blog',          // hallucinated — does not exist
];

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_CLAIMS.map(r => `  <url><loc>http://127.0.0.1:${PORT}${r}</loc></url>`).join('\n')}
</urlset>`;

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(SITEMAP_XML);
    return;
  }

  if (REAL_ROUTES.has(pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><h1>${pathname}</h1></body></html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`hallucinated-route-mini ready on port ${PORT}\n`);
});
