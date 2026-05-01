// Shared filesystem-read helpers for the MCP read-side tools.
// Single source of truth for project validation, run resolution, and bugs.jsonl streaming.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { BugCluster, RunState, RunSummary } from 'bughunter/src/types.js';
import { runPaths, listRunIds } from 'bughunter/src/store/filesystem.js';

export { runPaths, listRunIds };

// ---------------------------------------------------------------------------
// Project / run validation
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  readonly code = 'not_found';
}

export class InvalidArgumentError extends Error {
  readonly code = 'invalid_argument';
}

/**
 * Validate that `rawProject` is a safe, readable BugHunter project directory.
 * Rejects paths containing `..` and symlinks pointing outside their resolved real path.
 * Returns the canonicalized absolute path.
 */
export function resolveProjectDir(rawProject: string): string {
  if (rawProject.includes('..')) {
    throw new InvalidArgumentError(`not a bughunter project: path must not contain '..'`);
  }

  let real: string;
  try {
    real = fs.realpathSync(rawProject);
  } catch {
    throw new NotFoundError(`not a bughunter project: directory not found: ${rawProject}`);
  }

  if (!fs.statSync(real).isDirectory()) {
    throw new InvalidArgumentError(`not a bughunter project: not a directory: ${rawProject}`);
  }

  if (!fs.existsSync(path.join(real, '.bughunter'))) {
    throw new NotFoundError(`not a bughunter project: no .bughunter directory found in ${real}`);
  }

  return real;
}

/**
 * Resolve a runId for a project. If runId is omitted, returns the latest run.
 * Returns the resolved { projectDir, runId }.
 */
export function resolveRun(projectDir: string, runId?: string): { projectDir: string; runId: string } {
  const ids = listRunIds(projectDir).sort();
  if (ids.length === 0) {
    throw new NotFoundError(`no runs found in project ${projectDir}`);
  }
  if (runId === undefined) {
    return { projectDir, runId: ids[ids.length - 1] };
  }
  if (!ids.includes(runId)) {
    const recent = ids.slice(-5).reverse().join(', ');
    throw new NotFoundError(`run ${runId} not found in project ${projectDir}. Recent runs: ${recent}`);
  }
  return { projectDir, runId };
}

// ---------------------------------------------------------------------------
// State / summary readers
// ---------------------------------------------------------------------------

export function readRunState(projectDir: string, runId: string): RunState {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.runDir)) {
    throw new NotFoundError(`run ${runId} not found in project ${projectDir}`);
  }
  if (!fs.existsSync(paths.stateFile)) {
    throw new NotFoundError(`state.json missing for run ${runId} (run may have been aborted early)`);
  }
  return JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as RunState;
}

export function readRunSummary(projectDir: string, runId: string): RunSummary {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.runDir)) {
    throw new NotFoundError(`run ${runId} not found in project ${projectDir}`);
  }
  if (!fs.existsSync(paths.summaryFile)) {
    // Try to read phase from state.json for a better error message
    let phase = 'unknown';
    try {
      const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as { phase?: string };
      phase = state.phase ?? 'unknown';
    } catch { /* ignore */ }
    throw new NotFoundError(`summary.json not found for run ${runId}; run still in progress (phase=${phase})`);
  }
  try {
    return JSON.parse(fs.readFileSync(paths.summaryFile, 'utf-8')) as RunSummary;
  } catch (e) {
    throw new Error(`failed to parse summary.json for run ${runId}: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// bugs.jsonl streaming
// ---------------------------------------------------------------------------

type FilterOptions = {
  kind?: string | string[];
  role?: string;
  routePattern?: string;
  verdict?: string;
  severity?: string;
  minClusterSize?: number;
};

export type ClusterPage = {
  clusters: BugCluster[];
  nextOffset: number;
  hasMore: boolean;
  total: number;
};

function matchesRoutePattern(page: string, pattern: string): boolean {
  // Node 22+ has path.matchesGlob — use it; older Node falls back to simple prefix match
  const pathModule = path as unknown as { matchesGlob?: (path: string, glob: string) => boolean };
  if (typeof pathModule.matchesGlob === 'function') {
    return pathModule.matchesGlob(page, pattern);
  }
  // Fallback: treat '*' as wildcard segment
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(page);
}

function clusterMatchesFilters(cluster: BugCluster, filters: FilterOptions): boolean {
  if (filters.kind !== undefined) {
    const kinds = Array.isArray(filters.kind) ? filters.kind : [filters.kind];
    if (!kinds.includes(cluster.kind)) return false;
  }
  if (filters.role !== undefined) {
    const hasRole = cluster.occurrences.some(o => o.role === filters.role);
    if (!hasRole) return false;
  }
  if (filters.routePattern !== undefined) {
    const hasPage = cluster.occurrences.some(o => matchesRoutePattern(o.page, filters.routePattern as string));
    if (!hasPage) return false;
  }
  if (filters.verdict !== undefined) {
    if (cluster.verdict !== filters.verdict) return false;
  }
  if (filters.minClusterSize !== undefined) {
    if (cluster.clusterSize < filters.minClusterSize) return false;
  }
  return true;
}

/**
 * Read bugs.jsonl line-by-line (streaming), apply filters, and return one page.
 * Skips malformed JSON lines silently (spec EC-3).
 */
export async function readClustersPage(
  bugsFile: string,
  filters: FilterOptions,
  cursorOffset: number,
  limit: number,
): Promise<ClusterPage> {
  if (!fs.existsSync(bugsFile)) {
    return { clusters: [], nextOffset: 0, hasMore: false, total: 0 };
  }

  const clusters: BugCluster[] = [];
  let filteredIndex = 0;
  let total = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(bugsFile),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim() === '') continue;
    let cluster: BugCluster;
    try {
      cluster = JSON.parse(line) as BugCluster;
    } catch {
      continue; // skip malformed lines
    }

    if (!clusterMatchesFilters(cluster, filters)) continue;

    total++;
    if (filteredIndex < cursorOffset) {
      filteredIndex++;
      continue;
    }
    if (clusters.length < limit) {
      clusters.push(cluster);
    }
    filteredIndex++;
  }

  const nextOffset = cursorOffset + clusters.length;
  const hasMore = nextOffset < total;

  return { clusters, nextOffset, hasMore, total };
}

/**
 * Read all clusters from bugs.jsonl into memory (used by cluster-detail and occurrence lookups).
 * Skips malformed JSON lines silently.
 */
export async function readAllClusters(bugsFile: string): Promise<BugCluster[]> {
  if (!fs.existsSync(bugsFile)) return [];
  const result: BugCluster[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(bugsFile),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    try {
      result.push(JSON.parse(line) as BugCluster);
    } catch {
      continue;
    }
  }
  return result;
}
