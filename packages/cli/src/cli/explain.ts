import * as fs from 'node:fs';
import { listRunIds, runPaths, fileExists } from '../store/filesystem.js';
import { explainCluster } from '../explain/index.js';
import type { BugCluster } from '../types.js';

export type ExplainCliOpts = {
  projectDir: string;
  clusterId: string;
  noCache?: boolean;
  runId?: string;
};

export async function explainCliCommand(opts: ExplainCliOpts): Promise<void> {
  const { projectDir, clusterId, noCache = false } = opts;

  const cluster = findCluster(projectDir, clusterId, opts.runId);
  if (cluster === undefined) {
    const runLabel = opts.runId !== undefined ? `run ${opts.runId}` : 'any run';
    process.stderr.write(`No cluster ${clusterId} found in ${runLabel}; check 'bughunter list'\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await explainCluster({ cluster, projectDir, noCache });
    process.stdout.write(`${result.markdown}\n`);
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 2;
  }
}

function findCluster(projectDir: string, clusterId: string, runId?: string): BugCluster | undefined {
  const runIds = runId !== undefined
    ? [runId]
    : listRunIds(projectDir).sort().reverse();

  for (const rid of runIds) {
    const paths = runPaths(projectDir, rid);
    if (!fileExists(paths.bugsFile)) continue;

    const raw = fs.readFileSync(paths.bugsFile, 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const cluster = JSON.parse(line) as BugCluster;
        if (cluster.id === clusterId) return cluster;
      } catch {
        // skip malformed lines
      }
    }
  }
  return undefined;
}
