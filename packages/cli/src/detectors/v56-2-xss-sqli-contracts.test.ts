// V56.2 smoke tests: xss_reflected + sql_injection contracts and fixtures.
//
// Verifies that both DetectorContract entries exist with correct shape,
// registry rows have harness:true, fixture files are present on disk,
// and expected-clusters.jsonl entries declare 'fires' for each planted bug.

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
// xss_reflected
// ---------------------------------------------------------------------------

describe('V56.2 — xss_reflected contract', () => {
  const KIND = 'xss_reflected';
  const FIXTURE = 'xss-mini';

  it('has a DetectorContract entry', () => {
    expect(contractFor(KIND)).toBeDefined();
  });

  it('contract surface is api', () => {
    expect(contractFor(KIND)?.requires.surface).toBe('api');
  });

  it('contract role is none (no auth required)', () => {
    expect(contractFor(KIND)?.requires.role.kind).toBe('none');
  });

  it('contract fixture path is xss-mini', () => {
    expect(contractFor(KIND)?.fixture.path).toBe(FIXTURE);
  });

  it('contract fixture.servesKinds includes xss_reflected', () => {
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

  it('fixture expected-clusters.jsonl has ≥3 fires assertions for xss_reflected', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const fires = lines.filter(l => l.kind === KIND && l.expect === 'fires');
    expect(fires.length).toBeGreaterThanOrEqual(3);
  });

  it('fixture contract.json serves xss_reflected', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { serves: string[] };
    expect(contractJson.serves).toContain(KIND);
  });

  it('fixture app/server.js exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'))).toBe(true);
  });

  it('fixture server plants P1 echo endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/echo');
    expect(src).toContain('INTENTIONALLY UNSAFE');
  });

  it('fixture server plants P2 search endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/search');
  });

  it('fixture server plants P3 comments endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/comments');
  });

  it('fixture server has reset endpoint', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/__bughunter_reset');
  });
});

// ---------------------------------------------------------------------------
// sql_injection
// ---------------------------------------------------------------------------

describe('V56.2 — sql_injection contract', () => {
  const KIND = 'sql_injection';
  const FIXTURE = 'sqli-mini';

  it('has a DetectorContract entry', () => {
    expect(contractFor(KIND)).toBeDefined();
  });

  it('contract surface is api', () => {
    expect(contractFor(KIND)?.requires.surface).toBe('api');
  });

  it('contract role is none (no auth required)', () => {
    expect(contractFor(KIND)?.requires.role.kind).toBe('none');
  });

  it('contract fixture path is sqli-mini', () => {
    expect(contractFor(KIND)?.fixture.path).toBe(FIXTURE);
  });

  it('contract fixture.servesKinds includes sql_injection', () => {
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

  it('fixture expected-clusters.jsonl has ≥3 fires assertions for sql_injection', () => {
    const lines = loadFixtureClusters(FIXTURE);
    const fires = lines.filter(l => l.kind === KIND && l.expect === 'fires');
    expect(fires.length).toBeGreaterThanOrEqual(3);
  });

  it('fixture contract.json serves sql_injection', () => {
    const contractJson = JSON.parse(
      fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'contract.json'), 'utf-8'),
    ) as { serves: string[] };
    expect(contractJson.serves).toContain(KIND);
  });

  it('fixture app/server.js exists', () => {
    expect(fs.existsSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'))).toBe(true);
  });

  it('fixture server plants P1 /api/search?q= injection', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/search');
    expect(src).toContain('INTENTIONALLY UNSAFE');
  });

  it('fixture server plants P2 /api/admin/reports?filter= injection', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/admin/reports');
  });

  it('fixture server plants P3 /api/tasks?label= injection', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/api/tasks');
  });

  it('fixture server uses better-sqlite3', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('better-sqlite3');
  });

  it('fixture server has reset endpoint that rebuilds database', () => {
    const src = fs.readFileSync(path.join(CALIBRATION_DIR, FIXTURE, 'app', 'server.js'), 'utf-8');
    expect(src).toContain('/__bughunter_reset');
    expect(src).toContain('createDb');
  });
});

// ---------------------------------------------------------------------------
// Lockstep: new contracts in DETECTOR_CONTRACTS are 1:1 with harness:true rows
// ---------------------------------------------------------------------------

describe('V56.2 lockstep — xss_reflected + sql_injection', () => {
  it('DETECTOR_CONTRACTS includes xss_reflected and sql_injection', () => {
    const kinds = DETECTOR_CONTRACTS.map(c => c.kind);
    expect(kinds).toContain('xss_reflected');
    expect(kinds).toContain('sql_injection');
  });

  it('both contracts have no duplicate entry', () => {
    const xssContracts = DETECTOR_CONTRACTS.filter(c => c.kind === 'xss_reflected');
    const sqliContracts = DETECTOR_CONTRACTS.filter(c => c.kind === 'sql_injection');
    expect(xssContracts).toHaveLength(1);
    expect(sqliContracts).toHaveLength(1);
  });
});
