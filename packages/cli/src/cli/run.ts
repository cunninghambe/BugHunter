// bughunter run — main run pipeline orchestrator.

import { createId } from '@paralleldrive/cuid2';
import { loadConfig, resolvedConfig } from '../config.js';
import { initRunState, saveRunState, loadRunState } from '../store/run-state.js';
import { runPaths } from '../store/filesystem.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { HttpClaudeMcpAdapter } from '../adapters/claude-mcp.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import { runExecute } from '../phases/execute.js';
import { runClassify } from '../phases/classify.js';
import { runCluster } from '../phases/cluster.js';
import { runEmit } from '../phases/emit.js';
import { runAutoFix } from '../phases/auto-fix.js';
import { appendJsonl } from '../store/filesystem.js';
import { log } from '../log.js';

export type RunOptions = {
  projectDir: string;
  autoFix?: boolean;
  route?: string;
  role?: string;
  maxBugs?: number;
  maxRuntime?: number;
  budget?: number;
  concurrency?: number;
  apiConcurrency?: number;
  reset?: boolean;
  resume?: string;
  forceResume?: boolean;
  a11y?: boolean;
  includeExternal?: boolean;
  strict?: boolean;
};

export async function runCommand(opts: RunOptions): Promise<void> {
  const config = loadConfig(opts.projectDir);
  const resolved = resolvedConfig({
    ...config,
    ...(opts.maxBugs !== undefined ? { maxBugs: opts.maxBugs } : {}),
    ...(opts.maxRuntime !== undefined ? { maxRuntimeMs: opts.maxRuntime } : {}),
    ...(opts.budget !== undefined ? { budgetMs: opts.budget } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.apiConcurrency !== undefined ? { apiConcurrency: opts.apiConcurrency } : {}),
    ...(opts.includeExternal !== undefined ? { externalIntegrationsAllowed: opts.includeExternal } : {}),
    ...(opts.a11y !== undefined ? { enableA11y: opts.a11y } : {}),
  });

  const surface = new HttpSurfaceMcpAdapter(resolved.surfaceMcpUrl);
  const browser = resolved.browserMcpUrl ? new CamofoxBrowserMcpAdapter(resolved.browserMcpUrl) : undefined;
  const claudeMcp = resolved.claudeMcpUrl ? new HttpClaudeMcpAdapter(resolved.claudeMcpUrl) : undefined;

  // Resume or new run
  let runId: string;
  let resumeState = undefined;
  if (opts.resume) {
    runId = opts.resume;
    resumeState = loadRunState(opts.projectDir, runId);
    log.info(`Resuming run ${runId} from phase ${resumeState.phase}`);
  } else {
    runId = createId();
    log.info(`Starting new run ${runId}`);
  }

  const startMs = Date.now();
  const roles = opts.role ? [opts.role] : undefined;

  // Phase 0: validate
  const { revision, roles: discoveredRoles } = await runValidate({
    surfaceMcp: surface,
    browserMcp: browser,
    config: resolved,
    resumeState,
    forceResume: opts.forceResume,
  });

  const effectiveRoles = roles ?? discoveredRoles;

  // Run resetCommand if --reset or per-run policy
  if (opts.reset && resolved.resetCommand) {
    const { execSync } = await import('node:child_process');
    log.info(`Running resetCommand: ${resolved.resetCommand}`);
    execSync(resolved.resetCommand, { cwd: opts.projectDir, stdio: 'inherit' });
  }

  let runState = resumeState ?? initRunState(opts.projectDir, runId, resolved);
  runState.surfaceRevision = revision;
  runState.phase = 'discover';
  saveRunState(runState);

  // Phase 1: discover
  const discovery = await runDiscover(
    opts.projectDir,
    resolved,
    effectiveRoles,
    runId,
    surface,
    browser,
    opts.route
  );
  runState.discovery = discovery;
  runState.phase = 'plan';
  saveRunState(runState);

  // Phase 2: plan
  const { testCases, projectedRuntimeMs } = await runPlan(
    runId,
    discovery,
    resolved,
    effectiveRoles,
    surface
  );
  runState.testCases = testCases;
  runState.phase = 'execute';
  saveRunState(runState);

  // Phase 3: execute
  const { results, abortReason } = await runExecute({
    testCases,
    runState,
    browser,
    surface,
    maxBugs: resolved.maxBugs!,
    maxRuntimeMs: resolved.maxRuntimeMs!,
    budgetMs: resolved.budgetMs,
    concurrency: resolved.concurrency!,
    apiConcurrency: resolved.apiConcurrency!,
    onClusterFound: () => runState.clusterCount,
    extraHeaders: resolved.extraHeaders,
    enableA11y: resolved.enableA11y,
  });

  if (abortReason) {
    log.warn(`Run stopped: ${abortReason}`);
    runState.partialEmit = true;
  }

  runState.testResults = results;
  runState.phase = 'classify';
  saveRunState(runState);

  // Phase 4: classify
  const { bugs, infraFailures } = runClassify(results);
  runState.phase = 'cluster';
  saveRunState(runState);

  // Phase 5: cluster
  const paths = runPaths(opts.projectDir, runId);
  const { clusters } = runCluster({
    detections: bugs,
    testCases,
    runId,
    projectDir: opts.projectDir,
    actionLogsDir: paths.actionLogsDir,
    screenshotsDir: paths.screenshotsDir,
    domDir: paths.domDir,
    consoleDir: paths.consoleDir,
    networkDir: paths.networkDir,
    maxClusters: resolved.maxBugs!,
  });

  runState.clusters = clusters;
  runState.clusterCount = clusters.length;
  runState.phase = 'emit';
  saveRunState(runState);

  // Phase 6: emit
  const actualRuntimeMs = Date.now() - startMs;
  runEmit(clusters, infraFailures, runState, projectedRuntimeMs, actualRuntimeMs);
  runState.emitted = true;
  runState.phase = opts.autoFix ? 'fix' : 'done';
  saveRunState(runState);

  // Phase 7: auto-fix (optional)
  if (opts.autoFix) {
    if (!claudeMcp) {
      log.error('--auto-fix requires claudeMcpUrl in config');
    } else {
      const { execSync } = await import('node:child_process');
      let baseBranch = 'main';
      try {
        baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: opts.projectDir,
          encoding: 'utf-8',
        }).trim();
      } catch {}

      const fixReport = await runAutoFix(
        clusters,
        opts.projectDir,
        runId,
        resolved,
        baseBranch,
        claudeMcp,
        surface,
        browser
      );

      log.info('Auto-fix complete', fixReport);
      process.stdout.write(
        `\nAuto-fix: ${fixReport.bugs_verified_fixed} fixed, ${fixReport.bugs_persistent} persistent, ${fixReport.bugs_skipped} skipped\n`
      );
    }
    runState.phase = 'done';
    saveRunState(runState);
  }
}
