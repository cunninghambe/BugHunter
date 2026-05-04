#!/usr/bin/env node
// INTENTIONALLY VULNERABLE path-traversal fixture.
// DO NOT DEPLOY to any public network.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9972;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // Reset endpoint
  if (pathname === '/__bughunter_reset') {
    respond(res, 200, 'ok');
    return;
  }

  // P1: route-parameter variant — GET /api/files/:filePath(*)
  // Planted: path.join(__dirname, 'uploads', filePath) with no sanitization.
  // Attack: ..%2f..%2fsentinel.txt traverses outside uploads/.
  const fileRouteMatch = pathname.match(/^\/api\/files\/(.+)$/);
  if (fileRouteMatch) {
    const filePath = fileRouteMatch[1];
    // INTENTIONALLY UNSAFE — no path.normalize or startsWith check
    const resolved = path.join(UPLOADS_DIR, filePath);
    try {
      const contents = fs.readFileSync(resolved, 'utf8');
      respond(res, 200, contents);
    } catch {
      respond(res, 404, 'not found');
    }
    return;
  }

  // P2: query-string variant — GET /api/download?file=<path>
  // Same unsafe pattern, different surface.
  if (pathname === '/api/download') {
    const file = parsed.query.file ?? 'readme.txt';
    // INTENTIONALLY UNSAFE
    const resolved = path.join(UPLOADS_DIR, String(file));
    try {
      const contents = fs.readFileSync(resolved, 'utf8');
      respond(res, 200, contents);
    } catch {
      respond(res, 404, 'not found');
    }
    return;
  }

  // Health check
  if (pathname === '/') {
    respond(res, 200, 'path-traversal-mini fixture');
    return;
  }

  respond(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`path-traversal-mini ready on port ${PORT}\n`);
});
