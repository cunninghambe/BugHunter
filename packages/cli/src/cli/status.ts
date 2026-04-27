// bughunter status <runId> — detailed status of a run.

import { runPaths, readJsonFile, fileExists } from '../store/filesystem.js';
import type { RunState } from '../types.js';

export function statusCommand(projectDir: string, runId: string): void {
  const paths = runPaths(projectDir, runId);
  if (!fileExists(paths.stateFile)) {
    process.stdout.write(`Run ${runId} not found.\n`);
    process.exitCode = 1;
    return;
  }

  const state = readJsonFile<RunState>(paths.stateFile);
  process.stdout.write(`${JSON.stringify(state, null, 2)  }\n`);
}
