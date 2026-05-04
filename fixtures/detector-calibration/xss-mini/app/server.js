// xss-mini — Minimal HTTP fixture server for xss_reflected detector calibration.
// Plants three reflected-XSS vulnerabilities and one safe route.
// DO NOT deploy this server to any public network.

'use strict';

const http = require('http');
const PORT = parseInt(process.env.XSS_MINI_PORT ?? '9971', 10);

// Minimal HTML escaping — used on the SAFE route only.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html' });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseQs(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = {};
  for (const part of url.slice(idx + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0];
  const qs = parseQs(rawUrl);

  // POST /__bughunter_reset — stateless; always ok
  if (req.method === 'POST' && path === '/__bughunter_reset') {
    json(res, 200, { ok: true });
    return;
  }

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  // P1 (POSITIVE — fires): GET /api/search?q=
  // BUG: user input reflected directly into HTML body without escaping.
  if (req.method === 'GET' && path === '/api/search') {
    const q = qs['q'] ?? '';
    html(res, 200, `<html><body><p>Results for: ${q}</p></body></html>`);
    return;
  }

  // NEGATIVE (silent): GET /api/echo-safe?msg=
  // SAFE: input is HTML-escaped before reflection — no XSS possible.
  if (req.method === 'GET' && path === '/api/echo-safe') {
    const msg = qs['msg'] ?? '';
    html(res, 200, `<html><body><p>${escapeHtml(msg)}</p></body></html>`);
    return;
  }

  // P2 (EDGE — fires, attribute context): GET /api/link?url=
  // BUG: user input reflected unescaped into an <a href=""> attribute.
  // Edge label: attribute-context-vs-body — same payload lands in href, not text node.
  if (req.method === 'GET' && path === '/api/link') {
    const url = qs['url'] ?? '#';
    html(res, 200, `<html><body><a href="${url}">click</a></body></html>`);
    return;
  }

  // P3 (EDGE — fires, script-tag vs img-onerror): GET /api/greet?name=
  // BUG: user input reflected unescaped into a <div> — both <script> and <img onerror> payloads
  // land in the body but the signatures differ (script-tag-payload vs img-onerror-payload).
  if (req.method === 'GET' && path === '/api/greet') {
    const name = qs['name'] ?? '';
    html(res, 200, `<html><body><div>Hello, ${name}!</div></body></html>`);
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`xss-mini ready on port ${PORT}\n`);
});
