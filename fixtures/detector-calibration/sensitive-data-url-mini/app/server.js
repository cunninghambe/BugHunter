// sensitive-data-url-mini — minimal Node.js HTTP server.
// Plants sensitive-URL patterns for the sensitive_data_in_url detector:
//   P1: /reset-password?token=abc123def456         (password-reset token in query string)
//   P2: /api/admin?api_key=secret_test_key_123     (API key in query string)
//   P3: /api/v1/key/abc123def456/items             (API key embedded in path segment)
//   N1: POST /login-safe with credentials in body  (negative: detector must be silent)
// Fragment example (/login#token=abc) is documented in README — fragment never reaches server.

'use strict';

const http = require('node:http');

const PORT = parseInt(process.env.PORT ?? '9975', 10);

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sensitive Data URL Test Fixture</title></head>
<body>
  <h1>Sensitive Data URL Test Fixture</h1>
  <p>These links carry sensitive data in their query strings or path segments.</p>
  <ul>
    <li><a href="/reset-password?token=abc123def456">Reset Password (token in URL)</a></li>
    <li><a href="/api/admin?api_key=secret_test_key_123">Admin API (api_key in URL)</a></li>
    <li><a href="/api/v1/key/abc123def456/items">Items (api_key in path segment)</a></li>
  </ul>
  <p>Safe alternatives (detector must be silent):</p>
  <ul>
    <li>POST /login-safe — credentials in body, never in URL</li>
  </ul>
</body>
</html>`;

function handler(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/reset-password') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Password Reset</h1><p>Your password has been reset.</p></body></html>');
    return;
  }

  if (url.pathname === '/api/admin') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', admin: true }));
    return;
  }

  // P3: api-key-in-path-segment — key is a path component, not a query param.
  if (url.pathname.startsWith('/api/v1/key/') && url.pathname.endsWith('/items')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', items: [] }));
    return;
  }

  // N1: login-safe — credentials arrive via POST body, never in the URL.
  // The detector must observe this route as silent (no sensitive param in URL).
  if (req.method === 'POST' && url.pathname === '/login-safe') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Default: serve index
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(INDEX_HTML);
}

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`sensitive-data-url-mini ready on port ${PORT}\n`);
});
