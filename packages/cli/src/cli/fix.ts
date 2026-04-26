// bughunter fix — reads latest run's bugs.jsonl, dispatches ClaudeMCP fix loop without re-running.

import { loadConfig, resolvedConfig } from '../config.js';
import { listRunIds, runPaths, readJsonFile } from '../store/filesystem.js';
import { loadRunState } from '../store/run-state.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { HttpClaudeMcpAdapter } from '../adapters/claude-mcp.js';
import { runAutoFix } from '../phases/auto-fix.js';
import type { BugCluster } from '../types.js';
import * as fs from 'node:fs';
import { log } from '../log.js';
import { execSync } from 'node:child_process';

export async function fixCommand(projectDir: string): Promise<void> {
  const config = resolvedConfig(loadConfig(projectDir));

  if (!config.claudeMcpUrl) {
    throw new Error('claudeMcpUrl must be configured for fix command');
  }

  // Find latest run
  const runIds = listRunIds(projectDir).sort().reverse();
  if (runIds.length === 0) {
    throw new Error('No runs found. Run bughunter run first.');
  }

  const latestRunId = runIds[0];
  const paths = runPaths(projectDir, latestRunId);

  if (!fs.existsSync(paths.bugsFile)) {
    throw new Error(`No bugs.jsonl found for run ${latestRunId}`);
  }

  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
  const clusters = lines.map(l => JSON.parse(l) as BugCluster);

  log.info(`Fix: ${clusters.length} clusters from run ${latestRunId}`);

  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
  const browser = config.browserMcpUrl ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;
  const claudeMcp = new HttpClaudeMcpAdapter(config.claudeMcpUrl);

  let baseBranch = 'main';
  try {
    baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();
  } catch {}

  const report = await runAutoFix(
    clusters,
    projectDir,
    latestRunId,
    config,
    baseBranch,
    claudeMcp,
    surface,
    browser
  );

  process.stdout.write(
    `\nFix complete: ${report.bugs_verified_fixed} verified_fixed, ${report.partially_verified} partially_verified, ` +
    `${report.bugs_persistent} persistent, ${report.bugs_skipped} skipped\n`
  );
}
