// bughunter run — main run pipeline orchestrator.

import { createId } from '@paralleldrive/cuid2';
import { loadConfig, resolvedConfig } from '../config.js';
import { initRunState, saveRunState, loadRunState } from '../store/run-state.js';
import { runPaths } from '../store/filesystem.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import { runExecute } from '../phases/execute.js';
import { runClassify } from '../phases/classify.js';
import { runCluster } from '../phases/cluster.js';
import type { PreState, PostState } from '../types.js';
import { runEmit } from '../phases/emit.js';
import { log } from '../log.js';

export type RunOptions = {
  projectDir: string;
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

  // Clear any stale tabs from previous processes to prevent tab leakage in the camofox session.
  if (browser) {
    await closeAllExistingTabs(browser);
  }

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
  const { results, abortReason, skipReasons } = await runExecute({
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
    appBaseUrl: resolved.appBaseUrl,
  });

  if (abortReason) {
    log.warn(`Run stopped: ${abortReason}`);
    runState.partialEmit = true;
  }
  runState.skipReasons = skipReasons;

  runState.testResults = results;
  runState.phase = 'classify';
  saveRunState(runState);

  // Phase 4: classify
  const { bugs, infraFailures } = runClassify(results);
  runState.phase = 'cluster';
  saveRunState(runState);

  // Phase 5: cluster
  const paths = runPaths(opts.projectDir, runId);
  const stateByTestId = new Map<string, { preState: PreState; postState: PostState }>(
    results
      .filter(r => r.postState !== undefined)
      .map(r => [r.testId, { preState: r.preState!, postState: r.postState! }])
  );
  const occurrenceIdByTestId = new Map<string, string>(
    results.map(r => [r.testId, r.occurrenceId]),
  );
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
    occurrenceIdByTestId,
    stateByTestId,
  });

  runState.clusters = clusters;
  runState.clusterCount = clusters.length;
  runState.phase = 'emit';
  saveRunState(runState);

  // Phase 6: emit
  const actualRuntimeMs = Date.now() - startMs;
  runEmit(clusters, infraFailures, runState, projectedRuntimeMs, actualRuntimeMs, {
    testsPlanned: testCases.length,
    testsRan: results.length,
    testsSkipped: testCases.length - results.length,
    skipReasons,
  });
  runState.emitted = true;
  runState.phase = 'done';
  saveRunState(runState);
}

async function closeAllExistingTabs(browser: CamofoxBrowserMcpAdapter): Promise<void> {
  try {
    const { tabs } = await browser.listTabs();
    for (const tab of tabs) {
      await browser.closeTabExplicit(tab.id).catch(() => { /* best-effort */ });
    }
    if (tabs.length > 0) {
      log.info(`Closed ${tabs.length} stale tab(s) from previous session`);
    }
  } catch {
    // If listTabs fails, proceed — camofox may be starting up
  }
}
