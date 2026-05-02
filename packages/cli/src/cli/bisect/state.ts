// v0.35: persist + restore bisect state for --resume.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type BisectState = {
  bisectId: string;
  bugId: string;
  occurrenceId: string;
  runId: string;
  worktreeDir: string;
  projectDir: string;
  goodSha: string;
  badSha: string;
  commitRange: string;
  consensusRuns: number;
  consensusThreshold: number;
  startedAt: string;
  status: 'running' | 'done' | 'aborted';
};

export function saveBisectState(stateFile: string, state: BisectState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadBisectState(stateFile: string): BisectState {
  if (!fs.existsSync(stateFile)) {
    throw new Error(`No bisect state file found at ${stateFile}. Cannot resume.`);
  }
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as BisectState;
}

/**
 * Find the most recent in-progress bisect for the project.
 * Returns the state file path or null if none found.
 */
export function findLatestBisectStateFile(projectDir: string): string | null {
  const bisectRunsDir = path.join(projectDir, '.bughunter', 'bisect-runs');
  if (!fs.existsSync(bisectRunsDir)) return null;

  const dirs = fs.readdirSync(bisectRunsDir)
    .map(d => path.join(bisectRunsDir, d))
    .filter(d => fs.statSync(d).isDirectory())
    .sort()
    .reverse(); // newest first

  for (const dir of dirs) {
    const stateFile = path.join(dir, 'state.json');
    if (!fs.existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as BisectState;
      if (state.status === 'running') return stateFile;
    } catch { /* skip corrupt */ }
  }
  return null;
}
