// Deliberately-vulnerable Express fixture for XSS detection smoke test.
// INTENTIONALLY unsafe: renders user input without sanitisation.
// Do NOT deploy this to any production or shared environment.

import express from 'express';

const app = express();
const PORT = process.env.PORT ?? 3999;

// Vulnerable endpoint: echoes q param directly into HTML
app.get('/echo', (req, res) => {
  const q = req.query.q ?? '';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body><div id="result">${q}</div></body></html>`);
});

// Second vulnerable endpoint: injects q into a <script> block
app.get('/search', (req, res) => {
  const q = req.query.q ?? '';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body><script>const query = "${q}";</script></body></html>`);
});

// Safe control endpoint
app.get('/safe', (req, res) => {
  const q = (req.query.q ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body><div>${q}</div></body></html>`);
});

app.get('/', (_req, res) => {
  res.send('<!DOCTYPE html><html><body><h1>XSS Fixture</h1></body></html>');
});

app.listen(PORT, () => {
  process.stdout.write(`xss-app fixture listening on port ${PORT}\n`);
});
