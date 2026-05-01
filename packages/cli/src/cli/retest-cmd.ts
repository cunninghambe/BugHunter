// bughunter retest — JSON-output CLI op (§ 3.9.1).

import type { ClusterVerdict, RetestVerdict, BugCluster } from '../types.js';
import { retestOp } from '../ops/retest.js';
import { openHistoryDb, updateClusterVerdict } from '../store/history.js';
import { historyDbPath, runPaths } from '../store/filesystem.js';
import { log } from '../log.js';
import * as fs from 'node:fs';

export async function retestCommand(
  projectDir: string,
  runId: string,
  clusterId: string,
  baseBranch: string | undefined,
  fixBranch: string | undefined,
): Promise<void> {
  const result = await retestOp(projectDir, runId, clusterId, baseBranch, fixBranch);
  process.stdout.write(`${JSON.stringify(result)}\n`);

  const verdict = toClusterVerdict(result.verdict);
  if (verdict === undefined) return;

  // Update history.db verdict after retest (EC-9).
  if (!fs.existsSync(historyDbPath(projectDir))) return;
  const cluster = loadCluster(projectDir, runId, clusterId);
  if (cluster?.bugIdentity === undefined || cluster.bugIdentity === '') return;

  try {
    const db = openHistoryDb(projectDir);
    try {
      updateClusterVerdict(db, runId, cluster.bugIdentity, verdict);
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('retest: failed to update history.db verdict (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toClusterVerdict(retestVerdict: RetestVerdict): ClusterVerdict | undefined {
  const map: Partial<Record<RetestVerdict, ClusterVerdict>> = {
    verified_fixed: 'verified_fixed',
    verified_fixed_by_removal: 'verified_fixed_by_removal',
    partially_verified: 'partially_verified',
    not_fixed: 'not_fixed',
    verified_fixed_static: 'verified_fixed',
    not_fixed_static: 'not_fixed',
    partially_verified_static: 'partially_verified',
  };
  return map[retestVerdict];
}

function loadCluster(projectDir: string, runId: string, clusterId: string): BugCluster | undefined {
  const bugsFile = runPaths(projectDir, runId).bugsFile;
  if (!fs.existsSync(bugsFile)) return undefined;
  const lines = fs.readFileSync(bugsFile, 'utf-8').split('\n').filter(l => l.trim() !== '');
  for (const line of lines) {
    try {
      const cluster = JSON.parse(line) as BugCluster;
      if (cluster.id === clusterId) return cluster;
    } catch { /* skip */ }
  }
  return undefined;
}
