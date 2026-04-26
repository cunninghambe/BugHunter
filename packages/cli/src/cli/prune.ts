// bughunter prune — delete .bughunter/runs/<id>/ older than 30 days.

import { pruneRuns } from '../store/filesystem.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneCommand(projectDir: string): void {
  const pruned = pruneRuns(projectDir, THIRTY_DAYS_MS);
  if (pruned.length === 0) {
    process.stdout.write('No runs to prune.\n');
  } else {
    process.stdout.write(`Pruned ${pruned.length} run(s): ${pruned.join(', ')}\n`);
  }
}
