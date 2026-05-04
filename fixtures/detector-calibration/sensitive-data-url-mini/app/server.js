// sensitive-data-url-mini — minimal Node.js HTTP server.
// Plants two sensitive-URL patterns for the sensitive_data_in_url detector:
//   P1: /reset-password?token=abc123def456   (password-reset token in URL)
//   P2: /api/admin?api_key=secret_test_key_123  (API key in query string)
// The index page links to both planted URLs so the crawler encounters them.

'use strict';

const http = require('node:http');

const PORT = parseInt(process.env.PORT ?? '9975', 10);

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sensitive Data URL Test Fixture</title></head>
<body>
  <h1>Sensitive Data URL Test Fixture</h1>
  <p>These links carry sensitive data in their query strings.</p>
  <ul>
    <li><a href="/reset-password?token=abc123def456">Reset Password (token in URL)</a></li>
    <li><a href="/api/admin?api_key=secret_test_key_123">Admin API (api_key in URL)</a></li>
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

  // Default: serve index
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(INDEX_HTML);
}

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`sensitive-data-url-mini ready on port ${PORT}\n`);
});
