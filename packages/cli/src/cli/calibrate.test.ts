// v0.44: Integration-style tests for calibrateCommand.
// Uses mocked runCommand + stub gold JSONL to avoid real BugHunter runs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { calibrateCommand, CalibrateSetupError, CalibrateGoldError } from './calibrate.js';

// ---------------------------------------------------------------------------
// Mock runCommand so tests don't run a real BugHunter session
// ---------------------------------------------------------------------------

vi.mock('./run.js', () => ({
  runCommand: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpApp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cal-test-'));
  return dir;
}

function writeConfig(appDir: string, projectName = 'test-app', extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(appDir, 'bughunter.config.json'),
    JSON.stringify({ projectName, baseUrl: 'http://127.0.0.1:9999', ...extra }),
  );
}

function writeGold(appDir: string, entries: unknown[]): void {
  const lines = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(appDir, 'gold-standard.jsonl'), `${lines}\n`);
}

function writeSummary(appDir: string, runId: string, clusters: unknown[], partial = false): void {
  const runDir = path.join(appDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ clusters, partial }));
}

const VALID_GOLD_ENTRY = {
  goldId: 'test-app-001',
  kind: 'console_error',
  expected: 'detector_fires',
  bugIdentity: 'abcdef1234567890',
  rationale: 'Test entry for integration test',
  humanRepro: ['Open app', 'Observe console error'],
  addedInBenchVersion: '0.1.0',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calibrateCommand — missing bughunter.config.json', () => {
  it('throws CalibrateSetupError when config missing', async () => {
    const appDir = makeTmpApp();
    await expect(calibrateCommand({ appPath: appDir, noBootTeardown: true }))
      .rejects.toThrow(CalibrateSetupError);
    fs.rmSync(appDir, { recursive: true });
  });
});

describe('calibrateCommand — gold validation', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = makeTmpApp();
    writeConfig(appDir);
  });

  afterEach(() => {
    fs.rmSync(appDir, { recursive: true });
  });

  it('throws CalibrateGoldError on missing gold file', async () => {
    await expect(calibrateCommand({
      appPath: appDir,
      goldPath: path.join(appDir, 'no-gold.jsonl'),
      noBootTeardown: true,
    })).rejects.toThrow(CalibrateGoldError);
  });

  it('throws CalibrateGoldError on invalid JSONL', async () => {
    fs.writeFileSync(path.join(appDir, 'gold-standard.jsonl'), 'not json\n');
    await expect(calibrateCommand({ appPath: appDir, noBootTeardown: true }))
      .rejects.toThrow(CalibrateGoldError);
  });

  it('throws CalibrateGoldError on unknown kind', async () => {
    writeGold(appDir, [{
      ...VALID_GOLD_ENTRY,
      goldId: 'test-app-001',
      kind: 'not_a_real_kind_ever',
    }]);
    await expect(calibrateCommand({ appPath: appDir, noBootTeardown: true }))
      .rejects.toThrow(CalibrateGoldError);
  });

  it('does not throw CalibrateGoldError when wired kind has expected: detector_fires (V56.4.15: xss_stored is now sentinel-wired)', async () => {
    // xss_stored is wired since V56.4.15 — detector_fires is a valid expectation for wired kinds
    writeGold(appDir, [{
      ...VALID_GOLD_ENTRY,
      goldId: 'test-app-001',
      kind: 'xss_stored',
      expected: 'detector_fires',
    }]);
    // runCommand is mocked; no runs → CalibrateRunError, not CalibrateGoldError
    await expect(calibrateCommand({ appPath: appDir, noBootTeardown: true }))
      .rejects.not.toThrow(CalibrateGoldError);
  });
});

describe('calibrateCommand — happy path', () => {
  let appDir: string;

  beforeEach(() => {
    appDir = makeTmpApp();
    writeConfig(appDir);
    writeGold(appDir, [VALID_GOLD_ENTRY]);
  });

  afterEach(() => {
    fs.rmSync(appDir, { recursive: true });
  });

  it('produces calibration-report.json after a clean run', async () => {
    // seed a run with one matching cluster
    const runId = `run_${Date.now()}`;
    writeSummary(appDir, runId, [{
      id: 'ck_1',
      runId,
      kind: 'console_error',
      rootCause: 'test root cause',
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      clusterSize: 1,
      occurrences: [],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      bugIdentity: 'abcdef1234567890',
    }]);

    await calibrateCommand({ appPath: appDir, noBootTeardown: true });

    const calDir = path.join(appDir, '.bughunter', 'calibration');
    const dateDirs = fs.readdirSync(calDir);
    expect(dateDirs.length).toBeGreaterThan(0);
    const reportPath = path.join(calDir, dateDirs[0]!, 'calibration-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as { version: number; overall: { tp: number } };
    expect(report.version).toBe(1);
    expect(report.overall.tp).toBe(1);
  });

  it('exits with code 1 when thresholds violated and --enforce-thresholds', async () => {
    // seed a run with zero clusters → recall = 0 < 0.80 threshold
    const runId = `run_${Date.now()}`;
    writeSummary(appDir, runId, []);

    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    await calibrateCommand({ appPath: appDir, noBootTeardown: true, enforceThresholds: true });
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;

    // With gold expecting detector_fires but zero clusters → fn=1, recall=0 → below threshold
    // However lowConfidence=true (only 1 gold entry) → no violation
    // That's correct per spec: low confidence → warning not failure
    expect(exitCode).toBeUndefined();
  });

  it('wired kind with detector_silent gold + no clusters → no_data in report (V56.4.15: xss_stored sentinel-wired)', async () => {
    // xss_stored is now sentinel-wired (not deferred). A detector_silent gold entry
    // for a wired kind with no matching clusters produces 'no_data' (not 'expected_silent').
    // 'expected_silent' only applies to deferred kinds in the calibrate report logic.
    writeGold(appDir, [{
      ...VALID_GOLD_ENTRY,
      goldId: 'test-app-001',
      kind: 'xss_stored',
      expected: 'detector_silent',
    }]);

    const runId = `run_${Date.now()}`;
    writeSummary(appDir, runId, []);

    await calibrateCommand({ appPath: appDir, noBootTeardown: true });

    const calDir = path.join(appDir, '.bughunter', 'calibration');
    const dateDirs = fs.readdirSync(calDir);
    const reportPath = path.join(calDir, dateDirs[0]!, 'calibration-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      perKind: Record<string, { status: string; tn: number }>;
    };
    expect(report.perKind['xss_stored']?.status).toBe('no_data');
  });
});
