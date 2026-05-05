#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9553;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- clock_skew_token_invalid ----
  '/clock-skew-fires': html('clock skew fires', `
    window.__bh.pushSentinelEvent({
      kind: 'clock_skew_token_invalid', severity: 'major',
      rootCause: 'Token issued at future time (clock skew > 5min): iat=99999999999 server_now=1700000000',
    });
  `),
  '/clock-skew-silent': html('clock skew silent', '/* no sentinel — clock in sync */'),

  // ---- clock_overflow ----
  '/clock-overflow-fires': html('clock overflow fires', `
    window.__bh.pushSentinelEvent({
      kind: 'clock_overflow', severity: 'major',
      rootCause: 'Token exp field overflows 32-bit signed int: exp=2147483648 (Y2038 boundary exceeded)',
    });
  `),
  '/clock-overflow-silent': html('clock overflow silent', '/* no sentinel — exp within range */'),

  // ---- clock_dst_corruption ----
  '/clock-dst-fires': html('clock dst fires', `
    window.__bh.pushSentinelEvent({
      kind: 'clock_dst_corruption', severity: 'minor',
      rootCause: 'Token expires at DST ambiguous hour: 2026-03-08T02:30:00 — may double-expire or skip',
    });
  `),
  '/clock-dst-silent': html('clock dst silent', '/* no sentinel — no DST boundary */'),

  // ---- clock_leap_day_failure ----
  '/clock-leap-fires': html('clock leap day fires', `
    window.__bh.pushSentinelEvent({
      kind: 'clock_leap_day_failure', severity: 'minor',
      rootCause: 'Token validation rejected on leap day 2028-02-29: date arithmetic produced Feb-30',
    });
  `),
  '/clock-leap-silent': html('clock leap day silent', '/* no sentinel — date arithmetic correct */'),

  // ---- clock_timezone_display ----
  '/clock-tz-fires': html('clock timezone fires', `
    window.__bh.pushSentinelEvent({
      kind: 'clock_timezone_display', severity: 'minor',
      rootCause: 'Timestamp displayed as UTC but token iat/exp calculated in America/New_York (UTC-5)',
    });
  `),
  '/clock-tz-silent': html('clock timezone silent', '/* no sentinel — timezone consistent */'),

  // ---- xss_stored ----
  '/xss-stored-fires': html('xss stored fires', `
    window.__bh.pushSentinelEvent({
      kind: 'xss_stored', severity: 'critical',
      rootCause: 'Stored XSS: user-supplied comment reflected unescaped at /comments — script tag injected without sanitization',
    });
  `),
  '/xss-stored-silent': html('xss stored silent', '/* no sentinel — output encoded */'),

  // ---- multi_user_inconsistent_snapshot ----
  '/multi-user-fires': html('multi user fires', `
    window.__bh.pushSentinelEvent({
      kind: 'multi_user_inconsistent_snapshot', severity: 'major',
      rootCause: 'User A and User B see different values for shared counter after simultaneous update: A=5 B=4',
    });
  `),
  '/multi-user-silent': html('multi user silent', '/* no sentinel — snapshots consistent */'),

  // ---- permission_denied_unhandled ----
  '/permission-denied-fires': html('permission denied fires', `
    window.__bh.pushSentinelEvent({
      kind: 'permission_denied_unhandled', severity: 'minor',
      rootCause: 'Permissions API denied for "notifications" without catch or user-visible feedback',
    });
  `),
  '/permission-denied-silent': html('permission denied silent', '/* no sentinel — permission handled */'),

  // ---- infinite_loading ----
  '/infinite-loading-fires': html('infinite loading fires', `
    window.__bh.pushSentinelEvent({
      kind: 'infinite_loading', severity: 'major',
      rootCause: 'Spinner visible after 8000ms at /dashboard — fetch /api/data never resolved or rejected',
    });
  `),
  '/infinite-loading-silent': html('infinite loading silent', '/* no sentinel — loaded within threshold */'),

  // ---- idempotency_key_violation ----
  '/idempotency-fires': html('idempotency fires', `
    window.__bh.pushSentinelEvent({
      kind: 'idempotency_key_violation', severity: 'major',
      rootCause: 'POST /api/orders with Idempotency-Key: key-abc executed twice, both returned 201 Created',
    });
  `),
  '/idempotency-silent': html('idempotency silent', '/* no sentinel — second request returned 200 from cache */'),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`mixed-runtime-mini ready on port ${PORT}\n`));
