// v0.35: resolves a <bug-id> argument to an action log + cluster snapshot.
// Accepts: 16-hex bugIdentity, cuid cluster id, or occurrenceId.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openHistoryDb } from '../../store/history.js';
import { listRunIds, runPaths } from '../../store/filesystem.js';
import { readActionLog } from '../../repro/action-log.js';
import type { ActionLog } from '../../repro/action-log.js';
import type { BugCluster } from '../../types.js';
import type { BisectClusterSnapshot } from '../../types.js';

const BUG_IDENTITY_RE = /^[0-9a-f]{16}$/;
const CUID_RE = /^c[a-z0-9]{24,}$/;

type BugIdKind = 'bugIdentity' | 'clusterId' | 'occurrenceId';

function classifyBugId(bugId: string): BugIdKind {
  if (BUG_IDENTITY_RE.test(bugId)) return 'bugIdentity';
  if (CUID_RE.test(bugId)) return 'clusterId';
  return 'occurrenceId';
}

export type ResolvedBug = {
  occurrenceId: string;
  runId: string;
  actionLog: ActionLog;
  cluster: BisectClusterSnapshot;
};

type ClusterMatch = {
  cluster: BugCluster;
  runId: string;
  startedAt: string;
};

/** Scan all runs on disk and return cluster matches for the given predicate. */
function scanRunsForClusters(
  projectDir: string,
  predicate: (cluster: BugCluster) => boolean,
): ClusterMatch[] {
  const runIds = listRunIds(projectDir);
  const matches: ClusterMatch[] = [];

  for (const runId of runIds) {
    const paths = runPaths(projectDir, runId);
    if (!fs.existsSync(paths.bugsFile)) continue;
    const lines = fs.readFileSync(paths.bugsFile, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const cluster = JSON.parse(line) as BugCluster;
        if (predicate(cluster)) {
          const stateRaw = fs.existsSync(paths.stateFile)
            ? (JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as { startedAt?: string })
            : {};
          matches.push({ cluster, runId, startedAt: stateRaw.startedAt ?? runId });
        }
      } catch { /* corrupt line — skip */ }
    }
  }
  return matches;
}

/** Find the most-recent action log for a cluster's occurrences. */
function findMostRecentActionLog(
  projectDir: string,
  cluster: BugCluster,
  runId: string,
): ActionLog | null {
  const paths = runPaths(projectDir, runId);
  for (const occ of cluster.occurrences) {
    try {
      return readActionLog(paths.actionLogsDir, occ.occurrenceId);
    } catch { /* not found */ }
  }
  return null;
}

function clusterToSnapshot(cluster: BugCluster): BisectClusterSnapshot {
  const errorText = cluster.rootCause.includes(':') ? cluster.rootCause.split(':')[1]?.trim() : undefined;
  return {
    id: cluster.id,
    kind: cluster.kind,
    rootCause: cluster.rootCause,
    signatureKey: cluster.signatureKey,
    bugIdentity: cluster.bugIdentity,
    errorText,
  };
}

function resolveFromMatches(
  projectDir: string,
  matches: ClusterMatch[],
  bugId: string,
): ResolvedBug {
  if (matches.length === 0) {
    const runCount = listRunIds(projectDir).length;
    throw new Error(
      `No bug found for id "${bugId}". ` +
      `Searched ${runCount} run(s). ` +
      `Run 'bughunter list' to see available bugs.`,
    );
  }

  // Sort descending by startedAt, pick most recent with action log
  const sorted = [...matches].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  for (const { cluster, runId } of sorted) {
    const actionLog = findMostRecentActionLog(projectDir, cluster, runId);
    if (actionLog !== null) {
      return {
        occurrenceId: actionLog.occurrenceId,
        runId,
        actionLog,
        cluster: clusterToSnapshot(cluster),
      };
    }
  }

  throw new Error(
    `Found ${matches.length} cluster(s) for "${bugId}" but none have a readable action log on disk. ` +
    `The run artifacts may have been pruned.`,
  );
}

function resolveByBugIdentity(projectDir: string, bugId: string): ResolvedBug {
  // Try history.db first
  let dbMatches: ClusterMatch[] = [];
  try {
    const db = openHistoryDb(projectDir);
    const rows = db.prepare(
      `SELECT c.cluster_id, c.run_id, c.kind, c.root_cause, r.started_at
       FROM clusters c INNER JOIN runs r ON r.run_id = c.run_id
       WHERE c.bug_identity = ?
       ORDER BY r.started_at DESC`,
    ).all(bugId) as Array<{ cluster_id: string; run_id: string; kind: string; root_cause: string; started_at: string }>;
    db.close();

    for (const row of rows) {
      const paths = runPaths(projectDir, row.run_id);
      if (!fs.existsSync(paths.bugsFile)) continue;
      const lines = fs.readFileSync(paths.bugsFile, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const cluster = JSON.parse(line) as BugCluster;
          if (cluster.id === row.cluster_id) {
            dbMatches.push({ cluster, runId: row.run_id, startedAt: row.started_at });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* history.db may not exist */ }

  // Fall back to filesystem scan if db found nothing
  if (dbMatches.length === 0) {
    dbMatches = scanRunsForClusters(projectDir, c => c.bugIdentity === bugId);
  }

  return resolveFromMatches(projectDir, dbMatches, bugId);
}

function resolveByClusterId(projectDir: string, bugId: string): ResolvedBug {
  const matches = scanRunsForClusters(projectDir, c => c.id === bugId);
  return resolveFromMatches(projectDir, matches, bugId);
}

function resolveByOccurrenceId(projectDir: string, bugId: string): ResolvedBug {
  const runIds = listRunIds(projectDir);
  for (const runId of [...runIds].reverse()) {
    const paths = runPaths(projectDir, runId);
    try {
      const actionLog = readActionLog(paths.actionLogsDir, bugId);
      // Find matching cluster
      const clusterSnapshot = findClusterForOccurrence(projectDir, runId, bugId);
      return { occurrenceId: bugId, runId, actionLog, cluster: clusterSnapshot };
    } catch { /* not in this run */ }
  }
  throw new Error(
    `No action log found for occurrenceId "${bugId}". ` +
    `Run 'bughunter list' to see available occurrences.`,
  );
}

function findClusterForOccurrence(projectDir: string, runId: string, occurrenceId: string): BisectClusterSnapshot {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.bugsFile)) {
    return { id: '', kind: 'dom_error_text', rootCause: '' };
  }
  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const cluster = JSON.parse(line) as BugCluster;
      if (cluster.occurrences.some(o => o.occurrenceId === occurrenceId)) {
        return clusterToSnapshot(cluster);
      }
    } catch { /* skip */ }
  }
  return { id: '', kind: 'dom_error_text', rootCause: '' };
}

/** Resolve a <bug-id> (bugIdentity | clusterId | occurrenceId) to an action log. */
export function resolveBugId(projectDir: string, bugId: string): ResolvedBug {
  const kind = classifyBugId(bugId);
  switch (kind) {
    case 'bugIdentity': return resolveByBugIdentity(projectDir, bugId);
    case 'clusterId': return resolveByClusterId(projectDir, bugId);
    case 'occurrenceId': return resolveByOccurrenceId(projectDir, bugId);
  }
}

/** Copy a resolved action log to the bisect-runs directory. */
export function copyActionLogToBisectRun(actionLog: ActionLog, destPath: string): void {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, `${JSON.stringify(actionLog, null, 2)}\n`);
}
