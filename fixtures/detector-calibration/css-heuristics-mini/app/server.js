#!/usr/bin/env node
// css-heuristics-mini — fixture for static-heuristic harnesses of:
//   touch_target_too_small — interactive elements with explicit size <24px
//   hover_only_affordance — :hover styles without :focus equivalent
//   i18n_long_string_overflow — overflow:hidden / text-overflow:ellipsis without
//                              accommodating CSS for translations
//   i18n_timezone_display_wrong — timezone-suffixed dates with conflicting offsets

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9773;

function respond(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

const ROUTES = {
  // ---- touch_target_too_small ----
  '/touch-tiny-button': '<!doctype html><body><button style="width:16px;height:16px">x</button></body>',
  '/touch-tiny-link':   '<!doctype html><body><a href="/x" style="width:20px;height:20px;display:inline-block">x</a></body>',
  '/touch-good-size':   '<!doctype html><body><button style="width:48px;height:48px">click me</button></body>',
  '/touch-no-size-set': '<!doctype html><body><button>fine default</button></body>',
  '/touch-static-content': '<!doctype html><body><p>just text — no interactive elements</p></body>',

  // ---- hover_only_affordance ----
  '/hover-no-focus':    '<!doctype html><html><head><style>.btn:hover { background: blue; }</style></head><body><button class="btn">hover me</button></body></html>',
  '/hover-with-focus':  '<!doctype html><html><head><style>.btn:hover, .btn:focus { background: blue; }</style></head><body><button class="btn">x</button></body></html>',
  '/hover-with-focus-visible':  '<!doctype html><html><head><style>.btn:hover { background: blue; } .btn:focus-visible { outline: 2px solid; }</style></head><body><button class="btn">x</button></body></html>',
  '/hover-no-css-rules':        '<!doctype html><body><button>plain</button></body>',

  // ---- i18n_long_string_overflow ----
  '/overflow-hidden-fixed-width':   '<!doctype html><html><head><style>.label { width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }</style></head><body><span class="label">Welcome to the store</span></body></html>',
  '/overflow-flex-grow':            '<!doctype html><html><head><style>.label { flex: 1; min-width: 0; }</style></head><body><span class="label">Welcome to the store</span></body></html>',
  '/overflow-no-fixed-constraint':  '<!doctype html><body><span>Welcome to the store</span></body>',

  // ---- i18n_timezone_display_wrong ----
  '/tz-conflicting-suffixes': '<!doctype html><body><p>Order placed: 2026-03-04 12:00 UTC</p><p>Confirmation: 2026-03-04 12:00 EST</p></body>',
  '/tz-consistent-suffix':    '<!doctype html><body><p>Order placed: 2026-03-04 12:00 UTC</p><p>Confirmation: 2026-03-04 12:30 UTC</p></body>',
  '/tz-no-suffix':            '<!doctype html><body><p>Order placed: 2026-03-04</p></body>',
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const body = ROUTES[pathname];
  if (body !== undefined) return respond(res, body);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`css-heuristics-mini ready on port ${PORT}\n`);
});
