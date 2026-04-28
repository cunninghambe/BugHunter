// bughunter run — main run pipeline orchestrator.

import { createId } from '@paralleldrive/cuid2';
import { loadConfig, resolvedConfig } from '../config.js';
import { initRunState, saveRunState, loadRunState } from '../store/run-state.js';
import { runPaths } from '../store/filesystem.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { AnthropicVisionClient } from '../adapters/vision-client.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import { ClaudeCliVisionClient } from '../adapters/vision-claude-cli.js';
import { detectVisionAuth } from '../adapters/vision-auth-detect.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import { runExecute } from '../phases/execute.js';
import { runClassify } from '../phases/classify.js';
import { runCluster } from '../phases/cluster.js';
import { runCrossUser } from '../phases/cross-user.js';
import { makeVisionBudget } from '../classify/vision-budget.js';
import { resolveVisionConfig } from '../classify/vision.js';
import type { BugDetection, PreState, PostState, SkippedItem, TestCase, TestResult, VisualBaselineEntry } from '../types.js';
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
  const browser = resolved.browserMcpUrl !== undefined ? new CamofoxBrowserMcpAdapter(resolved.browserMcpUrl) : undefined;

  // Resolve vision auth — prefer Claude CLI subprocess (Q8); fall back to API key.
  const visionEnabled = resolved.vision?.enabled ?? false;
  let visionClient: VisionClientInterface | undefined;
  let visionAuthMode: 'apiKey' | 'claudeCli' | undefined;
  let visionAbortReason: 'auth' | undefined;

  if (visionEnabled) {
    // Inject config-level apiKey into the env so detectVisionAuth sees it.
    const envWithKey = resolved.vision?.apiKey !== undefined
      ? { ...process.env, ANTHROPIC_API_KEY: resolved.vision.apiKey }
      : process.env;
    const authResult = await detectVisionAuth(envWithKey);

    if (authResult.kind === 'claudeCli') {
      visionAuthMode = 'claudeCli';
    } else if (authResult.kind === 'apiKey') {
      visionAuthMode = 'apiKey';
    } else {
      log.warn('vision.enabled is true but no Claude CLI or ANTHROPIC_API_KEY found — vision disabled for this run');
      visionAbortReason = 'auth';
    }
  }

  // Resume or new run
  let runId: string;
  let resumeState = undefined;
  if (opts.resume !== undefined) {
    runId = opts.resume;
    resumeState = loadRunState(opts.projectDir, runId);
    log.info(`Resuming run ${runId} from phase ${resumeState.phase}`);
  } else {
    runId = createId();
    log.info(`Starting new run ${runId}`);
  }

  const startMs = Date.now();
  const roles = opts.role !== undefined ? [opts.role] : undefined;

  // Construct vision budget + client (one per run; shared by discover + execute)
  const resolvedVision = resolveVisionConfig(resolved.vision, visionAuthMode !== undefined ? '__present__' : '');
  const visionBudget = visionEnabled && visionAbortReason === undefined
    ? makeVisionBudget(resolvedVision.maxCalls, resolvedVision.maxCostUsd)
    : undefined;

  if (visionEnabled && visionAbortReason === undefined && visionAuthMode !== undefined) {
    // Re-detect to get the concrete auth result for client construction
    const envWithKey = resolved.vision?.apiKey !== undefined
      ? { ...process.env, ANTHROPIC_API_KEY: resolved.vision.apiKey }
      : process.env;
    const authResult = await detectVisionAuth(envWithKey);
    if (authResult.kind === 'claudeCli') {
      visionClient = new ClaudeCliVisionClient(authResult.binaryPath, resolvedVision.model, 60_000);
    } else if (authResult.kind === 'apiKey') {
      visionClient = new AnthropicVisionClient({ kind: 'apiKey', apiKey: authResult.apiKey }, resolvedVision.model, 30_000);
    }
  }

  // Phase 0: validate
  const { revision, roles: discoveredRoles } = await runValidate({
    surfaceMcp: surface,
    browserMcp: browser,
    config: resolved,
    resumeState,
    forceResume: opts.forceResume,
  });

  // Clear any stale tabs from previous processes to prevent tab leakage in the camofox session.
  if (browser !== undefined) {
    await closeAllExistingTabs(browser);
  }

  const effectiveRoles = roles ?? discoveredRoles;

  // Run resetCommand if --reset or per-run policy
  if (opts.reset === true) {
    if (resolved.resetCommand === undefined || resolved.resetCommand === '') {
      log.warn('--reset specified but no resetCommand configured; ignoring');
    } else {
      const { execSync } = await import('node:child_process');
      log.info(`Running resetCommand: ${resolved.resetCommand}`);
      execSync(resolved.resetCommand, { cwd: opts.projectDir, stdio: 'inherit' });
    }
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

  // Page URLs for header probing — one per discovered page route.
  const pageUrls = discovery.pages.map(p => p.route);

  // Phase 3: execute
  const { results, abortReason, skipReasons, headerProbeDetections } = await runExecute({
    testCases,
    runState,
    browser,
    surface,
    maxBugs: resolved.maxBugs,
    maxRuntimeMs: resolved.maxRuntimeMs,
    budgetMs: resolved.budgetMs,
    concurrency: resolved.concurrency,
    apiConcurrency: resolved.apiConcurrency,
    onClusterFound: () => runState.clusterCount,
    extraHeaders: resolved.extraHeaders,
    enableA11y: resolved.enableA11y,
    appBaseUrl: resolved.appBaseUrl,
    visionEnabled,
    visionConfig: resolved.vision,
    visionClient,
    visionBudget,
    headerProbeEnabled: resolved.headers !== undefined || resolved.staticAnalysis?.enabled !== false,
    pageUrls,
  });

  if (abortReason !== undefined) {
    log.warn(`Run stopped: ${abortReason}`);
    runState.partialEmit = true;
  }
  runState.skipReasons = skipReasons;

  runState.testResults = results;
  runState.phase = 'classify';
  saveRunState(runState);

  // Phase 3.5: cross-user IDOR probe (runs after execute, before classify).
  const { detections: crossUserDetections, testCases: crossUserTestCases } = await runCrossUser({
    runState,
    surface,
    roles: effectiveRoles,
    maxClusters: resolved.maxBugs,
    onClusterFound: () => runState.clusterCount,
  });

  // Synthesise visual baseline test cases + results (Option a from § 4.3.1).
  // These bypass execute and are merged directly into classify + cluster inputs.
  const { baselineTestCases, baselineResults } = synthesiseVisualBaselineCases(
    runId, discovery.visualBaselineDetections ?? []
  );

  // Synthesise static-analysis detections as fake test cases + results.
  const staticDetectionList: BugDetection[] = [
    ...(discovery.staticDetections ?? []),
    ...(headerProbeDetections ?? []),
    ...crossUserDetections.map(d => d.detection),
  ];
  const { staticTestCases, staticResults } = synthesiseFakeDetectionCases(runId, staticDetectionList);

  // Phase 4: classify
  const allResults = [...results, ...baselineResults, ...staticResults];
  const { bugs, infraFailures } = runClassify(allResults);
  runState.phase = 'cluster';
  saveRunState(runState);

  // Phase 5: cluster
  const paths = runPaths(opts.projectDir, runId);
  const allTestCases = [...testCases, ...baselineTestCases, ...staticTestCases, ...crossUserTestCases];
  const stateByTestId = new Map<string, { preState: PreState; postState: PostState }>(
    results
      .filter(r => r.postState !== undefined)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- filter above ensures postState is set; preState is always present when postState is
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
    maxClusters: resolved.maxBugs,
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

  const visionSummary = visionEnabled ? {
    enabled: true,
    called: visionBudget?.consumed ?? 0,
    succeeded: visionBudget?.consumed ?? 0,
    anomaliesFound: clusters.filter(c => c.kind === 'visual_anomaly').length,
    abortReason: visionAbortReason ?? visionBudget?.abortReason,
    costUsd: visionBudget !== undefined ? Math.round(visionBudget.costUsd * 10000) / 10000 : 0,
    costCapUsd: visionBudget?.costCapUsd,
    authMode: visionAuthMode,
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

/**
 * Synthesise TestCase + TestResult pairs from non-executed detections
 * (static analysis, header probes, cross-user).
 */
function synthesiseFakeDetectionCases(
  runId: string,
  detections: BugDetection[],
): { staticTestCases: TestCase[]; staticResults: TestResult[] } {
  const staticTestCases: TestCase[] = [];
  const staticResults: TestResult[] = [];

  for (const detection of detections) {
    const testId = createId();
    const occurrenceId = createId();

    const tc: TestCase = {
      id: testId,
      runId,
      role: 'system',
      page: detection.endpoint ?? detection.targetPath ?? 'static',
      action: { kind: 'render', via: 'api', expectedOutcome: 'success', palette: 'happy' },
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

    staticTestCases.push(tc);
    staticResults.push(result);
  }

  return { staticTestCases, staticResults };
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
