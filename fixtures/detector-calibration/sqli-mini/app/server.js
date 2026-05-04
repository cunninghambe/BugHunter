#!/usr/bin/env node
// INTENTIONALLY VULNERABLE sql_injection fixture.
// DO NOT DEPLOY to any public network.

'use strict';

const http = require('node:http');
const path = require('node:path');
const url = require('node:url');
const Database = require('better-sqlite3');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9957;
const DB_PATH = path.join(__dirname, 'tasks.db');

function openDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'general'
    )
  `);
  const count = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
  if (count.n === 0) {
    const insert = db.prepare('INSERT INTO tasks (title, label) VALUES (?, ?)');
    insert.run('Fix login bug', 'backend');
    insert.run('Add dark mode', 'frontend');
    insert.run('Write tests', 'backend');
  }
  return db;
}

const db = openDb();

function respond(res, status, body) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain' });
  res.end(isJson ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/__bughunter_reset') {
    respond(res, 200, 'ok');
    return;
  }

  // P1: GET /api/search?q= — string-context SQL concatenation (VULNERABLE)
  // User input interpolated directly into the SQL string passed to db.prepare().
  if (pathname === '/api/search') {
    const q = String(parsed.query.q ?? '');
    try {
      // INTENTIONALLY UNSAFE — string concatenation, not parameterized
      const rows = db.prepare(`SELECT * FROM tasks WHERE title LIKE '%${q}%'`).all();
      respond(res, 200, { rows: rows.map(r => [r.id, r.title, r.label]) });
    } catch (err) {
      respond(res, 500, { error: err.message });
    }
    return;
  }

  // P2: GET /api/admin/reports?filter= — numeric-context SQL concatenation (VULNERABLE)
  if (pathname === '/api/admin/reports') {
    const filter = String(parsed.query.filter ?? '1');
    try {
      // INTENTIONALLY UNSAFE — numeric param concatenated directly
      const rows = db.prepare(`SELECT * FROM tasks WHERE id > ${filter}`).all();
      respond(res, 200, { rows: rows.map(r => [r.id, r.title, r.label]) });
    } catch (err) {
      respond(res, 500, { error: err.message });
    }
    return;
  }

  // P3: GET /api/tasks?label= — string-context SQL concatenation (VULNERABLE)
  if (pathname === '/api/tasks') {
    const label = String(parsed.query.label ?? '');
    try {
      // INTENTIONALLY UNSAFE — string concatenation, not parameterized
      const rows = db.prepare(`SELECT * FROM tasks WHERE label = '${label}'`).all();
      respond(res, 200, { rows: rows.map(r => [r.id, r.title, r.label]) });
    } catch (err) {
      respond(res, 500, { error: err.message });
    }
    return;
  }

  // N1: GET /api/search-safe?q= — parameterized query (SAFE — detector must be silent)
  if (pathname === '/api/search-safe') {
    const q = String(parsed.query.q ?? '');
    try {
      const rows = db.prepare('SELECT * FROM tasks WHERE title LIKE ?').all(`%${q}%`);
      respond(res, 200, { rows: rows.map(r => [r.id, r.title, r.label]) });
    } catch (err) {
      respond(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/') {
    respond(res, 200, 'sqli-mini fixture');
    return;
  }

  respond(res, 404, 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`sqli-mini ready on port ${PORT}\n`);
});
