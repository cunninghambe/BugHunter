// V56.2 smoke tests: idor_horizontal_read + command_injection contracts and fixtures.
//
// Verifies that both DetectorContract entries exist with correct shape,
// registry rows have harness:true, fixture files are present on disk,
// and expected-clusters.jsonl declares 'fires' for each planted bug.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_CONTRACTS } from './contracts.js';
import { DETECTOR_REGISTRY } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CALIBRATION_DIR = path.join(REPO_ROOT, 'fixtures', 'detector-calibration');

function contractFor(kind: string) {
  return DETECTOR_CONTRACTS.find(c => c.kind === kind);
}

function registryFor(kind: string) {
  return DETECTOR_REGISTRY.find(e => e.kind === kind);
}

function loadFixtureClusters(fixturePath: string): Array<{ kind: string; expect: string }> {
  const file = path.join(CALIBRATION_DIR, fixturePath, 'expected-clusters.jsonl');
  const raw = fs.readFileSync(file, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as { kind: string; expect: string });
}

// ---------------------------------------------------------------------------
// idor_horizontal_read
// ---------------------------------------------------------------------------

describe('V56.2 — idor_horizontal_read contract', () => {
  const KIND = 'idor_horizontal_read';
  const FIXTURE = 'idor-mini';

  it('has a DetectorContract entry', () => {
    expect(contractFor(KIND)).toBeDefined();
  });

  it('contract surface is api', () => {
    expect(contractFor(KIND)?.requires.surface).toBe('api');
  });

  it('contract role requires specific roles (alice, bob)', () => {
    const role = contractFor(KIND)?.requires.role;
    expect(role?.kind).toBe('specific');
    if (role?.kind === 'specific') {
      expect(role.roles).toContain('alice');
      expect(role.roles).toContain('bob');
    }
  });

  it('contract fixture path is idor-mini', () => {
    expect(contractFor(KIND)?.fixture.path).toBe(FIXTURE);
  });

  it('contract fixture.servesKinds includes idor_horizontal_read', () => {
    expect(contractFor(KIND)?.fixture.servesKinds).toContain(KIND);
  });

  it('contract defaultBudgetMs is within Tier 1 hard cap (30_000)', () => {
    const budget = contractFor(KIND)?.defaultBudgetMs ?? 0;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(30_000);
  });

  it('registry row has harness:true', () => {
    expect(registryFor(KIND)?.harness).toBe(true);
  });

  it('registry row status is wired', () => {
    expect(registryFor(KIND)?.status).toBe('wired');
  });

  it('fixture directory exists on disk', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE))).toBe(true);
  });

  it('fixture bin/up.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'up.sh'))).toBe(true);
  });

  it('fixture bin/down.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'down.sh'))).toBe(true);
  });

  it('fixture bin/reset.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'reset.sh'))).toBe(true);
  });

  it('fixture expected-clusters.jsonl exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'expected-clusters.jsonl'))).toBe(true);
  });

  it('fixture expected-clusters.jsonl has ≥2 fires assertions for idor_horizontal_read', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const fires = lines.filter(l => l.kind === KIND && l.expect === 'fires');
    expect(fires.length).toBeGreaterThanOrEqual(2);
  });

  it('fixture expected-clusters.jsonl has ≥1 silent assertion (FP boundary)', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const silent = lines.filter(l => l.kind === KIND && l.expect === 'silent');
    expect(silent.length).toBeGreaterThanOrEqual(1);
  });

  it('fixture contract.json serves idor_horizontal_read', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { serves: string[] };
    expect(contractJson.serves).toContain(KIND);
  });

  it('fixture contract.json uses port 9978', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { port: number };
    expect(contractJson.port).toBe(9978);
  });

  it('fixture app/server.js exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'))).toBe(true);
  });

  it('fixture server plants P1 order read without ownership check', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/orders/');
    expect(src).toContain('INTENTIONALLY MISSING');
  });

  it('fixture server plants P2 profile read without identity check', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/users/');
    expect(src).toContain('/profile');
  });

  it('fixture server uses bearer token auth with alice-token and bob-token', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('alice-token');
    expect(src).toContain('bob-token');
    expect(src).toContain('Bearer');
  });

  it('fixture server requires auth on /api/ routes (401 without token)', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('401');
    expect(src).toContain('unauthorized');
  });

  it('fixture server has reset endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/__bughunter_reset');
  });

  it('fixture up.sh uses port 9978', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'up.sh'), 'utf-8');
    expect(src).toContain('PORT=9978');
  });
});

