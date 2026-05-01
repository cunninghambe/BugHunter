import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { HistoryDb } from '../store/history.js';
import { writeRunToHistory, updateClusterVerdict } from '../store/history.js';
import { diffCommand } from './diff.js';
import type { BugCluster, RunState } from '../types.js';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, project_name TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, total_clusters INTEGER NOT NULL, config_hash TEXT NOT NULL, bughunter_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
  bug_identity TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL, kind TEXT NOT NULL, cluster_size INTEGER NOT NULL,
  root_cause TEXT NOT NULL, verdict TEXT, PRIMARY KEY (bug_identity, run_id)
);
CREATE INDEX IF NOT EXISTS clusters_by_run ON clusters(run_id);
CREATE INDEX IF NOT EXISTS clusters_by_identity ON clusters(bug_identity);
CREATE INDEX IF NOT EXISTS runs_by_project_started ON runs(project_name, started_at DESC);
`;

function setupTestDb(projectDir: string): HistoryDb {
  fs.mkdirSync(path.join(projectDir, '.bughunter'), { recursive: true });
  const db = new Database(path.join(projectDir, '.bughunter', 'history.db'));
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_V1);
  db.pragma('user_version = 1');
  return db;
}

function makeRunState(runId: string, startedAt: string): RunState {
  return {
    runId, projectDir: '', startedAt, phase: 'emit',
    config: { projectName: 'test-project', surfaceMcpUrl: 'http://localhost:3000' },
    clusterCount: 0, infraFailureCount: 0, consecutiveInfraFailures: 0, emitted: false, partialEmit: false,
  } as RunState;
}

function makeCluster(bugIdentity: string, runId: string, kind = 'console_error'): BugCluster {
  return {
    id: `cluster-${bugIdentity.slice(0, 8)}`, runId, kind,
    rootCause: `Root cause for ${bugIdentity}`,
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
    clusterSize: 1, occurrences: [], suspectedFiles: [], fixHints: [],
    thirdPartyOrGenerated: false, bugIdentity,
  } as BugCluster;
}

describe('diffCommand', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-diff-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('prints informational message when history.db absent', () => {
    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { diffCommand(tmpDir, { runIdOld: 'run-1', runIdNew: 'run-2' }); }
    finally { process.stdout.write = orig; }
    expect(output.join('')).toContain('No history found');
  });

  it('buckets new/persistent/gone/regressed correctly', () => {
    const db = setupTestDb(tmpDir);
    writeRunToHistory(db, makeRunState('run-A', '2026-01-01T00:00:00.000Z'), [
      makeCluster('persist000000000', 'run-A'),
      makeCluster('gone000000000000', 'run-A'),
      makeCluster('regressed0000000', 'run-A'),
    ], '0.1.0');
    updateClusterVerdict(db, 'run-A', 'regressed0000000', 'verified_fixed');
    writeRunToHistory(db, makeRunState('run-B', '2026-01-02T00:00:00.000Z'), [
      makeCluster('new0000000000000', 'run-B'),
      makeCluster('persist000000000', 'run-B'),
      makeCluster('regressed0000000', 'run-B'),
    ], '0.1.0');
    db.close();

    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { diffCommand(tmpDir, { runIdOld: 'run-A', runIdNew: 'run-B' }); }
    finally { process.stdout.write = orig; }

    const text = output.join('');
    expect(text).toContain('[NEW] 1');
    expect(text).toContain('[PERSISTENT] 1');
    expect(text).toContain('[GONE] 1');
    expect(text).toContain('[REGRESSED] 1');
  });

  it('outputs JSON when --format json', () => {
    const db = setupTestDb(tmpDir);
    writeRunToHistory(db, makeRunState('run-A', '2026-01-01T00:00:00.000Z'), [], '0.1.0');
    writeRunToHistory(db, makeRunState('run-B', '2026-01-02T00:00:00.000Z'), [], '0.1.0');
    db.close();

    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { diffCommand(tmpDir, { runIdOld: 'run-A', runIdNew: 'run-B', format: 'json' }); }
    finally { process.stdout.write = orig; }
    const parsed = JSON.parse(output.join('')) as { runIdOld: string };
    expect(parsed.runIdOld).toBe('run-A');
  });

  it('filters by kind', () => {
    const db = setupTestDb(tmpDir);
    writeRunToHistory(db, makeRunState('run-A', '2026-01-01T00:00:00.000Z'), [], '0.1.0');
    writeRunToHistory(db, makeRunState('run-B', '2026-01-02T00:00:00.000Z'), [
      makeCluster('aaaa000000000001', 'run-B', 'console_error'),
      makeCluster('aaaa000000000002', 'run-B', 'network_5xx'),
    ], '0.1.0');
    db.close();

    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { diffCommand(tmpDir, { runIdOld: 'run-A', runIdNew: 'run-B', filter: { kind: 'console_error' } }); }
    finally { process.stdout.write = orig; }

    const text = output.join('');
    expect(text).toContain('[NEW] 1');
    expect(text).toContain('aaaa000000000001');
    expect(text).not.toContain('aaaa000000000002');
  });
});
