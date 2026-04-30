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
import { clusterSignature } from '../cluster/signature.js';
import { runCrossUser } from '../phases/cross-user.js';
import { runAuthFlow } from '../phases/auth-flow.js';
import { makeVisionBudget } from '../classify/vision-budget.js';
import { resolveVisionConfig } from '../classify/vision.js';
import type { BugDetection, PerfArtifacts, PreState, PostState, SkippedItem, TestCase, TestResult, VisualBaselineEntry, PenTestingTelemetry, RaceConditionsConfig, InterleavingVariant } from '../types.js';
import { DEFAULT_VARIANTS } from '../security/interleaving-palette.js';
import { runEmit } from '../phases/emit.js';
import { classifyMemoryLeak } from '../classify/memory-leak.js';
import { buildRaceConditionsTelemetry } from '../phases/race-runner.js';
import { runFormReachabilityProbes } from '../phases/form-reachability-probe.js';
import type { ProbeKey, ProbeResult } from '../phases/form-reachability-probe.js';
import { log } from '../log.js';
import { createCdpSession, type CdpSession } from '../adapters/cdp-session.js';
import { createPerfCollector, type PerfCollector } from '../perf/perf-collector.js';
import { runBundleProbe } from '../phases/bundle-probe.js';
import { runAnalyze } from '../phases/analyze.js';
import { runSeedHooksAt } from '../seed/runner.js';
import type { RunSummary, SeedHookExecution, BugCluster } from '../types.js';

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
  // v0.6 performance flags
  enablePerf?: boolean;
  enableBundleProbe?: boolean;
  enableMemoryProfile?: boolean;
  lcpThreshold?: number;
  inpThreshold?: number;
  clsThreshold?: number;
  nPlusOneThreshold?: number;
  bundleJsBudgetKb?: number;
  bundleCssBudgetKb?: number;
  // v0.6 a11y/SEO flags
  a11yStrict?: boolean;
  seoEnabled?: boolean;
  noSeoDuplicateTitles?: boolean;
  keyboardTrapMax?: number;
  // v0.11 form-reachability probe
  formReachabilityTimeout?: number;
  // v0.8 heap attribution flags
  enableHeapAttribution?: boolean;
  noHeapAttribution?: boolean;
  heapSnapshotFrequency?: 'auto' | number;
  heapDiffMinInstances?: number;
  heapDiffMinBytes?: number;
  // v0.19 race-condition flags
  /** --race-conditions: shorthand for raceConditions.enabled = true */
  raceConditions?: boolean;
  /** --no-race-conditions: disable even if config has enabled = true */
  noRaceConditions?: boolean;
  /** --race-variants: comma-separated subset */
  raceVariants?: string;
  /** --race-cross-tab: also enable cross_tab variant */
  raceCrossTab?: boolean;
  /** --race-strict: disable consensus voting */
  raceStrict?: boolean;
  // v0.22 nav-state flags (§6.1)
  enableNavState?: boolean;
  navStateRefreshRace?: boolean;
  enableHistoryCorruption?: boolean;
  navStateSkipRoute?: string;
  navStateDeepLinkMaxDepth?: number;
  // v0.21 IDOR flags
  /** Enable v0.21 IDOR / horizontal-authz pass. Implied by --security. Default: off. */
  idor?: boolean;
  /** Disable IDOR even when implied by --security. */
  noIdor?: boolean;
};

