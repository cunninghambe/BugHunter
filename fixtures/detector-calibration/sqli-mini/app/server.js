#!/usr/bin/env node
// sqli-mini: minimal fixture for sql_injection detector calibration.
// INTENTIONALLY VULNERABLE — for testing purposes only. Never deploy this.
//
// Three SQL injection plants:
// P1: GET /api/search?q=    — concatenates q into LIKE query
// P2: GET /api/admin/reports?filter= — concatenates filter into WHERE clause
// P3: GET /api/tasks?label= — concatenates label into WHERE clause

'use strict';

const http = require('node:http');
const url = require('node:url');
const Database = require('better-sqlite3');

const PORT = process.env.SQLI_MINI_PORT ? parseInt(process.env.SQLI_MINI_PORT, 10) : 9972;

// In-memory SQLite DB, seeded with sample data
let db = createDb();

function createDb() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, label TEXT);
    INSERT INTO tasks VALUES
      (1, 'Fix login bug', 'backend'),
      (2, 'Update README', 'docs'),
      (3, 'Add unit tests', 'backend');

    CREATE TABLE reports (id INTEGER PRIMARY KEY, name TEXT, filter TEXT);
    INSERT INTO reports VALUES
      (1, 'Daily summary', 'active'),
      (2, 'Weekly overview', 'archived');
  `);
  return d;
}

function respond(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // P1: GET /api/search?q= — concatenates q into LIKE query
  if (req.method === 'GET' && pathname === '/api/search') {
    const q = typeof query.q === 'string' ? query.q : '';
    try {
      // INTENTIONALLY UNSAFE — string interpolation into SQL
      const rows = db.prepare(`SELECT * FROM tasks WHERE title LIKE '%${q}%'`).all();
      respond(res, 200, 'application/json', JSON.stringify(rows));
    } catch (err) {
      // Error message includes interpolated payload — proves SQL injection
      respond(res, 500, 'text/plain', `SQLite error: ${err.message}`);
    }
    return;
  }

  // P2: GET /api/admin/reports?filter= — concatenates filter into WHERE clause
  if (req.method === 'GET' && pathname === '/api/admin/reports') {
    const filter = typeof query.filter === 'string' ? query.filter : '';
    try {
      // INTENTIONALLY UNSAFE — string interpolation into SQL
      const rows = db.prepare(`SELECT * FROM reports WHERE filter = '${filter}'`).all();
      respond(res, 200, 'application/json', JSON.stringify(rows));
    } catch (err) {
      respond(res, 500, 'text/plain', `SQLite error: ${err.message}`);
    }
    return;
  }

  // P3: GET /api/tasks?label= — concatenates label into WHERE clause
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const label = typeof query.label === 'string' ? query.label : '';
    try {
      // INTENTIONALLY UNSAFE — string interpolation into SQL
      const rows = db.prepare(`SELECT * FROM tasks WHERE label = '${label}'`).all();
      respond(res, 200, 'application/json', JSON.stringify(rows));
    } catch (err) {
      respond(res, 500, 'text/plain', `SQLite error: ${err.message}`);
    }
    return;
  }

  // Reset endpoint — rebuilds in-memory database
  if (req.method === 'POST' && pathname === '/__bughunter_reset') {
    db.close();
    db = createDb();
    respond(res, 200, 'application/json', JSON.stringify({ reset: true }));
    return;
  }

  respond(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`sqli-mini fixture listening on http://127.0.0.1:${PORT}\nREADY\n`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
