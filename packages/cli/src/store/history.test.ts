import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { HistoryDb, ClusterRow } from './history.js';
import {
  writeRunToHistory,
  clustersForRun,
  runsForIdentity,
  previousRunForProject,
  agingClusters,
  updateClusterVerdict,
  runRowExists,
  configHash,
  SCHEMA_VERSION,
} from './history.js';
import type { BugCluster, RunState } from '../types.js';

// The schema SQL mirrored here so tests don't touch the filesystem.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  project_name        TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  total_clusters      INTEGER NOT NULL,
  config_hash         TEXT NOT NULL,
  bughunter_version   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
  bug_identity        TEXT NOT NULL,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  cluster_id          TEXT NOT NULL,
  kind                TEXT NOT NULL,
  cluster_size        INTEGER NOT NULL,
  root_cause          TEXT NOT NULL,
  verdict             TEXT,
  PRIMARY KEY (bug_identity, run_id)
);
CREATE INDEX IF NOT EXISTS clusters_by_run        ON clusters(run_id);
CREATE INDEX IF NOT EXISTS clusters_by_identity   ON clusters(bug_identity);
CREATE INDEX IF NOT EXISTS runs_by_project_started ON runs(project_name, started_at DESC);
`;

function openMemoryDb(): HistoryDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_V1);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-1',
    projectDir: '/tmp/test-project',
    startedAt: '2026-01-01T00:00:00.000Z',
    phase: 'emit',
    config: {
      projectName: 'test-project',
      surfaceMcpUrl: 'http://localhost:3000',
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
    ...overrides,
  } as RunState;
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-1',
    kind: 'console_error',
    rootCause: 'TypeError: foo is undefined',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    bugIdentity: 'abcdef1234567890',
    ...overrides,
  } as BugCluster;
}

describe('writeRunToHistory', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('inserts a runs row', () => {
    writeRunToHistory(db, makeRunState(), [], '0.1.0');
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get('run-1') as Record<string, unknown>;
    expect(row['run_id']).toBe('run-1');
    expect(row['project_name']).toBe('test-project');
  });

  it('inserts clusters rows for clusters with bugIdentity', () => {
    writeRunToHistory(db, makeRunState(), [makeCluster()], '0.1.0');
    const rows = clustersForRun(db, 'run-1') as ClusterRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bug_identity).toBe('abcdef1234567890');
  });

  it('skips clusters without bugIdentity', () => {
    writeRunToHistory(db, makeRunState(), [makeCluster({ bugIdentity: undefined })], '0.1.0');
    expect(clustersForRun(db, 'run-1')).toHaveLength(0);
  });

  it('is idempotent — INSERT OR REPLACE on re-ingest', () => {
    const cluster = makeCluster();
    writeRunToHistory(db, makeRunState(), [cluster], '0.1.0');
    writeRunToHistory(db, makeRunState(), [cluster], '0.1.0');
    expect(clustersForRun(db, 'run-1')).toHaveLength(1);
  });

  it('truncates root_cause to 4096 chars', () => {
    writeRunToHistory(db, makeRunState(), [makeCluster({ rootCause: 'x'.repeat(5000) })], '0.1.0');
    const rows = clustersForRun(db, 'run-1') as ClusterRow[];
    expect(rows[0]?.root_cause).toHaveLength(4096);
  });
});

describe('runsForIdentity', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('returns runs containing the given bugIdentity, oldest first', () => {
    const identity = 'deadbeef01234567';
    const state1 = makeRunState({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' });
    const state2 = makeRunState({ runId: 'run-2', startedAt: '2026-01-02T00:00:00.000Z' });
    writeRunToHistory(db, state1, [makeCluster({ bugIdentity: identity })], '0.1.0');
    writeRunToHistory(db, state2, [makeCluster({ bugIdentity: identity, id: 'cluster-2', runId: 'run-2' })], '0.1.0');
    const rows = runsForIdentity(db, identity);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.run_id).toBe('run-1');
    expect(rows[1]?.run_id).toBe('run-2');
  });
});

describe('previousRunForProject', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('returns the most recent run excluding the current one', () => {
    writeRunToHistory(db, makeRunState({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' }), [], '0.1.0');
    writeRunToHistory(db, makeRunState({ runId: 'run-2', startedAt: '2026-01-02T00:00:00.000Z' }), [], '0.1.0');
    expect(previousRunForProject(db, 'test-project', 'run-2')?.run_id).toBe('run-1');
  });

  it('returns undefined when no prior runs exist', () => {
    writeRunToHistory(db, makeRunState(), [], '0.1.0');
    expect(previousRunForProject(db, 'test-project', 'run-1')).toBeUndefined();
  });
});

describe('updateClusterVerdict', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('updates the verdict for a specific (runId, bugIdentity) pair', () => {
    writeRunToHistory(db, makeRunState(), [makeCluster()], '0.1.0');
    updateClusterVerdict(db, 'run-1', 'abcdef1234567890', 'verified_fixed');
    const rows = clustersForRun(db, 'run-1') as ClusterRow[];
    expect(rows[0]?.verdict).toBe('verified_fixed');
  });
});

describe('runRowExists', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('returns true when run exists, false otherwise', () => {
    writeRunToHistory(db, makeRunState(), [], '0.1.0');
    expect(runRowExists(db, 'run-1')).toBe(true);
    expect(runRowExists(db, 'no-such-run')).toBe(false);
  });
});

describe('agingClusters', () => {
  let db: HistoryDb;
  beforeEach(() => { db = openMemoryDb(); });

  it('returns clusters open across >= minDays and >= minRuns', () => {
    const identity = 'aging0000test0001';
    const state1 = makeRunState({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' });
    const state2 = makeRunState({ runId: 'run-2', startedAt: '2026-01-10T00:00:00.000Z' });
    const state3 = makeRunState({ runId: 'run-3', startedAt: '2026-01-15T00:00:00.000Z' });
    writeRunToHistory(db, state1, [makeCluster({ bugIdentity: identity })], '0.1.0');
    writeRunToHistory(db, state2, [makeCluster({ bugIdentity: identity, id: 'c2', runId: 'run-2' })], '0.1.0');
    writeRunToHistory(db, state3, [makeCluster({ bugIdentity: identity, id: 'c3', runId: 'run-3' })], '0.1.0');
    const rows = agingClusters(db, 'test-project', 7, 2);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.bug_identity).toBe(identity);
  });

  it('excludes clusters with verdict verified_fixed', () => {
    const identity = 'fixedidentity0001';
    const state1 = makeRunState({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' });
    const state2 = makeRunState({ runId: 'run-2', startedAt: '2026-01-10T00:00:00.000Z' });
    writeRunToHistory(db, state1, [makeCluster({ bugIdentity: identity })], '0.1.0');
    writeRunToHistory(db, state2, [makeCluster({ bugIdentity: identity, id: 'c2', runId: 'run-2' })], '0.1.0');
    updateClusterVerdict(db, 'run-1', identity, 'verified_fixed');
    const rows = agingClusters(db, 'test-project', 1, 1);
    expect(rows.find(r => r.bug_identity === identity)).toBeUndefined();
  });
});

describe('configHash', () => {
  it('strips apiKey and Authorization header before hashing', () => {
    const c1 = { projectName: 'test', apiKey: 'secret-1', extraHeaders: { Authorization: 'Bearer tok-1' } };
    const c2 = { projectName: 'test', apiKey: 'secret-2', extraHeaders: { Authorization: 'Bearer tok-2' } };
    expect(configHash(c1 as unknown as Record<string, unknown>))
      .toBe(configHash(c2 as unknown as Record<string, unknown>));
  });

  it('different projectNames produce different hashes', () => {
    expect(configHash({ projectName: 'alpha' } as unknown as Record<string, unknown>))
      .not.toBe(configHash({ projectName: 'beta' } as unknown as Record<string, unknown>));
  });
});
