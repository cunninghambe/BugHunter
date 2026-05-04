#!/usr/bin/env node
// i18n-text-checks-mini — fixture for static-heuristic harnesses of:
//   i18n_date_format_ambiguous — MM/DD/YYYY or DD/MM/YYYY without month-name disambiguation
//   i18n_pluralization_broken — "1 items", "1 messages", etc.
//   i18n_currency_format_broken — currency rendered without proper decimals/separators
// Production paths use locale-stress probes through camofox; harness uses focused regex.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9843;

function respond(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // ---- date format ----
  // Positive: ambiguous MM/DD/YYYY rendered without a clarifying month name or ISO 8601 form.
  if (pathname === '/date-ambiguous-mmddyyyy') return respond(res, '<p>Order placed: 03/04/2026</p>');
  // Positive: ambiguous DD/MM/YYYY (same regex matches both — page is silent on month name).
  if (pathname === '/date-ambiguous-ddmmyyyy') return respond(res, '<p>Date: 04/03/2026</p>');
  // Negative: ISO 8601 — unambiguous.
  if (pathname === '/date-iso8601') return respond(res, '<p>Created: 2026-03-04</p>');
  // Negative: month name spelled out — unambiguous.
  if (pathname === '/date-with-month-name') return respond(res, '<p>Order placed: 03/04/2026 (March 4, 2026)</p>');
  // Negative: dot-separated DD.MM.YYYY (European convention; classifier accepts as good).
  if (pathname === '/date-dot-separated') return respond(res, '<p>Datum: 04.03.2026</p>');

  // ---- pluralization ----
  // Positive: "1 items" — count=1 but plural noun.
  if (pathname === '/plural-1-items') return respond(res, '<p>You have 1 items in your cart.</p>');
  // Positive: "1 messages" different noun.
  if (pathname === '/plural-1-messages') return respond(res, '<p>1 messages received.</p>');
  // Negative: "1 item" — correct singular.
  if (pathname === '/plural-1-item') return respond(res, '<p>You have 1 item in your cart.</p>');
  // Negative: "5 items" — plural correctly.
  if (pathname === '/plural-5-items') return respond(res, '<p>You have 5 items in your cart.</p>');
  // Negative: "0 items" — plural for zero is conventional in en-US.
  if (pathname === '/plural-0-items') return respond(res, '<p>You have 0 items in your cart.</p>');

  // ---- currency ----
  // Positive: USD with 0 decimals (USD expects 2 decimals).
  if (pathname === '/currency-usd-no-decimals') return respond(res, '<p>Total: $42</p>');
  // Positive: USD with 4 decimals (over-precision).
  if (pathname === '/currency-usd-4-decimals') return respond(res, '<p>Total: $42.0000</p>');
  // Negative: USD with 2 decimals — correct.
  if (pathname === '/currency-usd-2-decimals') return respond(res, '<p>Total: $42.00</p>');
  // Negative edge: JPY with 0 decimals — correct (JPY expects 0).
  if (pathname === '/currency-jpy-no-decimals') return respond(res, '<p>Total: ¥4200</p>');
  // Negative: page mentions no currency at all.
  if (pathname === '/currency-not-present') return respond(res, '<p>Welcome to the store.</p>');

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`i18n-text-checks-mini ready on port ${PORT}\n`);
});
