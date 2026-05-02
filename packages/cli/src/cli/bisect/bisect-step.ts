// v0.35: bughunter bisect-step — hidden per-commit subcommand invoked by git bisect run.
// Exit codes: 0 = good (no bug), 1 = bad (bug present), 125 = skip.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { replayActionLog } from '../../repro/replay.js';
import { makeBrowserAdapter } from '../../adapters/browser-mcp.js';
import { makeNullBrowser } from './bisect-null-browser.js';
import { HttpSurfaceMcpAdapter } from '../../adapters/surface-mcp.js';
import { loadConfig } from '../../config.js';
import { bisectRunPaths } from '../../store/filesystem.js';
import type { ActionLog } from '../../repro/action-log.js';
import type { BisectClusterSnapshot, BisectLogEntry, BugSignal, BisectVerdict } from '../../types.js';
import { classifySignal } from './signal-classifier.js';
import { computeConsensus } from './consensus.js';
import { appendBisectLog } from './log.js';
import { spawnApp, waitForApp, killApp, runBuild, runResetCommands } from './process.js';

type BisectStepConfig = {
  buildCommand: string;
  appCommand: string;
  appReadyUrl: string;
  appReadyTimeoutMs: number;
  buildTimeoutMs: number;
  consensusRuns: number;
  consensusThreshold: number;
  killGracePeriodMs: number;
  resetCommandsBetweenCommits: string[];
};

export type BisectStepArgs = {
  bugId: string;
  bisectId: string;
  projectDir: string;
  worktreeDir: string;
};

export async function runBisectStep(args: BisectStepArgs): Promise<void> {
  const { bisectId, projectDir, worktreeDir } = args;
  const paths = bisectRunPaths(projectDir, bisectId);
  const startMs = Date.now();

  const sha = getCurrentSha(worktreeDir);
  const cfg = loadStepConfig(paths.bisectConfigFile);
  const actionLog = loadActionLog(paths.actionLogFile);
  const cluster = loadCluster(paths.clusterFile);

  // EC-5: check SurfaceMCP toolset revision
  const surfaceSkip = checkSurfaceRevision(worktreeDir, actionLog);
  if (surfaceSkip !== null) {
    writeLogAndExit(paths.logFile, sha, { kind: 'skip', reason: 'surface_revision_changed' }, startMs, undefined);
  }

  const commitDir = path.join(paths.commitsDir, sha);
  fs.mkdirSync(commitDir, { recursive: true });

  // Run reset commands between commits if configured
  if (cfg.resetCommandsBetweenCommits.length > 0) {
    runResetCommands(cfg.resetCommandsBetweenCommits, worktreeDir, path.join(commitDir, 'reset.log'));
  }

  // Build step
  if (cfg.buildCommand !== '') {
    const buildExit = runBuild(cfg.buildCommand, worktreeDir, path.join(commitDir, 'build.log'), cfg.buildTimeoutMs);
    if (buildExit !== 0) {
      writeLogAndExit(paths.logFile, sha, { kind: 'skip', reason: 'build_failed' }, startMs, undefined);
    }
  }

  // Load BugHunter config for browser/surface adapters
  const bhConfig = loadConfigSafe(projectDir);

  const surface = new HttpSurfaceMcpAdapter(bhConfig.surfaceMcpUrl);
  const browser = makeBrowserAdapter(bhConfig);

  // Spawn app
  const appLog = path.join(commitDir, 'app.log');
  const spawned = spawnApp(cfg.appCommand, worktreeDir, appLog);

  const appReady = await waitForApp(cfg.appReadyUrl, cfg.appReadyTimeoutMs, spawned.process);
  if (!appReady) {
    await killApp(spawned, cfg.killGracePeriodMs);
    writeLogAndExit(paths.logFile, sha, { kind: 'skip', reason: 'app_start_timeout' }, startMs, undefined);
  }

  // Consensus replay loop
  const signals: BugSignal[] = [];
  const appBaseUrl = cfg.appReadyUrl.replace(/\/$/, '');

  for (let i = 0; i < cfg.consensusRuns; i++) {
    const result = await replayActionLog(
      actionLog,
      browser ?? makeNullBrowser(),
      surface,
      `bisect-${bisectId}-run${i}`,
      appBaseUrl,
    );

    const signal = classifySignal(result, cluster);
    if ('skip' in signal) {
      await killApp(spawned, cfg.killGracePeriodMs);
      writeLogAndExit(paths.logFile, sha, { kind: 'skip', reason: signal.reason }, startMs, undefined);
    }
    signals.push(signal);
  }

  await killApp(spawned, cfg.killGracePeriodMs);

  // Compute consensus verdict
  const worstPresent = signals.find(s => s.present);
  const consensusResult = computeConsensus(signals, cfg.consensusThreshold, worstPresent);

  writeLogAndExit(paths.logFile, sha, consensusResult.verdict, startMs, consensusResult.votes);
}