// ---------------------------------------------------------------------------
// command_injection
// ---------------------------------------------------------------------------

describe('V56.2 — command_injection contract', () => {
  const KIND = 'command_injection';
  const FIXTURE = 'command-injection-mini';

  it('has a DetectorContract entry', () => {
    expect(contractFor(KIND)).toBeDefined();
  });

  it('contract surface is api', () => {
    expect(contractFor(KIND)?.requires.surface).toBe('api');
  });

  it('contract role is none (unauthenticated endpoint)', () => {
    expect(contractFor(KIND)?.requires.role.kind).toBe('none');
  });

  it('contract pageContext scopes to /api/admin/health', () => {
    const ctx = contractFor(KIND)?.requires.pageContext;
    expect(ctx?.kind).toBe('specific-routes');
    if (ctx?.kind === 'specific-routes') {
      expect(ctx.routes).toContain('/api/admin/health');
    }
  });

  it('contract fixture path is command-injection-mini', () => {
    expect(contractFor(KIND)?.fixture.path).toBe(FIXTURE);
  });

  it('contract fixture.servesKinds includes command_injection', () => {
    expect(contractFor(KIND)?.fixture.servesKinds).toContain(KIND);
  });

  it('contract defaultBudgetMs is within Tier 1 hard cap (30_000)', () => {
    const budget = contractFor(KIND)?.defaultBudgetMs ?? 0;
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(30_000);
  });

  it('registry row has harness:true', () => {
    expect(registryFor(KIND)?.harness).toBe(true);
  });

  it('registry row status is wired', () => {
    expect(registryFor(KIND)?.status).toBe('wired');
  });

  it('fixture directory exists on disk', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE))).toBe(true);
  });

  it('fixture bin/up.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'up.sh'))).toBe(true);
  });

  it('fixture bin/down.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'down.sh'))).toBe(true);
  });

  it('fixture bin/reset.sh exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'reset.sh'))).toBe(true);
  });

  it('fixture expected-clusters.jsonl exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'expected-clusters.jsonl'))).toBe(true);
  });

  it('fixture expected-clusters.jsonl has ≥2 fires assertions for command_injection', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const fires = lines.filter(l => l.kind === KIND && l.expect === 'fires');
    expect(fires.length).toBeGreaterThanOrEqual(2);
  });

  it('fixture expected-clusters.jsonl has ≥1 silent assertion (FP boundary)', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const silent = lines.filter(l => l.kind === KIND && l.expect === 'silent');
    expect(silent.length).toBeGreaterThanOrEqual(1);
  });

  it('fixture contract.json serves command_injection', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { serves: string[] };
    expect(contractJson.serves).toContain(KIND);
  });

  it('fixture contract.json uses port 9979', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { port: number };
    expect(contractJson.port).toBe(9979);
  });

  it('fixture app/server.js exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'))).toBe(true);
  });

  it('fixture server plants P1 target field shell concat', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain("'ping -c 1 ' + body.target");
    expect(src).toContain('INTENTIONALLY UNSAFE');
  });

  it('fixture server plants P2 domain field shell concat', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain("'nslookup ' + body.domain");
  });

  it('fixture server uses exec() for shell invocation', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain("require('node:child_process')");
    expect(src).toContain('exec(');
  });

  it('fixture server has reset endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/__bughunter_reset');
  });

  it('fixture up.sh uses port 9979', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'bin', 'up.sh'), 'utf-8');
    expect(src).toContain('PORT=9979');
  });
});
