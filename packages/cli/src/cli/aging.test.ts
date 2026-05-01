import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { HistoryDb } from '../store/history.js';
import { writeRunToHistory } from '../store/history.js';
import { agingCommand } from './aging.js';
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

function writeConfig(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, '.bughunter'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.bughunter', 'config.json'),
    JSON.stringify({ projectName: 'test-project', surfaceMcpUrl: 'http://localhost:3000' }),
  );
}

function makeRunState(runId: string, startedAt: string): RunState {
  return {
    runId, projectDir: '', startedAt, phase: 'emit',
    config: { projectName: 'test-project', surfaceMcpUrl: 'http://localhost:3000' },
    clusterCount: 0, infraFailureCount: 0, consecutiveInfraFailures: 0, emitted: false, partialEmit: false,
  } as RunState;
}

function makeCluster(bugIdentity: string, runId: string): BugCluster {
  return {
    id: `cluster-${bugIdentity.slice(0, 8)}`, runId, kind: 'network_5xx',
    rootCause: 'Server returned 500',
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
    clusterSize: 1, occurrences: [], suspectedFiles: [], fixHints: [],
    thirdPartyOrGenerated: false, bugIdentity,
  } as BugCluster;
}

describe('agingCommand', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-aging-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('prints informational message when history.db absent', () => {
    writeConfig(tmpDir);
    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { agingCommand(tmpDir, {}); }
    finally { process.stdout.write = orig; }
    expect(output.join('')).toContain('No history found');
  });

  it('lists clusters open >= threshold days across >= min-runs', () => {
    writeConfig(tmpDir);
    const db = setupTestDb(tmpDir);
    const identity = 'agingcluster00001';
    writeRunToHistory(db, makeRunState('run-1', '2026-01-01T00:00:00.000Z'), [makeCluster(identity, 'run-1')], '0.1.0');
    writeRunToHistory(db, makeRunState('run-2', '2026-01-10T00:00:00.000Z'), [{ ...makeCluster(identity, 'run-2'), id: 'c2' }], '0.1.0');
    writeRunToHistory(db, makeRunState('run-3', '2026-01-15T00:00:00.000Z'), [{ ...makeCluster(identity, 'run-3'), id: 'c3' }], '0.1.0');
    db.close();

    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { agingCommand(tmpDir, { thresholdDays: 7, minRuns: 2 }); }
    finally { process.stdout.write = orig; }
    expect(output.join('')).toContain(identity);
  });

  it('shows empty message when no clusters meet threshold', () => {
    writeConfig(tmpDir);
    const db = setupTestDb(tmpDir);
    writeRunToHistory(db, makeRunState('run-1', '2026-01-01T00:00:00.000Z'), [], '0.1.0');
    db.close();

    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { agingCommand(tmpDir, { thresholdDays: 7, minRuns: 3 }); }
    finally { process.stdout.write = orig; }
    expect(output.join('')).toContain('No clusters open');
  });
});
