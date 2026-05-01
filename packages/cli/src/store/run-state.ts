// Run state persistence — reads/writes .bughunter/runs/<id>/state.json.

import type { RunState, BugKind } from '../types.js';
import { runPaths, ensureRunDirs, writeJsonFile, readJsonFile, fileExists } from './filesystem.js';

/**
 * v0.19 read-time migration: rewrite old v0.5 race kinds to their v0.19 equivalents.
 * Operates on the in-memory RunState; does NOT write to disk.
 */
function migrateRaceKinds(state: RunState): RunState {
  // Use a Record with string values so the undefined check is valid even for non-matching keys
  const OLD_TO_NEW: Record<string, BugKind | undefined> = {
    race_double_submit: 'race_condition_double_submit',
    optimistic_update_divergence: 'race_condition_optimistic_revert',
  };

  if (state.clusters === undefined) return state;

  const migratedClusters = state.clusters.map(cluster => {
    const newKind = OLD_TO_NEW[cluster.kind];
    if (newKind === undefined) return cluster;
    return { ...cluster, kind: newKind };
  });

  return { ...state, clusters: migratedClusters };
}

export function initRunState(
  projectDir: string,
  runId: string,
  config: RunState['config'],
  startedAt?: string,
): RunState {
  const state: RunState = {
    runId,
    projectDir,
    startedAt: startedAt ?? new Date().toISOString(),
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
  const raw = readJsonFile<RunState>(paths.stateFile);
  // v0.19: migrate old race kind strings on read
  return migrateRaceKinds(raw);
}

export function saveRunState(state: RunState): void {
  const paths = runPaths(state.projectDir, state.runId);
  writeJsonFile(paths.stateFile, state);
}

export function runStateExists(projectDir: string, runId: string): boolean {
  const paths = runPaths(projectDir, runId);
  return fileExists(paths.stateFile);
}
