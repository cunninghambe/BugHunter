// bughunter diff — compare two runs from history.db and bucket clusters.

import type { BugKind } from '../types.js';
import type { ClusterRow } from '../store/history.js';
import { openHistoryDb, clustersForRun, runRowExists } from '../store/history.js';
import { historyDbPath } from '../store/filesystem.js';
import { formatSarif } from './diff-format-sarif.js';
import * as fs from 'node:fs';

type DiffBuckets = {
  new: ClusterRow[];
  persistent: ClusterRow[];
  gone: ClusterRow[];
  regressed: ClusterRow[];
};

export function diffCommand(
  projectDir: string,
  opts: {
    runIdOld: string;
    runIdNew: string;
    format?: 'table' | 'json' | 'sarif';
    filter?: { kind?: BugKind };
  },
): void {
  if (!fs.existsSync(historyDbPath(projectDir))) {
    process.stdout.write('No history found. Run `bughunter run` first to build history.db.\n');
    return;
  }

  const db = openHistoryDb(projectDir);
  try {
    if (!runRowExists(db, opts.runIdOld)) {
      throw new Error(`Run not found in history: ${opts.runIdOld}`);
    }
    if (!runRowExists(db, opts.runIdNew)) {
      throw new Error(`Run not found in history: ${opts.runIdNew}`);
    }

    const oldClusters = clustersForRun(db, opts.runIdOld);
    const newClusters = clustersForRun(db, opts.runIdNew);
    const buckets = computeBuckets(oldClusters, newClusters);
    const filtered = applyFilter(buckets, opts.filter);

    const format = opts.format ?? 'table';
    if (format === 'json') {
      const output = {
        runIdOld: opts.runIdOld,
        runIdNew: opts.runIdNew,
        buckets: filtered,
        generatedAt: new Date().toISOString(),
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else if (format === 'sarif') {
      process.stdout.write(`${formatSarif(filtered.new, filtered.regressed)}\n`);
    } else {
      renderTable(opts.runIdOld, opts.runIdNew, filtered);
    }
  } finally {
    db.close();
  }
}

function computeBuckets(oldClusters: ClusterRow[], newClusters: ClusterRow[]): DiffBuckets {
  const oldByIdentity = new Map(oldClusters.map(c => [c.bug_identity, c]));
  const newByIdentity = new Map(newClusters.map(c => [c.bug_identity, c]));

  const newBucket: ClusterRow[] = [];
  const persistent: ClusterRow[] = [];
  const regressed: ClusterRow[] = [];

  for (const c of newClusters) {
    const prior = oldByIdentity.get(c.bug_identity);
    if (prior === undefined) newBucket.push(c);
    else if (prior.verdict === 'verified_fixed') regressed.push(c);
    else persistent.push(c);
  }

  const gone: ClusterRow[] = [];
  for (const c of oldClusters) {
    if (!newByIdentity.has(c.bug_identity)) gone.push(c);
  }

  return { new: newBucket, persistent, gone, regressed };
}

function applyFilter(buckets: DiffBuckets, filter: { kind?: BugKind } | undefined): DiffBuckets {
  if (filter?.kind === undefined) return buckets;
  const byKind = (rows: ClusterRow[]): ClusterRow[] => rows.filter(r => r.kind === filter.kind);
  return {
    new: byKind(buckets.new),
    persistent: byKind(buckets.persistent),
    gone: byKind(buckets.gone),
    regressed: byKind(buckets.regressed),
  };
}

function renderTable(runIdOld: string, runIdNew: string, buckets: DiffBuckets): void {
  const lines: string[] = [
    `\n=== BugHunter diff: ${runIdOld} → ${runIdNew} ===`,
  ];
  const sections: Array<{ label: string; rows: ClusterRow[] }> = [
    { label: 'NEW', rows: buckets.new },
    { label: 'REGRESSED', rows: buckets.regressed },
    { label: 'PERSISTENT', rows: buckets.persistent },
    { label: 'GONE', rows: buckets.gone },
  ];

  for (const { label, rows } of sections) {
    lines.push(`\n[${label}] ${rows.length} cluster(s)`);
    if (rows.length > 0) {
      const header = `${'IDENTITY'.padEnd(18)}  ${'KIND'.padEnd(32)}  ${'SIZE'.padEnd(4)}  ROOT_CAUSE`;
      lines.push(header);
      lines.push('-'.repeat(header.length));
      for (const r of rows) {
        const identity = r.bug_identity.padEnd(18);
        const kind = r.kind.padEnd(32);
        const size = String(r.cluster_size).padEnd(4);
        const cause = r.root_cause.slice(0, 60);
        lines.push(`${identity}  ${kind}  ${size}  ${cause}`);
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
