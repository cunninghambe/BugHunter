#!/usr/bin/env node
// script-checks-mini — fixture for static-heuristic harnesses of:
//   iframe_postmessage_unguarded — postMessage handler without origin check
//   xss_dom — innerHTML / document.write of unsanitised input
//   swallowed_error_empty_catch — empty catch block in client script
//   jwt_weak_alg — JWT-shaped token with alg:'none' or alg:'HS256' weak header
// Production paths use browser/static analysers; harness uses focused regex.

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9863;

const ROUTES = {
  // ---- iframe_postmessage_unguarded ----
  '/postmessage-no-origin-check': `<!doctype html><html><head><script>
    window.addEventListener('message', function(e) { document.body.innerText = e.data; });
  </script></head><body>x</body></html>`,
  '/postmessage-with-origin-check': `<!doctype html><html><head><script>
    window.addEventListener('message', function(e) {
      if (e.origin !== 'https://trusted.example.com') return;
      document.body.innerText = e.data;
    });
  </script></head><body>x</body></html>`,
  '/postmessage-arrow-no-origin': `<!doctype html><html><head><script>
    window.addEventListener('message', (event) => { handleMessage(event.data); });
  </script></head><body>x</body></html>`,
  '/no-postmessage-handler': `<!doctype html><html><head><script>
    console.log('hello');
  </script></head><body>x</body></html>`,

  // ---- xss_dom ----
  '/xss-innerhtml-from-search': `<!doctype html><html><head><script>
    const params = new URLSearchParams(window.location.search);
    document.getElementById('x').innerHTML = params.get('q');
  </script></head><body><div id="x"></div></body></html>`,
  '/xss-document-write-from-hash': `<!doctype html><html><head><script>
    document.write(window.location.hash);
  </script></head><body>x</body></html>`,
  '/xss-innerhtml-from-static': `<!doctype html><html><head><script>
    document.getElementById('x').innerHTML = '<b>Static literal</b>';
  </script></head><body><div id="x"></div></body></html>`,
  '/xss-textcontent-safe': `<!doctype html><html><head><script>
    const params = new URLSearchParams(window.location.search);
    document.getElementById('x').textContent = params.get('q');
  </script></head><body><div id="x"></div></body></html>`,

  // ---- swallowed_error_empty_catch ----
  '/swallowed-empty-catch': `<!doctype html><html><head><script>
    try { JSON.parse('{ broken'); } catch (e) {}
  </script></head><body>x</body></html>`,
  '/swallowed-with-handler': `<!doctype html><html><head><script>
    try { JSON.parse('{ broken'); } catch (e) { console.error('parse failed', e); }
  </script></head><body>x</body></html>`,
  '/swallowed-with-rethrow': `<!doctype html><html><head><script>
    try { riskyOp(); } catch (e) { throw new Error('contextualised: ' + e.message); }
  </script></head><body>x</body></html>`,

  // ---- jwt_weak_alg ----
  // Header { alg: 'none', typ: 'JWT' } base64url-encoded
  '/jwt-alg-none': `<!doctype html><html><head><script>
    const TOKEN = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIxIn0.';
  </script></head><body>x</body></html>`,
  // Header { alg: 'HS256' } — symmetric, weak when shared secret is leaked
  '/jwt-alg-hs256': `<!doctype html><html><head><script>
    const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.aBc';
  </script></head><body>x</body></html>`,
  // Header { alg: 'RS256' } — asymmetric, safe
  '/jwt-alg-rs256': `<!doctype html><html><head><script>
    const TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature';
  </script></head><body>x</body></html>`,
  // No JWT in body
  '/no-jwt': `<!doctype html><html><head><script>
    console.log('hello');
  </script></head><body>x</body></html>`,
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const body = ROUTES[pathname];
  if (body !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`script-checks-mini ready on port ${PORT}\n`);
});
