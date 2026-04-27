// bughunter run — main run pipeline orchestrator.

import { createId } from '@paralleldrive/cuid2';
import { loadConfig, resolvedConfig } from '../config.js';
import { initRunState, saveRunState, loadRunState } from '../store/run-state.js';
import { runPaths } from '../store/filesystem.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { AnthropicVisionClient } from '../adapters/vision-client.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import { runExecute } from '../phases/execute.js';
import { runClassify } from '../phases/classify.js';
import { runCluster } from '../phases/cluster.js';
import { makeVisionBudget } from '../classify/vision-budget.js';
import { resolveVisionConfig } from '../classify/vision.js';
import type { PreState, PostState, SkippedItem, TestCase, TestResult, VisualBaselineEntry } from '../types.js';
import { runEmit } from '../phases/emit.js';
import { log } from '../log.js';

function aggregateDiscoverySkips(skipList: SkippedItem[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of skipList) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

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

  // Resolve vision auth — Anthropic Messages API requires an API key.
  // CLAUDE_CODE_OAUTH_TOKEN is NOT usable here (Messages API explicitly rejects OAuth tokens).
  const visionEnabled = resolved.vision?.enabled ?? false;
  let visionAuth: import('../adapters/vision-client.js').VisionAuth | undefined;
  if (visionEnabled) {
    const apiKey =
      resolved.vision?.apiKey ??
      process.env['ANTHROPIC_API_KEY'] ??
      process.env['CLAUDE_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'vision.enabled is true but no ANTHROPIC_API_KEY was found. ' +
        'Set ANTHROPIC_API_KEY or vision.apiKey. ' +
        'Note: CLAUDE_CODE_OAUTH_TOKEN does not work for the Messages API — provision a real API key at console.anthropic.com.'
      );
    }
    visionAuth = { kind: 'apiKey', apiKey };
  }

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

  // Construct vision budget + client (one per run; shared by discover + execute)
  const resolvedVision = resolveVisionConfig(resolved.vision, visionAuth ? '__present__' : '');
  const visionBudget = visionEnabled ? makeVisionBudget(resolvedVision.maxCalls) : undefined;
  const visionClient = visionEnabled && visionAuth
    ? new AnthropicVisionClient(visionAuth, resolvedVision.model, 30_000)
    : undefined;

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

  const runState = resumeState ?? initRunState(opts.projectDir, runId, resolved);
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
    opts.route,
    visionClient,
    visionBudget,
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
    visionEnabled,
    visionConfig: resolved.vision,
    visionClient,
    visionBudget,
  });

  if (abortReason) {
    log.warn(`Run stopped: ${abortReason}`);
    runState.partialEmit = true;
  }
  runState.skipReasons = skipReasons;

  runState.testResults = results;
  runState.phase = 'classify';
  saveRunState(runState);

  // Synthesise visual baseline test cases + results (Option a from § 4.3.1).
  // These bypass execute and are merged directly into classify + cluster inputs.
  const { baselineTestCases, baselineResults } = synthesiseVisualBaselineCases(
    runId, discovery.visualBaselineDetections ?? []
  );

  // Phase 4: classify
  const allResults = [...results, ...baselineResults];
  const { bugs, infraFailures } = runClassify(allResults);
  runState.phase = 'cluster';
  saveRunState(runState);

  // Phase 5: cluster
  const paths = runPaths(opts.projectDir, runId);
  const allTestCases = [...testCases, ...baselineTestCases];
  const stateByTestId = new Map<string, { preState: PreState; postState: PostState }>(
    results
      .filter(r => r.postState !== undefined)
      .map(r => [r.testId, { preState: r.preState!, postState: r.postState! }])
  );
  const occurrenceIdByTestId = new Map<string, string>(
    allResults.map(r => [r.testId, r.occurrenceId]),
  );
  const { clusters } = runCluster({
    detections: bugs,
    testCases: allTestCases,
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

  // Merge discovery-phase skip reasons into the execute-phase skip reasons.
  const discoverySkipReasons = aggregateDiscoverySkips(discovery.skipList);
  const allSkipReasons = [...discoverySkipReasons, ...skipReasons];

  const visionSummary = visionBudget ? {
    enabled: true,
    called: visionBudget.consumed,
    succeeded: visionBudget.consumed,
    anomaliesFound: clusters.filter(c => c.kind === 'visual_anomaly').length,
    abortReason: visionBudget.abortReason,
  } : undefined;

  runEmit(clusters, infraFailures, runState, projectedRuntimeMs, actualRuntimeMs, {
    testsPlanned: testCases.length,
    testsRan: results.length,
    testsSkipped: testCases.length - results.length,
    skipReasons: allSkipReasons,
    vision: visionSummary,
  });
  runState.emitted = true;
  runState.phase = 'done';
  saveRunState(runState);
}

/**
 * Synthesise TestCase + TestResult pairs from visual baseline detections.
 * These are pre-baked results that bypass the executor entirely (§ 4.3.1 Option a).
 */
function synthesiseVisualBaselineCases(
  runId: string,
  entries: VisualBaselineEntry[]
): { baselineTestCases: TestCase[]; baselineResults: TestResult[] } {
  const baselineTestCases: TestCase[] = [];
  const baselineResults: TestResult[] = [];

  for (const { page, detection } of entries) {
    const testId = createId();
    const occurrenceId = createId();

    const tc: TestCase = {
      id: testId,
      runId,
      role: 'anonymous',
      page: page.route,
      action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
      expectedOutcome: 'success',
      palette: 'happy',
    };

    const result: TestResult = {
      testId,
      occurrenceId,
      passed: false,
      bugs: [detection],
      durationMs: 0,
    };

    baselineTestCases.push(tc);
    baselineResults.push(result);
  }

  return { baselineTestCases, baselineResults };
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