function writeLogAndExit(
  logPath: string,
  sha: string,
  verdict: BisectVerdict,
  startMs: number,
  votes: { present: number; absent: number; inconclusive: number } | undefined,
): never {
  const entry: BisectLogEntry = {
    ts: new Date().toISOString(),
    sha,
    verdict: verdict.kind,
    durationMs: Date.now() - startMs,
    signal: verdict.kind === 'bad' ? verdict.signal : undefined,
    skipReason: verdict.kind === 'skip' ? verdict.reason : undefined,
    consensusVotes: votes,
  };
  try { appendBisectLog(logPath, entry); } catch { /* best effort */ }

  if (verdict.kind === 'good') process.exit(0);
  if (verdict.kind === 'bad') process.exit(1);
  process.exit(125);
}

function getCurrentSha(worktreeDir: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function loadStepConfig(configFile: string): BisectStepConfig {
  if (!fs.existsSync(configFile)) {
    process.stderr.write(`bisect-step: missing bisect-config.json at ${configFile}\n`);
    process.exit(125);
  }
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as BisectStepConfig;
}

function loadActionLog(actionLogFile: string): ActionLog {
  if (!fs.existsSync(actionLogFile)) {
    process.stderr.write(`bisect-step: missing action-log.json at ${actionLogFile}\n`);
    process.exit(125);
  }
  return JSON.parse(fs.readFileSync(actionLogFile, 'utf-8')) as ActionLog;
}

function loadCluster(clusterFile: string): BisectClusterSnapshot {
  if (!fs.existsSync(clusterFile)) {
    process.stderr.write(`bisect-step: missing cluster.json at ${clusterFile}\n`);
    process.exit(125);
  }
  return JSON.parse(fs.readFileSync(clusterFile, 'utf-8')) as BisectClusterSnapshot;
}

function loadConfigSafe(projectDir: string): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(projectDir);
  } catch {
    // Exit 125 (skip) if config can't be loaded — bisect continues with other commits
    process.stderr.write(`bisect-step: cannot load .bughunter/config.json from ${projectDir}\n`);
    process.exit(125);
  }
}

/** Check if the action log references toolIds that don't exist in this commit's surfacemcp.config.json. */
function checkSurfaceRevision(worktreeDir: string, actionLog: ActionLog): null | 'surface_revision_changed' {
  const surfaceConfigPath = path.join(worktreeDir, 'surfacemcp.config.json');
  if (!fs.existsSync(surfaceConfigPath)) return null;

  let surfaceConfig: { tools?: Array<{ toolId?: string }> };
  try {
    surfaceConfig = JSON.parse(fs.readFileSync(surfaceConfigPath, 'utf-8')) as typeof surfaceConfig;
  } catch {
    return null;
  }

  const knownToolIds = new Set(
    (surfaceConfig.tools ?? []).map(t => t.toolId).filter((id): id is string => id !== undefined),
  );
  if (knownToolIds.size === 0) return null;

  const referencedToolIds = actionLog.actions
    .filter(a => a.kind === 'api_call' && a.toolId !== undefined && a.toolId !== '')
    .map(a => a.toolId as string);

  for (const toolId of referencedToolIds) {
    if (!knownToolIds.has(toolId)) return 'surface_revision_changed';
  }
  return null;
}

