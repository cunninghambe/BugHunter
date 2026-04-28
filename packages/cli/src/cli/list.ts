// bughunter list — show last 20 runs with cluster counts + verdicts.

import { listRunIds, runPaths, readJsonFile, fileExists } from '../store/filesystem.js';
import type { RunState } from '../types.js';

export function listCommand(projectDir: string): void {
  const runIds = listRunIds(projectDir).sort().reverse().slice(0, 20);

  if (runIds.length === 0) {
    process.stdout.write('No runs found.\n');
    return;
  }

  process.stdout.write('\nRecent runs:\n');
  for (const runId of runIds) {
    const paths = runPaths(projectDir, runId);
    if (!fileExists(paths.stateFile)) continue;

    const state = readJsonFile<RunState>(paths.stateFile);
    const { clusterCount, phase, startedAt: started } = state;

    process.stdout.write(`  ${runId}  phase=${phase}  clusters=${clusterCount}  started=${started}\n`);
  }
}
