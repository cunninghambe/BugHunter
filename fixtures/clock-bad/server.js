/**
 * clock-bad fixture — synthetic vulnerable Express server exposing one route per
 * v0.23 BugKind. Deliberately broken date handling for smoke testing.
 *
 * Routes:
 *   GET /              — SPA shell with date input forms
 *   GET /scheduler     — DST-naive scheduler (clock_dst_corruption)
 *   POST /scheduler    — Stores event date without DST conversion
 *   GET /booking       — Feb-29-rejecting form (clock_leap_day_failure)
 *   POST /booking      — Rejects 2024-02-29 with 400
 *   GET /token-verify  — Clock-skew intolerant auth (clock_skew_token_invalid)
 *   POST /token-verify — Accepts JWT only if iat == "now" (±0s tolerance)
 *   GET /dashboard     — Hardcoded LA timezone display (clock_timezone_display)
 *   GET /events        — parseInt(unix-seconds) int32 cast (clock_overflow)
 *   POST /events       — Stores timestamp as int32
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const url = require('url');

const PORT = process.env.PORT || 4999;

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Clock Bad Fixture</title></head>
<body>
<h1>Clock Bad Fixture</h1>
<nav>
  <a href="/scheduler">Scheduler (DST bug)</a> |
  <a href="/booking">Booking (leap-day bug)</a> |
  <a href="/token-verify">Token Verify (skew bug)</a> |
  <a href="/dashboard">Dashboard (TZ bug)</a> |
  <a href="/events">Events (overflow bug)</a>
</nav>
</body>
</html>`;

function schedulerPage() {
  // DST-naive: stores time without TZ info — appears wrong across DST boundary
  const now = new Date();
  // DELIBERATELY BROKEN: formats without TZ offset
  const displayed = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  return `<!DOCTYPE html><html><body>
<h1>Scheduler</h1>
<p>Current time (buggy): ${displayed}</p>
<form method="POST" action="/scheduler">
  <label>Event date: <input type="date" name="date" required></label>
  <button type="submit">Save event</button>
</form>
</body></html>`;
}

function bookingPage(error) {
  return `<!DOCTYPE html><html><body>
<h1>Booking Form</h1>
${error ? `<p style="color:red">${error}</p>` : ''}
<form method="POST" action="/booking">
  <label>Check-in date: <input type="date" name="checkIn" required></label>
  <button type="submit">Book</button>
</form>
</body></html>`;
}

function dashboardPage() {
  const now = new Date();
  // DELIBERATELY BROKEN: hardcoded LA timezone ignoring user profile TZ
  const displayed = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  return `<!DOCTYPE html><html><body>
<h1>Dashboard</h1>
<time datetime="${now.toISOString()}">${displayed} PST</time>
<p>Your activity: <span data-timestamp="${now.getTime()}">just now</span></p>
</body></html>`;
}

function eventsPage() {
  const nowSec = Math.floor(Date.now() / 1000);
  // DELIBERATELY BROKEN: int32 truncation (would overflow at Y2038)
  // eslint-disable-next-line no-bitwise
  const truncated = nowSec | 0;
  const reconstructed = new Date(truncated * 1000);
  const display = isNaN(reconstructed.getTime()) ? 'Invalid Date' : reconstructed.toISOString();
  return `<!DOCTYPE html><html><body>
<h1>Events</h1>
<p>Stored at: ${display}</p>
<form method="POST" action="/events">
  <label>Event time: <input type="date" name="eventDate" required></label>
  <button type="submit">Create event</button>
</form>
</body></html>`;
}

function tokenVerifyPage() {
  return `<!DOCTYPE html><html><body>
<h1>Token Verify</h1>
<form method="POST" action="/token-verify">
  <label>Token: <input type="text" name="token" placeholder="Bearer token"></label>
  <button type="submit">Verify</button>
</form>
</body></html>`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const obj = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      resolve(obj);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Date': new Date().toUTCString() });
    res.end(HTML_SHELL);
    return;
  }

  if (method === 'GET' && path === '/scheduler') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(schedulerPage());
    return;
  }

  if (method === 'POST' && path === '/scheduler') {
    const body = await parseBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stored: body.date }));
    return;
  }

  if (method === 'GET' && path === '/booking') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(bookingPage(null));
    return;
  }

  if (method === 'POST' && path === '/booking') {
    const body = await parseBody(req);
    const checkIn = body.checkIn || '';
    // DELIBERATELY BROKEN: rejects Feb 29 as "invalid date"
    if (checkIn.endsWith('-02-29')) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(bookingPage('Invalid date: February 29 is not supported'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, checkIn }));
    return;
  }

  if (method === 'GET' && path === '/token-verify') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(tokenVerifyPage());
    return;
  }

  if (method === 'POST' && path === '/token-verify') {
    const body = await parseBody(req);
    const token = body.token || '';
    // DELIBERATELY BROKEN: ±0s skew tolerance — any clock skew rejects token
    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate: if token was issued more than 0 seconds ago according to server, reject
    if (token.length > 0 && parseInt(token, 10) < nowSec) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token expired', iat: token, now: nowSec }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && path === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardPage());
    return;
  }

  if (method === 'GET' && path === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(eventsPage());
    return;
  }

  if (method === 'POST' && path === '/events') {
    const body = await parseBody(req);
    const eventDate = body.eventDate || '';
    const ts = Math.floor(new Date(eventDate).getTime() / 1000);
    // DELIBERATELY BROKEN: int32 truncation
    // eslint-disable-next-line no-bitwise
    const stored = ts | 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stored }));
    return;
  }

  // Health check
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Date': new Date().toUTCString() });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  process.stdout.write(`clock-bad fixture listening on http://localhost:${PORT}\n`);
});
