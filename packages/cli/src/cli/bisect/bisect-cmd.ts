// v0.35: bughunter bisect <bug-id> — find the introducing commit.
// Orchestrates pre-flight, worktree creation, git bisect run, and final report.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createId } from '@paralleldrive/cuid2';
import { loadConfig } from '../../config.js';
import { bisectRunPaths, bisectWorktreePath } from '../../store/filesystem.js';
import { log } from '../../log.js';
import type { BisectRunSummary } from '../../types.js';
import { resolveBugId, copyActionLogToBisectRun } from './resolve-bug-id.js';
import { parseCommitRange, resolveHead, getCommitInfo } from './range.js';
import {
  createWorktree,
  removeWorktree,
  bisectStart,
  bisectBad,
  bisectGood,
  bisectReset,
  getBisectBadRef,
} from './worktree.js';
import { replayActionLog } from '../../repro/replay.js';
import { makeBrowserAdapter } from '../../adapters/browser-mcp.js';
import { HttpSurfaceMcpAdapter } from '../../adapters/surface-mcp.js';
import { classifySignal } from './signal-classifier.js';
import { renderBisectReport, readBisectLog } from './log.js';
import { saveBisectState, loadBisectState, findLatestBisectStateFile } from './state.js';
import type { BisectState } from './state.js';
import { spawnApp, waitForApp, killApp } from './process.js';

export type BisectOptions = {
  commitRange?: string;
  consensus: number;
  threshold: number;
  strict: boolean;
  buildCommand?: string;
  appCommand?: string;
  resume: boolean;
  noCleanup: boolean;
  format: 'text' | 'json';
  jsonLog: boolean;
  quiet: boolean;
  noBuild: boolean;
};

const DEFAULT_RANGE = 'HEAD~30..HEAD';
const DEFAULT_APP_READY_TIMEOUT_MS = 60_000;
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

