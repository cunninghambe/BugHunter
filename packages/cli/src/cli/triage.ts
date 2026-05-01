import * as fs from 'node:fs';
import { listRunIds, runPaths, fileExists } from '../store/filesystem.js';
import { getGitUserEmail } from '../suppress/git.js';
import type { BugCluster } from '../types.js';

export type TriageCliOpts = {
  projectDir: string;
  runId?: string;
};

export async function triageCliCommand(opts: TriageCliOpts): Promise<void> {
  const { projectDir } = opts;

  const runIds = listRunIds(projectDir).sort().reverse();

  if (opts.runId === undefined && runIds.length === 0) {
    process.stdout.write('No runs found. Run bughunter run first.\n');
    return;
  }

  // At this point either opts.runId is defined or runIds is non-empty.
  const runId = (opts.runId ?? runIds[0]) as string;

  const paths = runPaths(projectDir, runId);
  if (!fileExists(paths.bugsFile)) {
    process.stdout.write(`No clusters in run ${runId}; nothing to triage.\n`);
    return;
  }

  const clusters = parseClusters(paths.bugsFile);
  const actor = getGitUserEmail(projectDir);

  // Lazy-import triage to avoid React startup cost on `bughunter run`
  const { triageCommand } = await import('../triage/index.js');
  await triageCommand({ projectDir, clusters, runId, actor });
}

function parseClusters(bugsFile: string): BugCluster[] {
  const raw = fs.readFileSync(bugsFile, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as BugCluster);
}
