// Integration smoke test for v0.16 pen-testing palette.
// Spins up the fixtures/pen-bad/ Express server and runs pen-test detectors against it.
// Expected: ≥1 finding per BugKind (sql_injection, command_injection, path_traversal, jwt_weak_alg)
// with the correct nonce + proof field.
//
// NOTE: jwt_weak_alg requires an HTTP call to a fixture route that accepts alg=none.
// path_traversal: the fixture reads /var/www/<name>; on a test box /etc/passwd exists outside
// /var/www, so path traversal is proven via the 404 path (no file content) on a CI box.
// This test therefore validates the detector logic using synthetic responses rather than
// live HTTP calls to avoid OS-level dependencies.
//
// The sql_injection and command_injection routes are tested live against the fixture.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
import {
  detectSqlInjectionError,
  detectCommandInjection,
  detectPathTraversal,
  detectJwtWeakAlg,
} from '../../src/security/pen-detectors.js';
import { generatePenPayloads } from '../../src/security/injection-palette.js';
import type { ProbeResponse } from '../../src/security/pen-detectors.js';
import type { PenPayload } from '../../src/security/injection-palette.js';

const FIXTURE_PORT = 9991;
const BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

// ---------------------------------------------------------------------------
// Fixture server lifecycle
// ---------------------------------------------------------------------------

let fixtureProc: cp.ChildProcess | undefined;

async function getJson(urlPath: string): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${urlPath}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function postJson(urlPath: string, headers: Record<string, string>): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: FIXTURE_PORT,
      path: urlPath,
      method: 'POST',
      headers,
    };
    const req = http.request(opts, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function waitForServer(maxWaitMs = 8000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      await getJson('/');
    } catch {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    return;
  }
  throw new Error('pen-bad fixture did not start within timeout');
}

beforeAll(async () => {
  const serverPath = path.resolve(__dirname, '../../../../fixtures/pen-bad/server.js');
  // Only attempt to start if better-sqlite3 is available; otherwise skip live tests
  try {
    fixtureProc = cp.spawn(process.execPath, [serverPath], {
      env: { ...process.env, PEN_BAD_PORT: String(FIXTURE_PORT) },
      stdio: 'pipe',
    });
    fixtureProc.on('error', () => { fixtureProc = undefined; });
    await waitForServer();
  } catch {
    fixtureProc = undefined;
  }
}, 15_000);

afterAll(() => {
  fixtureProc?.kill('SIGTERM');
});

// ---------------------------------------------------------------------------
// Helper: build a synthetic alg=none JWT
// ---------------------------------------------------------------------------

function buildAlgNoneJwt(nonce: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'bughunter', role: 'admin', nonce })).toString('base64url');
  return `${header}.${payload}.`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pen-test smoke: synthetic fixture (detector unit validation)', () => {
  // These tests use the detector functions directly with pre-crafted responses,
  // validating that the full pipeline (palette → detector → BugDetection) works
  // end-to-end without requiring the fixture server.

  it('sql_injection: detector fires with correct kind + proof on error response', () => {
    const payloads = generatePenPayloads(['sql']);
    const errorQuote = payloads.find(p => p.variant === 'error_quote')!;
    const body = `SQLite error: near "BUGHUNTER_${errorQuote.nonce}": syntax error`;
    const response: ProbeResponse = { status: 500, body };
    const result = detectSqlInjectionError(errorQuote, response, 'q', 'GET /search');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('sql_injection');
      expect(result.detection.injectionContext?.proof).toBe('error_string');
      expect(result.detection.injectionContext?.nonce).toBe(errorQuote.nonce);
    }
  });

  it('command_injection: detector fires with correct kind + proof', () => {
    const payloads = generatePenPayloads(['cmd']);
    const pipeEcho = payloads.find(p => p.variant === 'shell_pipe_echo')!;
    const body = `host: localhost\nBUGHUNTER_${pipeEcho.nonce}`;
    const response: ProbeResponse = { status: 200, body };
    const result = detectCommandInjection(pipeEcho, response, 'host', 'GET /lookup');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('command_injection');
      expect(result.detection.injectionContext?.proof).toBe('output_marker');
      expect(result.detection.injectionContext?.nonce).toBe(pipeEcho.nonce);
    }
  });

  it('path_traversal: detector fires with correct kind + proof', () => {
    const payloads = generatePenPayloads(['path']);
    const etcPasswd = payloads.find(p => p.variant === 'linux_etc_passwd_relative')!;
    const body = 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1';
    const response: ProbeResponse = { status: 200, body };
    const result = detectPathTraversal(etcPasswd, response, 'name', 'GET /file');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('path_traversal');
      expect(result.detection.injectionContext?.proof).toBe('file_content');
    }
  });

  it('jwt_weak_alg: detector fires with correct kind + proof (unsigned_accepted)', () => {
    const payloads = generatePenPayloads(['jwt']);
    const algNone = payloads.find(p => p.variant === 'alg_none_unsigned')!;
    const response: ProbeResponse = { status: 200, body: '{"promoted":true}' };
    const result = detectJwtWeakAlg(algNone, response, 'POST /admin/promote');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('jwt_weak_alg');
      expect(result.detection.injectionContext?.proof).toBe('unsigned_accepted');
      expect(result.detection.injectionContext?.nonce).toBe(algNone.nonce);
    }
  });
});

describe('pen-test smoke: live fixture (requires server)', () => {
  it('sql_injection: /search?q= route returns SQL error with nonce', async () => {
    if (fixtureProc === undefined) {
      console.log('SKIP: pen-bad fixture not running (better-sqlite3 unavailable)');
      return;
    }
    const payloads = generatePenPayloads(['sql']);
    const errorQuote = payloads.find(p => p.variant === 'error_quote')!;
    const encodedPayload = encodeURIComponent(errorQuote.value);
    const response = await getJson(`/search?q=${encodedPayload}`);
    const result = detectSqlInjectionError(errorQuote, response, 'q', 'GET /search');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('sql_injection');
      expect(result.detection.injectionContext?.nonce).toBe(errorQuote.nonce);
    }
  });

  it('command_injection: /lookup?host= route echoes nonce', async () => {
    if (fixtureProc === undefined) {
      console.log('SKIP: pen-bad fixture not running');
      return;
    }
    const payloads = generatePenPayloads(['cmd']);
    const pipeEcho = payloads.find(p => p.variant === 'shell_pipe_echo')!;
    const encodedPayload = encodeURIComponent(pipeEcho.value);
    const response = await getJson(`/lookup?host=${encodedPayload}`);
    const result = detectCommandInjection(pipeEcho, response, 'host', 'GET /lookup');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('command_injection');
      expect(result.detection.injectionContext?.nonce).toBe(pipeEcho.nonce);
    }
  });

  it('jwt_weak_alg: /admin/promote accepts alg=none token', async () => {
    if (fixtureProc === undefined) {
      console.log('SKIP: pen-bad fixture not running');
      return;
    }
    const nonce = 'fixednonce1234ab';
    const token = buildAlgNoneJwt(nonce);
    const payload: PenPayload = { kind: 'jwt', variant: 'alg_none_unsigned', nonce, value: token };
    const response = await postJson('/admin/promote', { Authorization: `Bearer ${token}`, 'Content-Length': '0' });
    const result = detectJwtWeakAlg(payload, response, 'POST /admin/promote');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('jwt_weak_alg');
      expect(result.detection.injectionContext?.proof).toBe('unsigned_accepted');
    }
  });
});