export async function bisectCommand(projectDir: string, bugId: string, opts: BisectOptions): Promise<void> {
  if (opts.resume && bugId === '') {
    await resumeBisect(projectDir, opts);
    return;
  }

  if (bugId === '') {
    throw new Error('Usage: bughunter bisect <bug-id> [options]');
  }

  const config = loadConfig(projectDir);
  const bisectCfg = config.bisect ?? {};

  const consensusRuns = opts.strict ? 1 : (bisectCfg.consensusRuns ?? opts.consensus);
  const consensusThreshold = opts.strict ? 1 : (bisectCfg.consensusThreshold ?? opts.threshold);
  const defaultRange = bisectCfg.defaultRange ?? DEFAULT_RANGE;
  const killGracePeriodMs = bisectCfg.killGracePeriodMs ?? DEFAULT_KILL_GRACE_MS;

  // Resolve bug ID to action log
  if (!opts.quiet) process.stdout.write(`Resolving bug id "${bugId}"...\n`);
  const resolved = resolveBugId(projectDir, bugId);
  if (!opts.quiet) {
    process.stdout.write(`Bisecting bug ${resolved.cluster.bugIdentity ?? resolved.cluster.id} ("${resolved.cluster.kind} — ${resolved.cluster.rootCause.slice(0, 60)}")\n`);
    process.stdout.write(`Action log: occurrenceId=${resolved.occurrenceId} from runId=${resolved.runId}\n`);
  }

  // Parse commit range
  const range = parseCommitRange(opts.commitRange, projectDir, defaultRange);
  if (!opts.quiet) {
    process.stdout.write(`Commit range: ${range.good.slice(0, 7)}..${range.bad.slice(0, 7)} (${range.commitCount} commits)\n`);
  }

  // Pre-flight: check bug reproduces at bad end
  const buildCmd = opts.buildCommand ?? bisectCfg.buildCommand ?? '';
  const appCmd = opts.appCommand ?? bisectCfg.appCommand ?? '';
  const appReadyUrl = bisectCfg.appReadyUrl ?? (config.appBaseUrl ?? 'http://localhost:3000/');
  const appReadyTimeoutMs = bisectCfg.appReadyTimeoutMs ?? DEFAULT_APP_READY_TIMEOUT_MS;

  if (buildCmd === '' && appCmd === '') {
    throw new Error(
      'bisect.buildCommand and bisect.appCommand are both missing from .bughunter/config.json. ' +
      'Set at least bisect.appCommand to start the app. ' +
      'Set bisect.buildCommand if the project needs a build step.',
    );
  }

  const bisectId = createId();
  const runPaths = bisectRunPaths(projectDir, bisectId);
  const worktreeDir = bisectWorktreePath(projectDir, bisectId);

  fs.mkdirSync(runPaths.bisectRunDir, { recursive: true });
  fs.mkdirSync(runPaths.commitsDir, { recursive: true });

  // Copy action log and cluster snapshot to bisect-runs dir
  copyActionLogToBisectRun(resolved.actionLog, runPaths.actionLogFile);
  fs.writeFileSync(runPaths.clusterFile, `${JSON.stringify(resolved.cluster, null, 2)}\n`);

  // Write bisect config snapshot
  const stepConfig = {
    buildCommand: buildCmd,
    appCommand: appCmd,
    appReadyUrl,
    appReadyTimeoutMs,
    buildTimeoutMs: bisectCfg.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    consensusRuns,
    consensusThreshold,
    killGracePeriodMs,
    resetCommandsBetweenCommits: bisectCfg.resetCommandsBetweenCommits ?? [],
  };
  fs.writeFileSync(runPaths.bisectConfigFile, `${JSON.stringify(stepConfig, null, 2)}\n`);

  const state: BisectState = {
    bisectId,
    bugId,
    occurrenceId: resolved.occurrenceId,
    runId: resolved.runId,
    worktreeDir,
    projectDir,
    goodSha: range.good,
    badSha: range.bad,
    commitRange: `${range.good}..${range.bad}`,
    consensusRuns,
    consensusThreshold,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  saveBisectState(runPaths.stateFile, state);

  // Run the bisect with cleanup on SIGINT
  let cleanupDone = false;
  const cleanup = (worktreeToRemove: string): void => {
    if (cleanupDone) return;
    cleanupDone = true;
    bisectReset(worktreeToRemove);
    if (!opts.noCleanup) removeWorktree(worktreeToRemove, projectDir);
  };

  process.on('SIGINT', () => {
    state.status = 'aborted';
    saveBisectState(runPaths.stateFile, state);
    cleanup(worktreeDir);
    process.exit(130);
  });

  const startMs = Date.now();

  try {
    // Create worktree at bad commit (start point)
    createWorktree(worktreeDir, range.bad, projectDir);

    // Pre-flight: verify bug reproduces at bad end
    if (!opts.quiet) process.stdout.write('Pre-flight: checking bad end...\n');
    const badSignal = await runPreflightCheck(resolved, config, appCmd, appReadyUrl, appReadyTimeoutMs, killGracePeriodMs, worktreeDir, buildCmd, bisectCfg.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS, opts);
    if (!badSignal.present) {
      cleanup(worktreeDir);
      throw new Error(
        `Bug not present at bad end (${range.bad.slice(0, 7)}). ` +
        `The working tree may have already fixed it. Try: bughunter replay ${resolved.occurrenceId}`,
      );
    }
    if (!opts.quiet) process.stdout.write(`Pre-flight: HEAD reproduces (bad). ✓\n`);

    // Pre-flight: verify bug absent at good end
    if (!opts.quiet) process.stdout.write('Pre-flight: checking good end...\n');

    // Checkout good commit in worktree for pre-flight
    execSync(`git -C "${worktreeDir}" checkout "${range.good}" --force`, { stdio: 'ignore' });
    const goodSignal = await runPreflightCheck(resolved, config, appCmd, appReadyUrl, appReadyTimeoutMs, killGracePeriodMs, worktreeDir, buildCmd, bisectCfg.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS, opts);
    if (goodSignal.present) {
      cleanup(worktreeDir);
      throw new Error(
        `Bug present at good end (${range.good.slice(0, 7)}) too. ` +
        `Extend --commit-range further back, e.g. --commit-range HEAD~100..HEAD.`,
      );
    }
    if (!opts.quiet) process.stdout.write(`Pre-flight: ${range.good.slice(0, 7)} does not reproduce (good). ✓\n\n`);

    // Checkout bad commit again before starting bisect
    execSync(`git -C "${worktreeDir}" checkout "${range.bad}" --force`, { stdio: 'ignore' });

    // Run git bisect
    bisectStart(worktreeDir);
    bisectBad(worktreeDir, range.bad);
    bisectGood(worktreeDir, range.good);

    // Determine the CLI path to invoke bughunter bisect-step
    const bughunterBin = process.argv[1] ?? 'bughunter';
    const bisectStepCmd = [
      process.execPath,
      bughunterBin,
      'bisect-step',
      '--bug-id', bugId,
      '--bisect-id', bisectId,
      '--project-dir', projectDir,
      '--worktree-dir', worktreeDir,
    ].join(' ');

    try {
      execSync(`git -C "${worktreeDir}" bisect run ${bisectStepCmd}`, {
        stdio: opts.quiet ? 'ignore' : 'inherit',
        encoding: 'utf-8',
      });
    } catch { /* git bisect run exits non-zero when the bad commit is found; that's expected */ }

    // Get introducing commit
    const introducingCommitSha = getBisectBadRef(worktreeDir);
    const logEntries = readBisectLog(runPaths.logFile);
    const visited = logEntries.length;
    const skipped = logEntries.filter(e => e.verdict === 'skip').length;

    let summary: BisectRunSummary;
    if (introducingCommitSha !== null) {
      const info = getCommitInfo(introducingCommitSha, worktreeDir);
      summary = {
        bisectId,
        bugId,
        occurrenceId: resolved.occurrenceId,
        runId: resolved.runId,
        commitRange: { good: range.good, bad: range.bad },
        introducingCommit: { sha: introducingCommitSha, ...info },
        status: 'found',
        commitsVisited: visited,
        commitsSkipped: skipped,
        durationMs: Date.now() - startMs,
        bisectLogPath: runPaths.logFile,
        actionLogPath: runPaths.actionLogFile,
      };
    } else {
      summary = {
        bisectId,
        bugId,
        occurrenceId: resolved.occurrenceId,
        runId: resolved.runId,
        commitRange: { good: range.good, bad: range.bad },
        status: skipped === visited ? 'all_skipped' : 'not_found',
        commitsVisited: visited,
        commitsSkipped: skipped,
        durationMs: Date.now() - startMs,
        bisectLogPath: runPaths.logFile,
        actionLogPath: runPaths.actionLogFile,
      };
    }

    fs.writeFileSync(runPaths.resultFile, `${JSON.stringify(summary, null, 2)}\n`);
    state.status = 'done';
    saveBisectState(runPaths.stateFile, state);

    bisectReset(worktreeDir);
    cleanup(worktreeDir);

    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${renderBisectReport(summary, logEntries)}\n`);
    }

    if (summary.status !== 'found') {
      process.exitCode = 1;
    }
  } catch (err) {
    state.status = 'aborted';
    saveBisectState(runPaths.stateFile, state);
    cleanup(worktreeDir);
    throw err;
  }
}

async function runPreflightCheck(
  resolved: ReturnType<typeof resolveBugId>,
  config: ReturnType<typeof loadConfig>,
  appCmd: string,
  appReadyUrl: string,
  appReadyTimeoutMs: number,
  killGracePeriodMs: number,
  worktreeDir: string,
  buildCmd: string,
  buildTimeoutMs: number,
  opts: BisectOptions,
): Promise<{ present: boolean }> {
  // Try to build first if buildCommand specified
  if (buildCmd !== '' && !opts.noBuild) {
    const tmpLog = path.join(worktreeDir, '.bughunter-preflight-build.log');
    const exitCode = (await import('./process.js')).runBuild(buildCmd, worktreeDir, tmpLog, buildTimeoutMs);
    if (exitCode !== 0) {
      // Can't do pre-flight if build fails — assume present at bad, absent at good
      return { present: true }; // conservative: assume it would reproduce if we could build
    }
  }

  if (appCmd === '') return { present: true };

  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
  const browser = makeBrowserAdapter(config);

  const tmpLog = path.join(worktreeDir, '.bughunter-preflight-app.log');
  const spawned = spawnApp(appCmd, worktreeDir, tmpLog);
  const ready = await waitForApp(appReadyUrl, appReadyTimeoutMs, spawned.process);

  if (!ready) {
    await killApp(spawned, killGracePeriodMs);
    return { present: true }; // can't verify; assume worst case
  }

  const appBaseUrl = appReadyUrl.replace(/\/$/, '');
  const result = await replayActionLog(
    resolved.actionLog,
    browser ?? makeNullBrowser(),
    surface,
    `bisect-preflight-${Date.now()}`,
    appBaseUrl,
  );

  await killApp(spawned, killGracePeriodMs);

  const signal = classifySignal(result, resolved.cluster);
  if ('skip' in signal) return { present: false };
  return { present: signal.present };
}

async function resumeBisect(projectDir: string, opts: BisectOptions): Promise<void> {
  const stateFile = findLatestBisectStateFile(projectDir);
  if (stateFile === null) {
    throw new Error('No in-progress bisect found. Start a new bisect with: bughunter bisect <bug-id>');
  }
  const state = loadBisectState(stateFile);
  log.info(`Resuming bisect ${state.bisectId} for bug ${state.bugId}`);

  // Re-run from current bisect state
  await bisectCommand(projectDir, state.bugId, {
    ...opts,
    resume: false,
    commitRange: state.commitRange,
    consensus: state.consensusRuns,
    threshold: state.consensusThreshold,
  });
}

function makeNullBrowser(): Parameters<typeof replayActionLog>[1] {
  return { navigate: async () => ({ url: '' }), click: async () => ({ clicked: false }), type: async () => ({ typed: false }), scroll: async () => ({ scrolled: false }), snapshot: async () => ({ snapshot: '' }), screenshot: async () => ({ path: '' }), evaluate: async () => ({ value: null }), listTabs: async () => ({ tabs: [] }), closeTab: async () => ({ closed: false }), openTab: async () => ({ tabId: '', finalUrl: '' }), closeTabExplicit: async () => undefined, withTab: async (_u: string, _h: Record<string, string> | undefined, fn: (s: never) => Promise<never>) => fn({} as never), cookies: async () => ({ tabId: '', cookies: [] }), clickByHint: async () => ({ clicked: false as const, reason: 'no_hint_fields' as const }) }; // eslint-disable-line @typescript-eslint/require-await -- interface contract: BrowserMcpAdapter methods must return Promise
}

// Re-export for use in main.ts
export { resolveHead };
