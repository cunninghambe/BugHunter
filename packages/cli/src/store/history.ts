// SQLite history database — project-scoped at <projectDir>/.bughunter/history.db (v0.27).

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { BugCluster, ClusterVerdict, RunState } from '../types.js';

export type HistoryDb = Database.Database;

export const SCHEMA_VERSION = 1;

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

export type RunRow = {
  run_id: string;
  project_name: string;
  started_at: string;
  ended_at: string | null;
  total_clusters: number;
  config_hash: string;
  bughunter_version: string;
};

export type ClusterRow = {
  bug_identity: string;
  run_id: string;
  cluster_id: string;
  kind: string;
  cluster_size: number;
  root_cause: string;
  verdict: ClusterVerdict | null;
};

export type AgingRow = {
  bug_identity: string;
  kind: string;
  first_seen: string;
  last_seen: string;
  run_count: number;
};

export function historyDbPath(projectDir: string): string {
  return path.join(projectDir, '.bughunter', 'history.db');
}

export function openHistoryDb(projectDir: string): HistoryDb {
  fs.mkdirSync(path.dirname(historyDbPath(projectDir)), { recursive: true });
  const db = new Database(historyDbPath(projectDir));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: HistoryDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  if (current === 0) {
    db.exec(SCHEMA_V1);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else {
    throw new Error(
      `history.db user_version=${current} is newer than this BugHunter (supports up to ${SCHEMA_VERSION}). ` +
      `Upgrade BugHunter or delete history.db at ${db.name}.`,
    );
  }
}

export function writeRunToHistory(
  db: HistoryDb,
  runState: RunState,
  clusters: BugCluster[],
  bughunterVersion: string,
): void {
  const insertRun = db.prepare(
    `INSERT OR REPLACE INTO runs (run_id, project_name, started_at, ended_at, total_clusters, config_hash, bughunter_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCluster = db.prepare(
    `INSERT OR REPLACE INTO clusters (bug_identity, run_id, cluster_id, kind, cluster_size, root_cause, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    insertRun.run(
      runState.runId,
      runState.config.projectName,
      runState.startedAt,
      new Date().toISOString(),
      clusters.length,
      configHash(runState.config),
      bughunterVersion,
    );
    for (const c of clusters) {
      if (c.bugIdentity === undefined || c.bugIdentity === '') continue;
      insertCluster.run(
        c.bugIdentity,
        runState.runId,
        c.id,
        c.kind,
        c.clusterSize,
        c.rootCause.slice(0, 4096),
        c.verdict ?? null,
      );
    }
  });
  tx();
}

export function clustersForRun(db: HistoryDb, runId: string): ClusterRow[] {
  return db.prepare(`SELECT * FROM clusters WHERE run_id = ?`).all(runId) as ClusterRow[];
}

export function runsForIdentity(
  db: HistoryDb,
  bugIdentity: string,
): Array<RunRow & { verdict: ClusterVerdict | null; cluster_size: number }> {
  return db.prepare(
    `SELECT r.*, c.verdict, c.cluster_size
     FROM runs r INNER JOIN clusters c ON c.run_id = r.run_id
     WHERE c.bug_identity = ?
     ORDER BY r.started_at ASC`,
  ).all(bugIdentity) as Array<RunRow & { verdict: ClusterVerdict | null; cluster_size: number }>;
}

export function previousRunForProject(
  db: HistoryDb,
  projectName: string,
  excludingRunId: string,
): RunRow | undefined {
  return db.prepare(
    `SELECT * FROM runs WHERE project_name = ? AND run_id != ? ORDER BY started_at DESC LIMIT 1`,
  ).get(projectName, excludingRunId) as RunRow | undefined;
}

export function agingClusters(
  db: HistoryDb,
  projectName: string,
  minDays: number,
  minRuns: number,
): AgingRow[] {
  return db.prepare(
    `SELECT
       c.bug_identity,
       c.kind,
       MIN(r.started_at) AS first_seen,
       MAX(r.started_at) AS last_seen,
       COUNT(DISTINCT c.run_id) AS run_count
     FROM clusters c
     INNER JOIN runs r ON r.run_id = c.run_id
     WHERE r.project_name = ?
       AND c.bug_identity NOT IN (
         SELECT bug_identity FROM clusters WHERE verdict = 'verified_fixed'
       )
     GROUP BY c.bug_identity, c.kind
     HAVING (julianday(MAX(r.started_at)) - julianday(MIN(r.started_at))) >= ?
       AND COUNT(DISTINCT c.run_id) >= ?`,
  ).all(projectName, minDays, minRuns) as AgingRow[];
}

export function updateClusterVerdict(
  db: HistoryDb,
  runId: string,
  bugIdentity: string,
  verdict: ClusterVerdict,
): void {
  db.prepare(
    `UPDATE clusters SET verdict = ? WHERE run_id = ? AND bug_identity = ?`,
  ).run(verdict, runId, bugIdentity);
}

export function runRowExists(db: HistoryDb, runId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(runId);
  return row !== undefined;
}

export function configHash(config: Record<string, unknown>): string {
  const stripped = stripVolatile(config);
  return createHash('sha256').update(JSON.stringify(stripped)).digest('hex').slice(0, 16);
}

function stripVolatile(config: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...config };
  delete copy['apiKey'];
  if (typeof copy['extraHeaders'] === 'object' && copy['extraHeaders'] !== null) {
    const headers = { ...(copy['extraHeaders'] as Record<string, unknown>) };
    delete headers['Authorization'];
    copy['extraHeaders'] = headers;
  }
  return copy;
}
