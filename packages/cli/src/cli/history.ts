// bughunter history — query cross-run history from history.db.

import type { BugKind } from '../types.js';
import type { RunRow, HistoryDb } from '../store/history.js';
import { openHistoryDb, runsForIdentity } from '../store/history.js';
import { historyDbPath } from '../store/filesystem.js';
import * as fs from 'node:fs';

export function historyCommand(
  projectDir: string,
  opts: {
    kind?: BugKind;
    limit?: number;
    bugIdentity?: string;
    format?: 'table' | 'json';
  },
): void {
  if (!fs.existsSync(historyDbPath(projectDir))) {
    process.stdout.write('No history found. Run `bughunter run` first to build history.db.\n');
    return;
  }

  const db = openHistoryDb(projectDir);
  try {
    if (opts.bugIdentity !== undefined) {
      renderIdentityLifecycle(opts.bugIdentity, opts.format ?? 'table', db);
    } else if (opts.kind !== undefined) {
      renderByKind(opts.kind, opts.limit ?? 30, opts.format ?? 'table', db);
    } else {
      renderSummary(opts.limit ?? 30, opts.format ?? 'table', db);
    }
  } finally {
    db.close();
  }
}

function renderIdentityLifecycle(bugIdentity: string, format: 'table' | 'json', db: HistoryDb): void {
  const rows = runsForIdentity(db, bugIdentity);
  if (rows.length === 0) {
    process.stdout.write(`No history found for bug identity: ${bugIdentity}\n`);
    return;
  }

  const fixAttempts = rows.filter(r =>
    r.verdict === 'verified_fixed' ||
    r.verdict === 'verified_fixed_by_removal' ||
    r.verdict === 'partially_verified',
  ).length;

  let regressions = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1]?.verdict === 'verified_fixed') regressions++;
  }

  const lifecycle = {
    bugIdentity,
    firstSeen: rows[0].started_at,
    lastSeen: rows[rows.length - 1].started_at,
    fixAttempts,
    regressions,
    runs: rows.map(r => ({
      runId: r.run_id,
      startedAt: r.started_at,
      clusterSize: r.cluster_size,
      verdict: r.verdict,
    })),
  };

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(lifecycle, null, 2)}\n`);
  } else {
    const lines = [
      `\n=== Bug Identity Lifecycle: ${bugIdentity} ===`,
      `First seen: ${lifecycle.firstSeen}`,
      `Last seen:  ${lifecycle.lastSeen}`,
      `Fix attempts: ${fixAttempts}  Regressions: ${regressions}`,
      '',
      `${'RUN_ID'.padEnd(32)}  ${'STARTED_AT'.padEnd(24)}  ${'SIZE'.padEnd(4)}  VERDICT`,
      '-'.repeat(80),
    ];
    for (const r of lifecycle.runs) {
      const runId = r.runId.padEnd(32);
      const started = r.startedAt.padEnd(24);
      const size = String(r.clusterSize).padEnd(4);
      lines.push(`${runId}  ${started}  ${size}  ${r.verdict ?? '—'}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

function renderByKind(kind: string, limit: number, format: 'table' | 'json', db: HistoryDb): void {
  const rows = db.prepare(
    `SELECT r.run_id, r.started_at, c.cluster_size, c.verdict
     FROM clusters c INNER JOIN runs r ON r.run_id = c.run_id
     WHERE c.kind = ?
     ORDER BY r.started_at DESC
     LIMIT ?`,
  ).all(kind, limit) as Array<{ run_id: string; started_at: string; cluster_size: number; verdict: string | null }>;

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ kind, runs: rows }, null, 2)}\n`);
    return;
  }

  const lines = [`\n=== History for kind: ${kind} (newest first, limit ${limit}) ===`];
  if (rows.length === 0) {
    lines.push('No records found.');
  } else {
    lines.push(`${'RUN_ID'.padEnd(32)}  ${'STARTED_AT'.padEnd(24)}  ${'SIZE'.padEnd(4)}  VERDICT`);
    lines.push('-'.repeat(76));
    for (const r of rows) {
      lines.push(`${r.run_id.padEnd(32)}  ${r.started_at.padEnd(24)}  ${String(r.cluster_size).padEnd(4)}  ${r.verdict ?? '—'}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderSummary(limit: number, format: 'table' | 'json', db: HistoryDb): void {
  const totalRuns = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
  const totalIdentities = (db.prepare('SELECT COUNT(DISTINCT bug_identity) AS n FROM clusters').get() as { n: number }).n;
  const topKinds = db.prepare(
    `SELECT kind, COUNT(DISTINCT bug_identity) AS unique_bugs
     FROM clusters GROUP BY kind ORDER BY unique_bugs DESC LIMIT 5`,
  ).all() as Array<{ kind: string; unique_bugs: number }>;
  const oldestOpen = db.prepare(
    `SELECT c.bug_identity, c.kind, MIN(r.started_at) AS first_seen
     FROM clusters c INNER JOIN runs r ON r.run_id = c.run_id
     WHERE c.bug_identity NOT IN (SELECT bug_identity FROM clusters WHERE verdict = 'verified_fixed')
     GROUP BY c.bug_identity ORDER BY first_seen ASC LIMIT 1`,
  ).get() as { bug_identity: string; kind: string; first_seen: string } | undefined;
  const recentRuns = db.prepare(
    `SELECT run_id, project_name, started_at, total_clusters FROM runs ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as RunRow[];

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ totalRuns, totalIdentities, topKinds, oldestOpen, recentRuns }, null, 2)}\n`);
    return;
  }

  const lines = [
    '\n=== BugHunter History Summary ===',
    `Total runs: ${totalRuns}`,
    `Unique bug identities: ${totalIdentities}`,
    '',
    'Top 5 kinds by unique identity:',
    ...topKinds.map(k => `  ${k.kind}: ${k.unique_bugs}`),
  ];
  if (oldestOpen !== undefined) {
    lines.push('', `Oldest open: ${oldestOpen.bug_identity} (${oldestOpen.kind}) since ${oldestOpen.first_seen}`);
  }
  lines.push('', `Recent ${Math.min(limit, recentRuns.length)} runs:`);
  for (const r of recentRuns) {
    lines.push(`  ${r.run_id} | ${r.project_name} | ${r.started_at} | ${r.total_clusters} clusters`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
