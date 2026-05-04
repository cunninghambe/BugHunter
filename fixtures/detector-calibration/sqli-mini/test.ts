// Integration smoke test for sqli-mini / sql_injection detector.
// Boots the fixture, sends SQLi payloads to each plant, asserts the response
// contains a SQLite error (proving the payload was interpolated into SQL).
// Does NOT depend on the full BugHunter phase pipeline — validates the
// fixture itself is correctly planted.
//
// Run: npx tsx fixtures/detector-calibration/sqli-mini/test.ts
// Or:  bughunter test-detector sql_injection

import * as http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';

const FIXTURE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(FIXTURE_ROOT, 'app');
const PORT = 9972;
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

function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
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

// Returns true if the response demonstrates error-based SQL injection.
function provedInjection(res: { status: number; body: string }): boolean {
  return res.status === 500 && res.body.includes('SQLite error');
}

async function main(): Promise<void> {
  process.stderr.write('[sqli-mini/test.ts] Booting fixture...\n');

  // Install better-sqlite3 if needed
  if (!fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
    process.stderr.write('[sqli-mini/test.ts] Installing dependencies...\n');
    const { execFileSync } = await import('node:child_process');
    execFileSync('npm', ['install', '--no-fund', '--no-audit', '--quiet'], { cwd: APP_DIR, stdio: 'inherit' });
  }

  const child = spawn('node', [path.join(APP_DIR, 'server.js')], {
    env: { ...process.env, SQLI_MINI_PORT: String(PORT) },
    stdio: 'pipe',
    cwd: APP_DIR,
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.stderr?.pipe(process.stderr);

  try {
    await waitForPort(PORT);

    // Error-based payload: unbalanced quote causes a SQLite parse error,
    // returning a 500 with "SQLite error" in the body.
    const PAYLOAD = "'";
    const ENCODED = encodeURIComponent(PAYLOAD);

    // P1: /api/search?q= — concatenated into LIKE
    const p1 = await get(`${BASE}/api/search?q=${ENCODED}`);
    if (!provedInjection(p1)) {
      throw new Error(`P1 FAIL: /api/search did not demonstrate SQL injection. status=${p1.status} body=${p1.body}`);
    }
    process.stderr.write('[sqli-mini/test.ts] P1 PASS: /api/search demonstrates SQL injection\n');

    // P2: /api/admin/reports?filter= — concatenated into WHERE
    const p2 = await get(`${BASE}/api/admin/reports?filter=${ENCODED}`);
    if (!provedInjection(p2)) {
      throw new Error(`P2 FAIL: /api/admin/reports did not demonstrate SQL injection. status=${p2.status} body=${p2.body}`);
    }
    process.stderr.write('[sqli-mini/test.ts] P2 PASS: /api/admin/reports demonstrates SQL injection\n');

    // P3: /api/tasks?label= — concatenated into WHERE
    const p3 = await get(`${BASE}/api/tasks?label=${ENCODED}`);
    if (!provedInjection(p3)) {
      throw new Error(`P3 FAIL: /api/tasks did not demonstrate SQL injection. status=${p3.status} body=${p3.body}`);
    }
    process.stderr.write('[sqli-mini/test.ts] P3 PASS: /api/tasks demonstrates SQL injection\n');

    // Reset
    await post(`${BASE}/__bughunter_reset`, '{}');

    process.stderr.write('[sqli-mini/test.ts] ALL PLANTS VERIFIED — fixture is correctly planted\n');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[sqli-mini/test.ts] FAILED: ${String(err)}\n`);
  process.exit(1);
});
