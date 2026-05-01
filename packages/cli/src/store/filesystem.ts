// Filesystem layout helpers for .bughunter/runs/<runId>/.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type RunPaths = {
  runDir: string;
  stateFile: string;
  bugsFile: string;
  infraFile: string;
  screenshotsDir: string;
  domDir: string;
  consoleDir: string;
  networkDir: string;
  actionLogsDir: string;
  summaryFile: string;
  specsDir: string;
  /** v0.8: directory for gzipped heap snapshots */
  heapDir: string;
  /** v0.29: directory for export artifacts (sarif/csv/etc.) */
  exportsDir: string;
  /** v0.34: per-run detector coverage report */
  coverageFile: string;
};

export function runPaths(projectDir: string, runId: string): RunPaths {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  return {
    runDir,
    stateFile: path.join(runDir, 'state.json'),
    bugsFile: path.join(runDir, 'bugs.jsonl'),
    infraFile: path.join(runDir, 'infrastructure.jsonl'),
    screenshotsDir: path.join(runDir, 'screenshots'),
    domDir: path.join(runDir, 'dom'),
    consoleDir: path.join(runDir, 'console'),
    networkDir: path.join(runDir, 'network'),
    actionLogsDir: path.join(runDir, 'action-logs'),
    summaryFile: path.join(runDir, 'summary.json'),
    specsDir: path.join(runDir, 'specs'),
    heapDir: path.join(runDir, 'heap'),
    exportsDir: path.join(runDir, 'exports'),
    coverageFile: path.join(runDir, 'coverage.json'),
  };
}

export function ensureRunDirs(paths: RunPaths): void {
  for (const dir of [
    paths.runDir,
    paths.screenshotsDir,
    paths.domDir,
    paths.consoleDir,
    paths.networkDir,
    paths.actionLogsDir,
    paths.specsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function appendJsonl(filePath: string, record: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(record)  }\n`);
}

export function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)  }\n`);
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function listRunIds(projectDir: string): string[] {
  const runsDir = path.join(projectDir, '.bughunter', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  // v0.32: sort ASC for deterministic iteration order across OSes.
  return fs.readdirSync(runsDir).sort().filter(d =>
    fs.statSync(path.join(runsDir, d)).isDirectory()
  );
}

export type BugHunterProjectPaths = {
  suppressionsFile: string;
  auditLogFile: string;
  triageFile: string;
  explanationsDir: string;
};

/** v0.28: project-level paths for suppressions, audit log, triage events, and explanation cache. */
export function bugHunterPaths(projectDir: string): BugHunterProjectPaths {
  const base = path.join(projectDir, '.bughunter');
  return {
    suppressionsFile: path.join(base, 'suppressions.json'),
    auditLogFile: path.join(base, 'suppressions-audit.log'),
    triageFile: path.join(base, 'triage.jsonl'),
    explanationsDir: path.join(base, 'explanations'),
  };
}

export function pruneRuns(projectDir: string, maxAgeMs: number): string[] {
  const runIds = listRunIds(projectDir);
  const cutoff = Date.now() - maxAgeMs;
  const pruned: string[] = [];
  for (const id of runIds) {
    const dir = path.join(projectDir, '.bughunter', 'runs', id);
    const stat = fs.statSync(dir);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(dir, { recursive: true });
      pruned.push(id);
    }
  }
  return pruned;
}

export { historyDbPath } from './history.js';
