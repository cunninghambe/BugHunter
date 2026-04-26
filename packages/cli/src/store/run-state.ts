// Run state persistence — reads/writes .bughunter/runs/<id>/state.json.

import type { RunState } from '../types.js';
import { runPaths, ensureRunDirs, writeJsonFile, readJsonFile, fileExists } from './filesystem.js';

export function initRunState(projectDir: string, runId: string, config: RunState['config']): RunState {
  const state: RunState = {
    runId,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'validate',
    config,
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
  const paths = runPaths(projectDir, runId);
  ensureRunDirs(paths);
  writeJsonFile(paths.stateFile, state);
  return state;
}

export function loadRunState(projectDir: string, runId: string): RunState {
  const paths = runPaths(projectDir, runId);
  if (!fileExists(paths.stateFile)) {
    throw new Error(`Run state not found: ${paths.stateFile}`);
  }
  return readJsonFile<RunState>(paths.stateFile);
}

export function saveRunState(state: RunState): void {
  const paths = runPaths(state.projectDir, state.runId);
  writeJsonFile(paths.stateFile, state);
}

export function runStateExists(projectDir: string, runId: string): boolean {
  const paths = runPaths(projectDir, runId);
  return fileExists(paths.stateFile);
}
