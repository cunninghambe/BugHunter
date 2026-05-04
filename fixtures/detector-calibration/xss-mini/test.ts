// Integration smoke test for xss-mini / xss_reflected detector.
// Boots the fixture, sends XSS payloads to each plant, asserts the response
// reflects the payload unescaped. Does NOT depend on the full BugHunter
// phase pipeline — validates the fixture itself is correctly planted.
//
// Run: npx tsx fixtures/detector-calibration/xss-mini/test.ts
// Or:  bughunter test-detector xss_reflected

import * as http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9971;
const BASE = `http://127.0.0.1:${PORT}`;
const PID_FILE = path.join(FIXTURE_ROOT, '.pid');

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function post(url: string, body: string, contentType = 'application/json'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function waitForPort(port: number, maxMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, () => { req.destroy(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > maxMs) { reject(new Error(`port ${port} did not come up`)); return; }
        setTimeout(check, 200);
      });
    };
    check();
  });
}

async function main(): Promise<void> {
  // Boot fixture
  process.stderr.write('[xss-mini/test.ts] Booting fixture...\n');
  const child = spawn('node', [path.join(FIXTURE_ROOT, 'app', 'server.js')], {
    env: { ...process.env, XSS_MINI_PORT: String(PORT) },
    stdio: 'pipe',
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.stderr?.pipe(process.stderr);

  try {
    await waitForPort(PORT);

    const PAYLOAD = '<script>alert(1)</script>';
    const ENCODED_PAYLOAD = encodeURIComponent(PAYLOAD);

    // P1: /api/echo?msg= reflects payload
    const p1 = await get(`${BASE}/api/echo?msg=${ENCODED_PAYLOAD}`);
    if (!p1.body.includes(PAYLOAD)) {
      throw new Error(`P1 FAIL: /api/echo did not reflect payload. body=${p1.body}`);
    }
    process.stderr.write('[xss-mini/test.ts] P1 PASS: /api/echo reflects payload\n');

    // P2: /api/search?q= reflects payload
    const p2 = await get(`${BASE}/api/search?q=${ENCODED_PAYLOAD}`);
    if (!p2.body.includes(PAYLOAD)) {
      throw new Error(`P2 FAIL: /api/search did not reflect payload. body=${p2.body}`);
    }
    process.stderr.write('[xss-mini/test.ts] P2 PASS: /api/search reflects payload\n');

    // P3: POST /api/comments stores payload; GET /api/comments reflects it
    await post(`${BASE}/api/comments`, JSON.stringify({ comment: PAYLOAD }));
    const p3 = await get(`${BASE}/api/comments`);
    if (!p3.body.includes(PAYLOAD)) {
      throw new Error(`P3 FAIL: /api/comments did not reflect stored payload. body=${p3.body}`);
    }
    process.stderr.write('[xss-mini/test.ts] P3 PASS: /api/comments reflects stored payload\n');

    // Reset
    await post(`${BASE}/__bughunter_reset`, '{}');

    process.stderr.write('[xss-mini/test.ts] ALL PLANTS VERIFIED — fixture is correctly planted\n');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[xss-mini/test.ts] FAILED: ${String(err)}\n`);
  process.exit(1);
});
