// bughunter prune — delete .bughunter/runs/<id>/ older than 30 days.
// With --rebuild-identity: backfill bugIdentity on legacy bugs.jsonl and rebuild history.db.

import { pruneRuns, listRunIds, runPaths } from '../store/filesystem.js';
import { openHistoryDb, writeRunToHistory } from '../store/history.js';
import { computeBugIdentity } from '../cluster/bug-identity.js';
import { loadConfig } from '../config.js';
import type { BugCluster, RunState } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneCommand(
  projectDir: string,
  opts: { rebuildIdentity?: boolean; force?: boolean } = {},
): void {
  if (opts.rebuildIdentity === true) {
    rebuildIdentity(projectDir, opts.force === true);
    return;
  }

  const pruned = pruneRuns(projectDir, THIRTY_DAYS_MS);
  if (pruned.length === 0) {
    process.stdout.write('No runs to prune.\n');
  } else {
    process.stdout.write(`Pruned ${pruned.length} run(s): ${pruned.join(', ')}\n`);
  }
}

function rebuildIdentity(projectDir: string, force: boolean): void {
  // CAUTION: ensure no concurrent `bughunter run` is active before calling this.
  const config = loadConfig(projectDir);
  const projectName = config.projectName;
  const runIds = listRunIds(projectDir);

  process.stdout.write(`Rebuilding bugIdentity for ${runIds.length} run(s)...\n`);

  let totalRewritten = 0;
  let totalSkipped = 0;

  for (const runId of runIds) {
    const paths = runPaths(projectDir, runId);
    if (!fs.existsSync(paths.bugsFile)) continue;

    const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(l => l.trim() !== '');
    let anyChanged = false;
    const rewritten: string[] = [];

    for (const line of lines) {
      let cluster: BugCluster;
      try {
        cluster = JSON.parse(line) as BugCluster;
      } catch {
        rewritten.push(line);
        continue;
      }

      if (cluster.signatureKey === undefined || cluster.signatureKey === '') {
        process.stdout.write(`  [skip] run ${runId}: cluster ${cluster.id} has no signatureKey\n`);
        totalSkipped++;
        rewritten.push(line);
        continue;
      }

      if (cluster.bugIdentity !== undefined && !force) {
        rewritten.push(line);
        continue;
      }

      cluster.bugIdentity = computeBugIdentity(projectName, cluster.signatureKey);
      anyChanged = true;
      rewritten.push(JSON.stringify(cluster));
    }

    if (anyChanged) {
      const tmpFile = path.join(os.tmpdir(), `bughunter-rewrite-${runId}.jsonl`);
      fs.writeFileSync(tmpFile, `${rewritten.join('\n')}\n`);
      fs.renameSync(tmpFile, paths.bugsFile);
      totalRewritten++;
      process.stdout.write(`  [ok] run ${runId}: rewritten\n`);
    }
  }

  // Rebuild history.db from scratch.
  const dbPath = path.join(projectDir, '.bughunter', 'history.db');
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath);
    process.stdout.write('Dropped existing history.db; rebuilding...\n');
  }

  const db = openHistoryDb(projectDir);
  try {
    for (const runId of runIds) {
      const paths = runPaths(projectDir, runId);
      if (!fs.existsSync(paths.bugsFile) || !fs.existsSync(paths.stateFile)) continue;

      let runState: RunState;
      try {
        runState = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as RunState;
      } catch {
        continue;
      }

      const clusterLines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(l => l.trim() !== '');
      const clusters: BugCluster[] = [];
      for (const line of clusterLines) {
        try { clusters.push(JSON.parse(line) as BugCluster); } catch { /* skip */ }
      }

      try {
        writeRunToHistory(db, runState, clusters, '0.1.0');
      } catch (err) {
        process.stdout.write(`  [warn] failed to write run ${runId} to history.db: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } finally {
    db.close();
  }

  process.stdout.write(
    `Done. Rewrote ${totalRewritten} run(s). Skipped ${totalSkipped} cluster(s) with no signatureKey.\n`,
  );
}
