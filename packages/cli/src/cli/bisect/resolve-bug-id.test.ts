import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBugId } from './resolve-bug-id.js';
import type { ActionLog } from '../../repro/action-log.js';
import type { BugCluster } from '../../types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bh-bisect-test-'));
}

function writeActionLog(projectDir: string, runId: string, occurrenceId: string): void {
  const actionLogsDir = path.join(projectDir, '.bughunter', 'runs', runId, 'action-logs');
  fs.mkdirSync(actionLogsDir, { recursive: true });
  const log: ActionLog = {
    occurrenceId,
    runId,
    role: 'user',
    page: '/products',
    baseUrl: 'http://localhost:3000',
    actions: [],
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(actionLogsDir, `${occurrenceId}.json`), JSON.stringify(log));
}

function writeCluster(projectDir: string, runId: string, cluster: BugCluster): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const stateFile = path.join(runDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ startedAt: '2026-04-01T00:00:00.000Z' }));
  const bugsFile = path.join(runDir, 'bugs.jsonl');
  fs.appendFileSync(bugsFile, `${JSON.stringify(cluster)}\n`);
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'ctest123456789012345678901',
    runId: 'run-001',
    kind: 'dom_error_text',
    rootCause: 'Error text "Something went wrong" found on /products',
    firstSeenAt: '2026-04-01T00:00:00.000Z',
    lastSeenAt: '2026-04-01T00:00:00.000Z',
    clusterSize: 1,
    occurrences: [{ occurrenceId: 'occ-abc123', role: 'user', page: '/products', action: { kind: 'navigate', via: 'ui', expectedOutcome: 'success', palette: 'happy' }, fullArtifacts: false, timestamp: '2026-04-01T00:00:00.000Z' }],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    bugIdentity: 'abcdef1234567890',
    signatureKey: 'dom_error_text:/products:Something went wrong',
    ...overrides,
  };
}

describe('resolveBugId', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('resolves by bugIdentity (16-hex)', () => {
    const cluster = makeCluster({ bugIdentity: 'abcdef1234567890' });
    writeCluster(tmpDir, 'run-001', cluster);
    writeActionLog(tmpDir, 'run-001', 'occ-abc123');

    const result = resolveBugId(tmpDir, 'abcdef1234567890');
    expect(result.occurrenceId).toBe('occ-abc123');
    expect(result.runId).toBe('run-001');
    expect(result.cluster.kind).toBe('dom_error_text');
  });

  it('resolves by cluster id (cuid)', () => {
    const cluster = makeCluster();
    writeCluster(tmpDir, 'run-001', cluster);
    writeActionLog(tmpDir, 'run-001', 'occ-abc123');

    const result = resolveBugId(tmpDir, 'ctest123456789012345678901');
    expect(result.occurrenceId).toBe('occ-abc123');
  });

  it('resolves by occurrenceId', () => {
    const cluster = makeCluster();
    writeCluster(tmpDir, 'run-001', cluster);
    writeActionLog(tmpDir, 'run-001', 'occ-abc123');

    const result = resolveBugId(tmpDir, 'occ-abc123');
    expect(result.occurrenceId).toBe('occ-abc123');
  });

  it('picks the most recent run when multiple match by bugIdentity', () => {
    const cluster1 = makeCluster({ id: 'ctest000000000000000000001', runId: 'run-001' });
    const cluster2 = makeCluster({ id: 'ctest000000000000000000002', runId: 'run-002' });

    writeCluster(tmpDir, 'run-001', cluster1);
    writeActionLog(tmpDir, 'run-001', 'occ-older');

    // run-002 is newer (later startedAt)
    const runDir2 = path.join(tmpDir, '.bughunter', 'runs', 'run-002');
    fs.mkdirSync(runDir2, { recursive: true });
    fs.writeFileSync(path.join(runDir2, 'state.json'), JSON.stringify({ startedAt: '2026-04-30T00:00:00.000Z' }));
    const cluster2WithOcc = { ...cluster2, occurrences: [{ occurrenceId: 'occ-newer', role: 'user', page: '/products', action: { kind: 'navigate' as const, via: 'ui' as const, expectedOutcome: 'success' as const, palette: 'happy' as const }, fullArtifacts: false as const, timestamp: '2026-04-30T00:00:00.000Z' }] };
    fs.writeFileSync(path.join(runDir2, 'bugs.jsonl'), `${JSON.stringify(cluster2WithOcc)}\n`);
    writeActionLog(tmpDir, 'run-002', 'occ-newer');

    const result = resolveBugId(tmpDir, 'abcdef1234567890');
    expect(result.occurrenceId).toBe('occ-newer');
  });

  it('throws when bug not found', () => {
    expect(() => resolveBugId(tmpDir, 'abcdef1234567890')).toThrow(/No bug found/);
  });

  it('throws when cluster exists but action log is missing', () => {
    const cluster = makeCluster();
    writeCluster(tmpDir, 'run-001', cluster);
    // No action log written

    expect(() => resolveBugId(tmpDir, 'abcdef1234567890')).toThrow(/action log/i);
  });
});
