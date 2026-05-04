#!/usr/bin/env node
// network-status-mini — fixture for network_5xx and network_4xx_unexpected.
// Each route returns a known HTTP status; the harness probes each and
// classifies by status code.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9883;

const STATUS_BY_ROUTE = {
  '/200-ok': 200,
  '/201-created': 201,
  '/204-no-content': 204,
  '/301-moved': 301,
  '/302-found': 302,
  '/400-bad-request': 400,
  '/401-unauthorized': 401,
  '/403-forbidden': 403,
  '/404-not-found': 404,
  '/410-gone': 410,
  '/500-server-error': 500,
  '/502-bad-gateway': 502,
  '/503-unavailable': 503,
  '/504-timeout': 504,
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const status = STATUS_BY_ROUTE[pathname];
  if (status !== undefined) {
    if (status >= 300 && status < 400) {
      res.writeHead(status, { 'Location': '/200-ok' });
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(`status ${status}`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not in fixture');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`network-status-mini ready on port ${PORT}\n`);
});
