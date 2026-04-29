#!/usr/bin/env node
// Synthetic vulnerable fixture for v0.16 pen-testing smoke tests.
// INTENTIONALLY VULNERABLE — for testing purposes only. Never deploy this.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { execSync } = require('node:child_process');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PEN_BAD_PORT ? parseInt(process.env.PEN_BAD_PORT, 10) : 9991;

// In-memory SQLite DB
const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT);`);
db.exec(`INSERT INTO users VALUES (1, 'alice', 'user'), (2, 'admin', 'admin');`);

function respond(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // --- Route 1: SQL injection (error-based) ---
  if (pathname === '/search') {
    const q = query.q ?? '';
    try {
      // INTENTIONALLY UNSAFE — string interpolation into SQL
      const rows = db.prepare(`SELECT * FROM users WHERE name = '${q}'`).all();
      respond(res, 200, JSON.stringify(rows));
    } catch (err) {
      // Error message includes the interpolated payload — proves SQL injection
      respond(res, 500, `SQLite error: ${err.message}`);
    }
    return;
  }

  // --- Route 2: Command injection ---
  if (pathname === '/lookup') {
    const host = query.host ?? 'localhost';
    try {
      // INTENTIONALLY UNSAFE — shell injection via exec
      const output = execSync(`echo host: ${host}`, { timeout: 2000 }).toString();
      respond(res, 200, output);
    } catch (err) {
      respond(res, 500, String(err));
    }
    return;
  }

  // --- Route 3: Path traversal ---
  if (pathname === '/file') {
    const name = query.name ?? 'index.txt';
    // INTENTIONALLY UNSAFE — no sanitization
    const resolved = path.join('/var/www', name);
    try {
      const contents = fs.readFileSync(resolved, 'utf8');
      respond(res, 200, contents);
    } catch {
      // Return 404 — file not found is not a finding (expected)
      respond(res, 404, 'not found');
    }
    return;
  }

  // --- Route 4: JWT weak algorithm (alg=none accepted) ---
  if (pathname === '/admin/promote' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (token === '') {
      respond(res, 401, 'Unauthorized');
      return;
    }

    const parts = token.split('.');
    if (parts.length < 2) {
      respond(res, 401, 'Bad token format');
      return;
    }

    try {
      const headerJson = Buffer.from(parts[0], 'base64').toString('utf8');
      const header = JSON.parse(headerJson);

      // INTENTIONALLY VULNERABLE — accepts alg=none without signature verification
      if (header.alg !== undefined && header.alg.toLowerCase() === 'none') {
        const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        respond(res, 200, JSON.stringify({ promoted: true, subject: payload.sub }));
        return;
      }
    } catch {
      respond(res, 400, 'Malformed token');
      return;
    }

    respond(res, 401, 'Unauthorized');
    return;
  }

  respond(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`pen-bad fixture listening on http://127.0.0.1:${PORT}\n`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