export async function runCommand(opts: RunOptions): Promise<void> {
  const config = loadConfig(opts.projectDir);

  // Build perf config from CLI flags (flags override config file)
  const perfEnabled = opts.enablePerf === true || (config.perf?.enabled ?? false);
  const bundleProbeEnabled = opts.enableBundleProbe === true || (config.bundleProbe?.enabled ?? false);
  const heapSampling = opts.enableMemoryProfile === true || (config.perf?.heapSampling ?? false);
  // v0.8: --enable-heap-attribution implies --enable-memory-profile
  const heapAttributionEnabled =
    opts.noHeapAttribution !== true &&
    (opts.enableHeapAttribution === true || (config.perf?.heapAttribution ?? false));

  const perfConfig = perfEnabled ? {
    enabled: true,
    heapSampling: heapSampling || heapAttributionEnabled,
    vitalsThresholds: {
      lcpMs: opts.lcpThreshold ?? config.perf?.vitalsThresholds?.lcpMs ?? 2500,
      inpMs: opts.inpThreshold ?? config.perf?.vitalsThresholds?.inpMs ?? 200,
      cls: opts.clsThreshold ?? config.perf?.vitalsThresholds?.cls ?? 0.1,
    },
    requestHygiene: {
      enabled: true,
      nPlusOneThreshold: opts.nPlusOneThreshold ?? config.perf?.requestHygiene?.nPlusOneThreshold ?? 8,
    },
    longTaskMs: config.perf?.longTaskMs ?? 50,
    rerenderCountThreshold: config.perf?.rerenderCountThreshold ?? 10,
    rerenderWindowMs: config.perf?.rerenderWindowMs ?? 5000,
    heapAttribution: heapAttributionEnabled || (config.perf?.heapAttribution ?? false),
    heapSnapshotFrequency: opts.heapSnapshotFrequency ?? config.perf?.heapSnapshotFrequency ?? 'auto',
    heapDiffMinInstances: opts.heapDiffMinInstances ?? config.perf?.heapDiffMinInstances ?? 10,
    heapDiffMinBytes: opts.heapDiffMinBytes ?? config.perf?.heapDiffMinBytes ?? 5_000_000,
  } : config.perf;

  const bundleProbeConfig = bundleProbeEnabled ? {
    enabled: true,
    jsThresholdGzipBytes: (opts.bundleJsBudgetKb ?? 500) * 1024,
    cssThresholdGzipBytes: (opts.bundleCssBudgetKb ?? 200) * 1024,
    searchPaths: config.bundleProbe?.searchPaths,
  } : config.bundleProbe;

  const a11yStrict = opts.a11yStrict === true || (config.a11yStrict ?? false);
  const seoEnabled = opts.seoEnabled === true || (config.seoEnabled ?? false);
  const seoSuppressDuplicateTitles = opts.noSeoDuplicateTitles === true || (config.seoSuppressDuplicateTitles ?? false);
  const keyboardTrapMaxPresses = opts.keyboardTrapMax ?? config.keyboardTrapMaxPresses ?? 20;

  // v0.19: resolve race-condition config from flags + config file
  const raceConditionsConfig = buildRaceConditionsConfig(opts, config.raceConditions);

  // v0.22 nav-state flag resolution (§6.1): CLI flags override config; implication rules apply.
  // --nav-state-refresh-race and --enable-history-corruption imply --enable-nav-state.
  const navStateRefreshRace = opts.navStateRefreshRace === true || (config.enableNavStateRefreshRace ?? false);
  const enableHistoryCorruption = opts.enableHistoryCorruption === true || (config.enableHistoryCorruption ?? false);
  const enableNavState =
    opts.enableNavState === true ||
    navStateRefreshRace ||
    enableHistoryCorruption ||
    (config.enableNavState ?? false);
  // --nav-state-skip-route is comma-separated globs; merged with config list.
  const navStateSkipRoutes: string[] = [
    ...(config.navStateSkipRoutes ?? []),
    ...(opts.navStateSkipRoute !== undefined ? opts.navStateSkipRoute.split(',').map(s => s.trim()).filter(Boolean) : []),
  ];
  const navStateDeepLinkMaxDepth = opts.navStateDeepLinkMaxDepth ?? config.navStateDeepLinkMaxDepth ?? 3;

  const resolved = resolvedConfig({
    ...config,
    ...(opts.maxBugs !== undefined ? { maxBugs: opts.maxBugs } : {}),
    ...(opts.maxRuntime !== undefined ? { maxRuntimeMs: opts.maxRuntime } : {}),
    ...(opts.budget !== undefined ? { budgetMs: opts.budget } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.apiConcurrency !== undefined ? { apiConcurrency: opts.apiConcurrency } : {}),
    ...(opts.includeExternal !== undefined ? { externalIntegrationsAllowed: opts.includeExternal } : {}),
    // --a11y-strict implies --a11y
    ...(opts.a11y !== undefined || a11yStrict ? { enableA11y: opts.a11y === true || a11yStrict } : {}),
    ...(a11yStrict ? { a11yStrict } : {}),
    ...(seoEnabled ? { seoEnabled } : {}),
    ...(seoSuppressDuplicateTitles ? { seoSuppressDuplicateTitles } : {}),
    ...(keyboardTrapMaxPresses !== 20 ? { keyboardTrapMaxPresses } : {}),
    ...(perfConfig !== undefined ? { perf: perfConfig } : {}),
    ...(bundleProbeConfig !== undefined ? { bundleProbe: bundleProbeConfig } : {}),
    ...(raceConditionsConfig !== undefined ? { raceConditions: raceConditionsConfig } : {}),
    // v0.22 nav-state
    enableNavState,
    enableNavStateRefreshRace: navStateRefreshRace,
    enableHistoryCorruption,
    navStateSkipRoutes: navStateSkipRoutes.length > 0 ? navStateSkipRoutes : undefined,
    navStateDeepLinkMaxDepth,
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

  const seedHookTelemetry: SeedHookExecution[] = [];
  const seedCtxBase = { projectDir: opts.projectDir, appBaseUrl: resolved.appBaseUrl };

  // Seed beforeRun — fires before discovery so hooks can spin up the app or seed the DB.
  const beforeRunResults = await runSeedHooksAt(resolved.seedHooks?.beforeRun, {
    ...seedCtxBase, lifecyclePoint: 'beforeRun',
  });
  seedHookTelemetry.push(...beforeRunResults);

  try {
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

    // Seed afterLogin / perRole — fires once per login role after discover completes.
    // Discover performs a single browser login for the configured role; we mirror that here.
    const loginRole = resolved.browserLogin?.role ?? effectiveRoles[0];
    if (loginRole !== '') {
      const afterLoginResults = await runSeedHooksAt(resolved.seedHooks?.afterLogin, {
        ...seedCtxBase, role: loginRole, lifecyclePoint: 'afterLogin',
      });
      seedHookTelemetry.push(...afterLoginResults);

      const perRoleHooks = resolved.seedHooks?.perRole?.[loginRole];
      if (perRoleHooks !== undefined) {
        const perRoleResults = await runSeedHooksAt(perRoleHooks, {
          ...seedCtxBase, role: loginRole, lifecyclePoint: 'perRole',
        });
        seedHookTelemetry.push(...perRoleResults);
      }

      // Warn for any perRole keys that don't match the active login role.
      for (const configuredRole of Object.keys(resolved.seedHooks?.perRole ?? {})) {
        if (configuredRole !== loginRole) {
          log.info('seed: perRole hook skipped (role not in active roles)', { role: configuredRole });
        }
      }
    }

    // Phase 1.5: form-reachability probe (runs after discover, before plan)
    let probeResults: Map<ProbeKey, ProbeResult> | undefined;
    if (browser !== undefined && resolved.browserLogin?.enabled !== false) {
      const asyncMaxWaitMs = opts.formReachabilityTimeout ?? resolved.asyncMaxWaitMs;
      const appBaseUrl = resolved.appBaseUrl ?? new URL(resolved.surfaceMcpUrl).origin;
      const { results: probeResultMap, telemetry } = await runFormReachabilityProbes({
        browser,
        appBaseUrl,
        pages: discovery.pages,
        roles: effectiveRoles,
        runId,
        extraHeaders: resolved.extraHeaders,
        asyncMaxWaitMs,
        perProbeTimeoutMs: 5000,
        budgetMs: 60_000,
      });
      probeResults = probeResultMap;
      // Attach telemetry to discovery so it lands in state.json
      runState.discovery = { ...discovery, probe: { telemetry } };
      saveRunState(runState);
      log.info('form-reachability-probe: complete', { ...telemetry });
    }

    // Phase 2: plan
    const { testCases, projectedRuntimeMs, skipReasons: planSkipReasons } = await runPlan(
      runId,
      discovery,
      resolved,
      effectiveRoles,
      surface,
      probeResults,
    );
    runState.testCases = testCases;
    runState.phase = 'execute';
    saveRunState(runState);

    // Seed beforeExecute — fires after plan, before execute phase.
    const beforeExecuteResults = await runSeedHooksAt(resolved.seedHooks?.beforeExecute, {
      ...seedCtxBase, lifecyclePoint: 'beforeExecute',
    });
    seedHookTelemetry.push(...beforeExecuteResults);

    // Page URLs for header probing — one per discovered page route.
    const pageUrls = discovery.pages.map(p => p.route);

    // v0.6: create perf collector when --enable-perf is set
    let perfCollector: PerfCollector | undefined;
    let cdpSessionHandle: CdpSession | undefined;

    if (perfEnabled) {
      const cdpResult = await createCdpSession();
      if (cdpResult.ok) {
        const rPaths = runPaths(opts.projectDir, runId);
        const perfDir = `${rPaths.runDir}/perf`;
        try {
          perfCollector = createPerfCollector({
            cdpSession: cdpResult.session,
            perfDir,
            networkDir: rPaths.networkDir,
            heapSampling,
          });
          cdpSessionHandle = cdpResult.session;
          log.info('perf-collector: CDP session started');
        } catch (err) {
          log.warn('perf-collector: failed to create collector', { err: String(err) });
        }
      } else {
        log.warn('perf-collector: failed to start CDP session', { reason: cdpResult.reason });
      }
    }

    // Phase 3: execute
    const { results, abortReason, skipReasons, headerProbeDetections, perfArtifacts, a11yBaselineDetections, seoDetections } = await runExecute({
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
      headerProbeEnabled: resolved.headers?.enabled ?? true,
      pageUrls,
      perfCollector,
      a11yStrict: resolved.a11yStrict ?? false,
      seoEnabled: resolved.seoEnabled ?? false,
      seoSuppressDuplicateTitles: resolved.seoSuppressDuplicateTitles ?? false,
      keyboardTrapMaxPresses: resolved.keyboardTrapMaxPresses ?? 20,
      asyncMaxWaitMs: opts.formReachabilityTimeout ?? resolved.asyncMaxWaitMs,
    });

    // Close CDP session after execute completes
    if (cdpSessionHandle !== undefined) {
      await cdpSessionHandle.close().catch(err =>
        log.warn('perf-collector: CDP session close failed', { err: String(err) })
      );
    }

    if (abortReason !== undefined) {
      log.warn(`Run stopped: ${abortReason}`);
      runState.partialEmit = true;
    }
    runState.skipReasons = skipReasons;

    runState.testResults = results;
    runState.phase = 'classify';
    saveRunState(runState);

    // Phase 3.5: cross-user IDOR probe (runs after execute, before classify).
    // v0.21: --idor / --no-idor flags override config.idor.enabled.
    const idorFlagEnabled = opts.noIdor === true ? false : (opts.idor === true ? true : undefined);
    if (idorFlagEnabled !== undefined) {
      resolved.idor = { ...(resolved.idor ?? {}), enabled: idorFlagEnabled };
    }
    const crossUserResult = await runCrossUser({
      runState,
      surface,
      roles: effectiveRoles,
      maxClusters: resolved.maxBugs,
      onClusterFound: () => runState.clusterCount,
    });
    const { detections: crossUserDetections, testCases: crossUserTestCases } = crossUserResult;

    // Phase 3.6: auth-flow detectors (session fixation, reset token reuse, open redirect).
    const { detections: authFlowDetections, testCases: authFlowTestCases } = await runAuthFlow({
      runState,
      surface,
      browser,
      appBaseUrl: resolved.appBaseUrl ?? new URL(resolved.surfaceMcpUrl).origin,
      roles: effectiveRoles,
      maxClusters: resolved.maxBugs,
      onClusterFound: () => runState.clusterCount,
    });

    // Phase 3.7: active pen-testing (SQL/CMD/PATH/JWT injection probes).
    const penTestingEnabled = resolved.penTesting?.enabled ?? false;
    const penTestingStartMs = Date.now();
    let penTestingTelemetry: PenTestingTelemetry | undefined;
    let penTestingDetections: BugDetection[] = [];

    if (penTestingEnabled) {
      const { runPenTests } = await import('../security/pen-test-runner.js');
      const penResult = await runPenTests(
        {
          enabled: true,
          targetTools: discovery.apiTools,
          forms: discovery.pages.flatMap(p => p.forms),
          variants: resolved.penTesting?.variants ?? ['sql', 'cmd', 'path', 'jwt'],
          jwtTargets: resolved.penTesting?.jwtTargets,
          jwtPublicKeyPemPath: resolved.penTesting?.jwtPublicKeyPemPath,
          maxProbesPerEndpoint: resolved.penTesting?.maxProbesPerEndpoint ?? 25,
          booleanDeltaThreshold: resolved.penTesting?.booleanDeltaThreshold ?? 0.3,
        },
        surface,
      );
      penTestingDetections = penResult.detections;
      penTestingTelemetry = {
        enabled: true,
        ...penResult.telemetry,
        durationMs: Date.now() - penTestingStartMs,
      };
      log.info('pen-test-runner: complete', {
        probes: penResult.telemetry.probesAttempted,
        detections: penResult.detections.length,
      });
    }

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
      ...authFlowDetections.map(d => d.detection),
      ...(a11yBaselineDetections ?? []),
      ...(seoDetections ?? []),
      ...penTestingDetections,
    ];
    const { staticTestCases, staticResults } = synthesiseFakeDetectionCases(runId, staticDetectionList);

    // Phase 4: classify
    const allResults = [...results, ...baselineResults, ...staticResults];
    const { bugs, infraFailures } = runClassify(allResults);
    runState.phase = 'cluster';
    saveRunState(runState);

    // Phase 5: cluster
    const paths = runPaths(opts.projectDir, runId);
    const allTestCases = [...testCases, ...baselineTestCases, ...staticTestCases, ...crossUserTestCases, ...authFlowTestCases];
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
    runState.phase = 'analyze';
    saveRunState(runState);

    // Phase 5.5: analyze — heap-snapshot diffing (v0.8).
    // Only runs when memory_leak_suspected fired OR --enable-heap-attribution is set.
    let heapAttributionSummary: RunSummary['heapAttributionSummary'];

    if (cdpSessionHandle !== undefined && resolved.perf !== undefined) {
      const rPaths = runPaths(opts.projectDir, runId);
      const heapDir = `${rPaths.runDir}/heap`;
      const analyzeResult = await runAnalyze({
        clusters,
        cdpSession: cdpSessionHandle,
        heapDir,
        config: resolved,
        actionCount: results.length,
      });

      if (analyzeResult.ok && analyzeResult.detections.length > 0) {
        // Synthesise attributed detections into cluster form.
        const { attributedClusters } = synthesiseHeapAttributedClusters(runId, analyzeResult.detections);

        // Promote memory_leak_suspected clusters with relatedClusters links.
        linkSuspectedToAttributed(clusters, attributedClusters);

        clusters.push(...attributedClusters);
        runState.clusters = clusters;
        runState.clusterCount = clusters.length;
      }

      heapAttributionSummary = {
        snapshotsCaptured: analyzeResult.ok ? analyzeResult.snapshotsCaptured : 0,
        diffsRun: analyzeResult.ok ? analyzeResult.diffsRun : 0,
        attributedLeaks: analyzeResult.ok ? analyzeResult.detections.length : 0,
        topConstructor: analyzeResult.ok
          ? analyzeResult.detections[0]?.heapContext?.constructorName
          : undefined,
      };
    }

    runState.phase = 'emit';
    saveRunState(runState);

    // Phase 6: emit
    const actualRuntimeMs = Date.now() - startMs;

    // Merge discovery-phase + plan-phase + execute-phase skip reasons.
    const discoverySkipReasons = aggregateDiscoverySkips(discovery.skipList);
    const allSkipReasons = [...discoverySkipReasons, ...planSkipReasons, ...skipReasons];

    const visionSummary = visionEnabled ? {
      enabled: true,
      called: visionBudget?.consumed ?? 0,
      succeeded: visionBudget?.consumed ?? 0,
      anomaliesFound: clusters.filter(c => c.kind === 'visual_anomaly').length,
      abortReason: visionAbortReason ?? visionBudget?.abortReason,
      costUsd: visionBudget !== undefined ? Math.round(visionBudget.costUsd * 10000) / 10000 : 0,
      costCapUsd: visionBudget?.costCapUsd,
      authMode: visionAuthMode,
      consistency: discovery.visionConsistencyTelemetry,
      byViewport: discovery.visionByViewport,
      baseline: discovery.visionBaselineTelemetry,
    } : undefined;

    // v0.6: build perf summary from collected artifacts
    const perfSummary: RunSummary['perfSummary'] = buildPerfSummary(perfArtifacts);

    // Audit-fix: cross-occurrence memory_leak_suspected classification.
    // The detector existed but no production caller ever invoked it. runs heap-sample
    // linear regression across all occurrences to flag a possible leak.
    if (perfArtifacts !== undefined && perfArtifacts.size > 0) {
      const memoryLeakBugs = classifyMemoryLeak(Array.from(perfArtifacts.values()));
      for (const bug of memoryLeakBugs) {
        results.push({
          testId: createId(),
          occurrenceId: createId(),
          passed: false,
          bugs: [bug],
          durationMs: 0,
        });
      }
    }

    // v0.6: run bundle probe sidecar
    const bundleProbeResult = bundleProbeConfig !== undefined
      ? runBundleProbe({ projectDir: opts.projectDir, config: bundleProbeConfig })
      : undefined;
    const bundleSummary: RunSummary['bundleSummary'] = bundleProbeResult !== undefined
      ? {
          initialJsBytesGzipped: bundleProbeResult.totalInitialJsGzip,
          initialCssBytesGzipped: bundleProbeResult.totalInitialCssGzip,
          budgetExceeded: bundleProbeResult.budgetExceeded,
        }
      : undefined;

    const raceConditionsTelemetry = raceConditionsConfig !== undefined
      ? buildRaceConditionsTelemetry(testCases, results, raceConditionsConfig)
      : undefined;

    runEmit(clusters, infraFailures, runState, projectedRuntimeMs, actualRuntimeMs, {
      testsPlanned: testCases.length,
      testsRan: results.length,
      testsSkipped: testCases.length - results.length,
      skipReasons: allSkipReasons,
      vision: visionSummary,
      ...(perfSummary !== undefined ? { perfSummary } : {}),
      ...(bundleSummary !== undefined ? { bundleSummary } : {}),
      ...(seedHookTelemetry.length > 0 ? { seedHookExecutions: seedHookTelemetry } : {}),
      ...(heapAttributionSummary !== undefined ? { heapAttributionSummary } : {}),
      ...(penTestingTelemetry !== undefined ? { penTesting: penTestingTelemetry } : {}),
      ...(raceConditionsTelemetry !== undefined ? { raceConditions: raceConditionsTelemetry } : {}),
      ...(crossUserResult.idorTelemetry !== undefined ? { idor: crossUserResult.idorTelemetry } : {}),
    });
    runState.emitted = true;
    runState.phase = 'done';
    saveRunState(runState);
  } finally {
    // Seed cleanup — always fires, even on abort or infra failure.
    try {
      const cleanupResults = await runSeedHooksAt(resolved.seedHooks?.cleanup, {
        ...seedCtxBase, lifecyclePoint: 'cleanup',
      });
      seedHookTelemetry.push(...cleanupResults);
    } catch (err) {
      log.warn('seed: cleanup hook error (suppressed)', { reason: String(err) });
    }
  }
}

function buildPerfSummary(
  perfArtifacts: Map<string, PerfArtifacts> | undefined
): RunSummary['perfSummary'] {
  if (perfArtifacts === undefined || perfArtifacts.size === 0) return undefined;

  const vitalsByPage: Record<string, { lcp?: number; inp?: number; cls?: number }> = {};
  let longestTaskMs = 0;
  const totalNetworkRequests = 0;

  for (const perf of perfArtifacts.values()) {
    for (const vital of perf.webVitals) {
      const page = vitalsByPage[perf.occurrenceId] ?? {};
      if (vital.name === 'LCP') page.lcp = vital.value;
      if (vital.name === 'INP') page.inp = vital.value;
      if (vital.name === 'CLS') page.cls = vital.value;
      vitalsByPage[perf.occurrenceId] = page;
    }
    for (const task of perf.longTasks) {
      if (task.duration > longestTaskMs) longestTaskMs = task.duration;
    }
  }

  return { vitalsByPage, longestTaskMs, totalNetworkRequests };
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

function synthesiseHeapAttributedClusters(
  runId: string,
  detections: BugDetection[],
): { attributedClusters: BugCluster[] } {
  const clusterMap = new Map<string, BugCluster>();

  for (const detection of detections) {
    const sig = clusterSignature(detection);
    if (!clusterMap.has(sig)) {
      const now = new Date().toISOString();
      clusterMap.set(sig, {
        id: createId(),
        runId,
        kind: detection.kind,
        rootCause: detection.rootCause,
        firstSeenAt: now,
        lastSeenAt: now,
        clusterSize: 1,
        occurrences: [],
        suspectedFiles: [],
        fixHints: [detection.rootCause],
        thirdPartyOrGenerated: false,
      });
    } else {
      const c = clusterMap.get(sig);
      if (c !== undefined) {
        c.clusterSize++;
        c.lastSeenAt = new Date().toISOString();
      }
    }
  }

  return { attributedClusters: Array.from(clusterMap.values()) };
}

function linkSuspectedToAttributed(clusters: BugCluster[], attributedClusters: BugCluster[]): void {
  const suspectedClusters = clusters.filter(c => c.kind === 'memory_leak_suspected');
  if (suspectedClusters.length === 0 || attributedClusters.length === 0) return;

  for (const suspected of suspectedClusters) {
    const newIds = attributedClusters.map(c => c.id);
    suspected.relatedClusterIds = [...new Set([...(suspected.relatedClusterIds ?? []), ...newIds])];
    if (suspected.fixHints.length === 0 || !suspected.fixHints.some(h => h.includes('memory_leak_attributed'))) {
      suspected.fixHints.push('See memory_leak_attributed clusters for retainer attribution.');
    }
  }
}

/**
 * v0.19: Build the effective RaceConditionsConfig from CLI flags + config file.
 * --no-race-conditions overrides everything (escape hatch).
 * --race-conditions enables even if config has enabled = false.
 */
function buildRaceConditionsConfig(
  opts: RunOptions,
  configFileRace: RaceConditionsConfig | undefined,
): RaceConditionsConfig | undefined {
  if (opts.noRaceConditions === true) {
    // --no-race-conditions disables everything regardless of config
    return { ...(configFileRace ?? {}), enabled: false };
  }

  const baseEnabled = opts.raceConditions === true || (configFileRace?.enabled ?? false);
  if (!baseEnabled) return configFileRace;

  // Resolve variants from --race-variants flag.
  // Validate at the CLI boundary — invalid kinds must fail loud, not propagate silently.
  let variants: Array<InterleavingVariant['kind']> | undefined = configFileRace?.variants;
  if (typeof opts.raceVariants === 'string' && opts.raceVariants !== '') {
    const ALLOWED_VARIANTS: ReadonlyArray<InterleavingVariant['kind']> = [
      'double_submit', 'click_then_navigate', 'optimistic_revert', 'interleaved_mutations', 'cross_tab',
    ];
    const parsed = opts.raceVariants.split(',').map(s => s.trim()).filter(s => s !== '');
    const invalid = parsed.filter(s => !ALLOWED_VARIANTS.includes(s as InterleavingVariant['kind']));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid --race-variants value(s): ${invalid.join(', ')}. ` +
        `Allowed: ${ALLOWED_VARIANTS.join(', ')}.`
      );
    }
    variants = parsed as Array<InterleavingVariant['kind']>;
  }

  // --race-cross-tab: add cross_tab to variants
  if (opts.raceCrossTab === true) {
    const base = variants ?? DEFAULT_VARIANTS;
    if (!base.includes('cross_tab')) variants = [...base, 'cross_tab'];
  }

  return {
    ...(configFileRace ?? {}),
    enabled: true,
    ...(variants !== undefined ? { variants } : {}),
    ...(opts.raceStrict === true ? { strict: true } : {}),
  };
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
