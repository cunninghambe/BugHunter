// bughunter run — main run pipeline orchestrator.

import { loadConfig, resolvedConfig } from '../config.js';
import { setIdFactory, createId, resetIdFactory } from '../lib/ids.js';
import { makeClock, nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';
import { loadHar, loadNormalizeConfig, makeHarReplayer } from '../adapters/har-replay.js';
import type { HarReplayer } from '../adapters/har-replay.js';
import { initRunState, saveRunState, loadRunState } from '../store/run-state.js';
import { runPaths } from '../store/filesystem.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { makeBrowserAdapter } from '../adapters/browser-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
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
import type { BugDetection, ClockTestingConfig, ClockTestingTelemetry, PerfArtifacts, PreState, PostState, SkippedItem, TestCase, TestResult, VisualBaselineEntry, PenTestingTelemetry, RaceConditionsConfig, InterleavingVariant, BugHunterConfig } from '../types.js';
import type { ClockConditionName } from '../security/clock-conditions.js';
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
import type { RunSummary, SeedHookExecution, BugCluster, FuzzConfig, FuzzTelemetry } from '../types.js';
import { applySuppressions } from '../suppress/apply.js';
import type { BrowserPlatformProbeOpts } from '../discovery/browser-platform-probe.js';

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
  // v0.32 deterministic mode flags
  /** --seed <n>: 32-bit non-negative integer seeding the PRNG for all id generation. */
  seed?: number;
  /** --frozen-clock <iso8601>: all emitted timestamps are pinned to this value. */
  frozenClock?: string;
  /** --frozen-network <path>: replay HTTP from a recorded HAR file. */
  frozenNetwork?: string;
  /** --record-network <path>: record outbound HTTP to a HAR file. */
  recordNetwork?: string;
  /** --allow-network-miss: when --frozen-network, fall through to live network on a miss. */
  allowNetworkMiss?: boolean;
  // v0.39 generative fuzz flags
  /** --fuzz <strategy>: enable fuzz with 'none'|'unicode'|'shape'|'boundary'|'all' */
  fuzz?: string;
  /** --fuzz-strategies <list>: comma-separated subset; takes precedence over --fuzz */
  fuzzStrategies?: string;
  /** --fuzz-runs <N>: draws per field per surface per strategy (default 16) */
  fuzzRuns?: number;
  /** --fuzz-shrink on|off: enable/disable failure-shrinking */
  fuzzShrink?: boolean;
  /** --no-fuzz: hard disable, overrides config.fuzz.enabled = true */
  noFuzz?: boolean;
  // v0.23 clock-testing flags
  /** --clock-tests: enable the clock-injection palette (overrides config.clockTesting.enabled). */
  clockTests?: boolean;
  /** --no-clock-tests: disable clock palette even if config has enabled = true. */
  noClockTests?: boolean;
  /** --clock-conditions <csv>: comma-separated subset of condition names. */
  clockConditions?: string;
  /** v0.45: --read-only mode. Disables all mutating subsystems and actions. */
  readOnly?: boolean;
  // v0.36 browser-platform flags
  /** --browser-platform: enable browser-platform probe (overrides config). */
  browserPlatform?: boolean;
  /** --no-browser-platform: disable browser-platform probe (overrides config). */
  noBrowserPlatform?: boolean;
  /** --browser-platform-force-deny: opt-in to forced-permission-deny path. */
  browserPlatformForceDeny?: boolean;
  /** --browser-platform-sw-stale-ms <ms>: override SW staleness threshold. */
  browserPlatformSwStaleMs?: number;
};

export async function runCommand(opts: RunOptions): Promise<void> {
  // v0.32: seed + clock + network determinism wiring.
  // Must run before any id or timestamp is minted.
  const clock: Clock = makeClock(opts);

  // EC-13: --seed + --resume is incompatible.
  if (opts.seed !== undefined && opts.resume !== undefined) {
    throw new Error('--seed cannot be combined with --resume');
  }

  // EC-6: --fuzz requires --seed.
  if (opts.fuzz !== undefined && opts.fuzz !== 'none' && opts.seed === undefined) {
    throw new Error('--fuzz requires --seed (or runConfig.seed) for deterministic generation');
  }

  // v0.45: --read-only + --reset are mutually exclusive.
  if (opts.readOnly === true && opts.reset === true) {
    throw new Error('--read-only and --reset are mutually exclusive: reset mutates the database');
  }

  // Install seeded id factory when --seed is set; clean up after the run.
  if (opts.seed !== undefined) {
    setIdFactory(opts.seed);
  }

  // OQ-5: warn when only some determinism flags are set.
  const hasSeed = opts.seed !== undefined;
  const hasClock = opts.frozenClock !== undefined;
  const hasNetwork = opts.frozenNetwork !== undefined || opts.recordNetwork !== undefined;
  if ((hasSeed || hasClock || hasNetwork) && !(hasSeed && hasClock && hasNetwork)) {
    process.stderr.write(
      '[bughunter] warn: partial determinism mode — for byte-identical runs, set --seed, --frozen-clock, AND --frozen-network together.\n',
    );
  }

  // OQ-8: when --frozen-network + race conditions enabled, skip race runner.
  // (checked later after raceConditionsConfig is resolved)

  // Build HAR replayer when --frozen-network is set.
  let harReplayer: HarReplayer | undefined;
  if (opts.frozenNetwork !== undefined) {
    const har = loadHar(opts.frozenNetwork);
    const normConfig = loadNormalizeConfig(opts.frozenNetwork);
    harReplayer = makeHarReplayer(har, normConfig);
  }

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

  // v0.36: resolve browser-platform probe options from flags + config file
  const browserPlatformEnabled =
    opts.noBrowserPlatform === true ? false :
    opts.browserPlatform === true ? true :
    (config.browserPlatform?.enabled ?? true);
  const browserPlatformOpts: BrowserPlatformProbeOpts | undefined =
    browserPlatformEnabled ? {
      pageRoute: '',  // overridden per-page inside onPageBaseline
      swStaleThresholdMs: opts.browserPlatformSwStaleMs ?? config.browserPlatform?.swStaleThresholdMs ?? 60_000,
      observationWindowMs: config.browserPlatform?.observationWindowMs ?? 1500,
      permissions: config.browserPlatform?.permissions ?? ['geolocation', 'clipboard-read', 'notifications'],
      enableShadowA11y: config.browserPlatform?.enableShadowA11y ?? true,
      enableForcedPermissionDeny: opts.browserPlatformForceDeny === true || (config.browserPlatform?.enableForcedPermissionDeny ?? false),
    } : undefined;

  // v0.19: resolve race-condition config from flags + config file
  const raceConditionsConfig = buildRaceConditionsConfig(opts, config.raceConditions);

  // v0.39: resolve fuzz config from flags + config file
  const fuzzConfig = buildFuzzConfig(opts, config.fuzz);
  // v0.23: resolve clock-testing config from flags + config file
  const clockTestingConfig = buildClockTestingConfig(opts, config.clockTesting);

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

  // v0.45: readOnly precedence — CLI > env > config.
  const readOnlyFromEnv = process.env['BUGHUNTER_READ_ONLY'] === '1';
  const readOnly = opts.readOnly === true || readOnlyFromEnv || (config.readOnly ?? false);

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
    ...(fuzzConfig !== undefined ? { fuzz: fuzzConfig } : {}),
    // v0.22 nav-state
    enableNavState,
    enableNavStateRefreshRace: navStateRefreshRace,
    enableHistoryCorruption,
    navStateSkipRoutes: navStateSkipRoutes.length > 0 ? navStateSkipRoutes : undefined,
    navStateDeepLinkMaxDepth,
    // v0.23 clock-testing
    ...(clockTestingConfig !== undefined ? { clockTesting: clockTestingConfig } : {}),
    // v0.45 read-only
    ...(readOnly ? { readOnly } : {}),
  });

  // v0.45 Tier 1: force-disable mutating subsystems when readOnly === true.
  const droppedSubsystems: string[] = [];
  if (resolved.readOnly === true) {
    droppedSubsystems.push(...applyReadOnlySubsystemGates(resolved));
  }

  const surface = new HttpSurfaceMcpAdapter(resolved.surfaceMcpUrl);
  const browser = makeBrowserAdapter(resolved);

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
    // OQ-6: prefix runId with seed to avoid path collision across seeded runs.
    const baseId = createId();
    runId = opts.seed !== undefined ? `det-${opts.seed}-${baseId}` : baseId;
    log.info(`Starting new run ${runId}`);
  }

  // Identify BugHunter-issued requests in target audit logs.
  surface.setRunId(runId);

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

  // v0.45: print read-only banner at run start so it's visible in logs.
  const readOnlyBanner = resolved.readOnly === true ? buildReadOnlyBanner() : undefined;
  if (readOnlyBanner !== undefined) {
    process.stdout.write(`\n${readOnlyBanner}\n\n`);
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

  const runState = resumeState ?? initRunState(opts.projectDir, runId, resolved, nowIso(clock));
  runState.surfaceRevision = revision;
  runState.phase = 'discover';
  saveRunState(runState);

  const seedHookTelemetry: SeedHookExecution[] = [];
  const seedCtxBase = {
    projectDir: opts.projectDir,
    appBaseUrl: resolved.appBaseUrl,
    ...(resolved.readOnly === true ? { readOnly: true as const } : {}),
  };

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
    const { results, abortReason, skipReasons, headerProbeDetections, perfArtifacts, a11yBaselineDetections, seoDetections, browserPlatformDetections, browserPlatformTelemetry } = await runExecute({
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
      discoveryPages: discovery.pages,
      fixtureUnresolvableRoutes: new Set(discovery.fixtureUnresolvableRoutes ?? []),
      browserPlatformOpts,
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
      seed: opts.seed,
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

    // Phase 3.8: clock-injection tests (v0.23).
    // Runs after execute + pen-test, before classify. Fresh browser context per test.
    let clockTestingTelemetry: ClockTestingTelemetry | undefined;
    let clockTestingDetections: BugDetection[] = [];
    const clockCfg = resolved.clockTesting;
    if (clockCfg?.enabled === true) {
      const { runClockTests, classifyDateSensitiveBatch, disabledClockTelemetry: disabledTelemetry } = await import('../security/clock-test-runner.js');
      const dateSensitiveCases = classifyDateSensitiveBatch(
        testCases,
        clockCfg.dateSensitiveAllowlist ?? [],
        clockCfg.dateSensitiveDenylist ?? [],
      );
      if (dateSensitiveCases.length > 0 && browser !== undefined) {
        const clockResult = await runClockTests(
          clockCfg,
          dateSensitiveCases,
          surface,
          browser,
          clockCfg.serverClockSource,
        );
        clockTestingDetections = clockResult.detections;
        clockTestingTelemetry = clockResult.telemetry;
        log.info('clock-test-runner: complete', {
          variants: dateSensitiveCases.length,
          detections: clockResult.detections.length,
        });
      } else {
        clockTestingTelemetry = disabledTelemetry();
      }
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
      ...clockTestingDetections,
      ...(browserPlatformDetections ?? []),
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
    const { clusters: rawClusters } = runCluster({
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
      projectName: resolved.projectName,
      clock,
    });

    // v0.28 — apply user-defined suppressions before downstream consumers see the clusters.
    const { clusters, suppressedSamples, suppressedCount } = applySuppressions({
      clusters: rawClusters,
      projectDir: opts.projectDir,
      runId,
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
        const { attributedClusters } = synthesiseHeapAttributedClusters(runId, analyzeResult.detections, clock);

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
    // OQ-8: warn when --frozen-network is combined with race conditions.
    if (harReplayer !== undefined && raceConditionsConfig?.enabled === true) {
      process.stderr.write(
        '[bughunter] warn: --frozen-network is active; race-condition pass skipped (HAR replay returns recorded responses, no real concurrency).\n',
      );
    }

    const actualRuntimeMs = Date.now() - startMs;

    // Merge discovery-phase + plan-phase + execute-phase skip reasons.
    const discoverySkipReasons = aggregateDiscoverySkips(discovery.skipList);
    const seedHookSkipCount = resolved.readOnly === true
      ? seedHookTelemetry.filter(e => e.reason === 'read_only_skipped').length
      : 0;
    const seedHookSkipReasons = seedHookSkipCount > 0
      ? [{ reason: 'read_only_skipped_seed_hook', count: seedHookSkipCount }]
      : [];
    const allSkipReasons = [...discoverySkipReasons, ...planSkipReasons, ...skipReasons, ...seedHookSkipReasons];

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

    const fuzzTelemetry = fuzzConfig?.enabled === true
      ? buildFuzzTelemetry(testCases, fuzzConfig)
      : undefined;

    // Build determinism telemetry block (§6.8).
    const replayTelemetry = harReplayer?.telemetry();
    const deterministicBlock = (hasSeed || hasClock || hasNetwork) ? {
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.frozenClock !== undefined ? { frozenClockIso: opts.frozenClock } : {}),
      ...(opts.frozenNetwork !== undefined ? { frozenNetworkPath: opts.frozenNetwork } : {}),
      ...(replayTelemetry !== undefined ? { networkReplay: replayTelemetry } : {}),
    } : undefined;

    // v0.45: build read-only telemetry block.
    const readOnlyTelemetry = resolved.readOnly === true
      ? buildReadOnlyTelemetry(planSkipReasons, droppedSubsystems, readOnlyBanner ?? buildReadOnlyBanner())
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
      ...(clockTestingTelemetry !== undefined ? { clockTesting: clockTestingTelemetry } : {}),
      ...(raceConditionsTelemetry !== undefined ? { raceConditions: raceConditionsTelemetry } : {}),
      ...(fuzzTelemetry !== undefined ? { fuzz: fuzzTelemetry } : {}),
      ...(crossUserResult.idorTelemetry !== undefined ? { idor: crossUserResult.idorTelemetry } : {}),
      ...(browserPlatformTelemetry !== undefined ? { browserPlatform: browserPlatformTelemetry } : {}),
      suppressedClusters: suppressedCount,
      ...(suppressedSamples.length > 0 ? { suppressedSamples } : {}),
      ...(deterministicBlock !== undefined ? { deterministic: deterministicBlock } : {}),
      ...(readOnlyTelemetry !== undefined ? { readOnly: readOnlyTelemetry } : {}),
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
    // v0.32: restore default id factory so tests/sub-processes are not affected.
    if (opts.seed !== undefined) {
      resetIdFactory();
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
  clock: Clock,
): { attributedClusters: BugCluster[] } {
  const clusterMap = new Map<string, BugCluster>();
  const now = nowIso(clock);

  for (const detection of detections) {
    const sig = clusterSignature(detection);
    if (!clusterMap.has(sig)) {
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
        c.lastSeenAt = now;
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

const ALLOWED_FUZZ_STRATEGIES = ['unicode', 'shape', 'boundary'] as const;

function buildFuzzConfig(opts: RunOptions, configFileFuzz: FuzzConfig | undefined): FuzzConfig | undefined {
  // --no-fuzz is the kill switch; disables everything
  if (opts.noFuzz === true) {
    return { ...(configFileFuzz ?? {}), enabled: false };
  }

  // Validate --fuzz-strategies if provided
  if (opts.fuzzStrategies !== undefined) {
    const parsed = opts.fuzzStrategies.split(',').map(s => s.trim()).filter(s => s !== '');
    if (parsed.length === 0) {
      throw new Error('--fuzz-strategies must specify at least one strategy (unicode, shape, boundary)');
    }
    const invalid = parsed.filter(s => !ALLOWED_FUZZ_STRATEGIES.includes(s as typeof ALLOWED_FUZZ_STRATEGIES[number]));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid --fuzz-strategies value(s): ${invalid.join(', ')}. Allowed: ${ALLOWED_FUZZ_STRATEGIES.join(', ')}.`
      );
    }
  }

  // Validate --fuzz strategy value
  const ALLOWED_FUZZ = ['none', 'unicode', 'shape', 'boundary', 'all'] as const;
  if (opts.fuzz !== undefined) {
    if (!ALLOWED_FUZZ.includes(opts.fuzz as typeof ALLOWED_FUZZ[number])) {
      throw new Error(`Invalid --fuzz value: '${opts.fuzz}'. Allowed: ${ALLOWED_FUZZ.join(', ')}.`);
    }
  }

  const flagEnabled = opts.fuzz !== undefined && opts.fuzz !== 'none';
  const baseEnabled = flagEnabled || (configFileFuzz?.enabled ?? false);
  if (!baseEnabled) return configFileFuzz;

  const runs = opts.fuzzRuns !== undefined ? clampFuzzRuns(opts.fuzzRuns) : undefined;

  return {
    ...(configFileFuzz ?? {}),
    enabled: true,
    ...(opts.fuzz !== undefined ? { strategy: opts.fuzz as FuzzConfig['strategy'] } : {}),
    ...(opts.fuzzStrategies !== undefined
      ? { strategies: opts.fuzzStrategies.split(',').map(s => s.trim()).filter(s => s !== '') as FuzzConfig['strategies'] }
      : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(opts.fuzzShrink !== undefined ? { shrink: opts.fuzzShrink } : {}),
  };
}

function clampFuzzRuns(runs: number): number {
  return Math.min(256, Math.max(1, runs));
}

function buildFuzzTelemetry(testCases: TestCase[], fuzzCfg: FuzzConfig): FuzzTelemetry {
  const fuzzCases = testCases.filter(tc => tc.palette === 'fuzz');
  const activeStrategies = fuzzCfg.strategies ?? (
    fuzzCfg.strategy === 'all' || fuzzCfg.strategy === undefined
      ? ['unicode', 'shape', 'boundary']
      : fuzzCfg.strategy === 'none'
        ? []
        : [fuzzCfg.strategy]
  );

  return {
    enabled: true,
    strategy: fuzzCfg.strategy ?? 'all',
    strategies: activeStrategies,
    runs: fuzzCfg.runs ?? 16,
    draws: fuzzCases.length,
    truncated: false,
    shrunkCount: fuzzCases.filter(tc => tc.fuzzMeta?.shrunkValue !== undefined).length,
    skippedSurfaces: 0,
    errors: [],
  };
}

const ALLOWED_CLOCK_CONDITIONS: ReadonlyArray<ClockConditionName> = [
  'dst_forward', 'dst_backward', 'leap_day', 'y2038_edge', 'far_future',
  'client_skew_plus_1h', 'tz_skew_negative_8h',
];

function buildClockTestingConfig(
  opts: RunOptions,
  configFileClock: ClockTestingConfig | undefined,
): ClockTestingConfig | undefined {
  if (opts.noClockTests === true) return { ...(configFileClock ?? {}), enabled: false };

  const baseEnabled = opts.clockTests === true || (configFileClock?.enabled ?? false);
  if (!baseEnabled) return configFileClock;

  let activeConditions: ClockConditionName[] | undefined = configFileClock?.activeConditions;

  if (typeof opts.clockConditions === 'string' && opts.clockConditions !== '') {
    const parsed = opts.clockConditions.split(',').map(s => s.trim()).filter(s => s !== '');
    const invalid = parsed.filter(s => !ALLOWED_CLOCK_CONDITIONS.includes(s as ClockConditionName));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid --clock-conditions value(s): ${invalid.join(', ')}. ` +
        `Allowed: ${ALLOWED_CLOCK_CONDITIONS.join(', ')}.`,
      );
    }
    activeConditions = parsed as ClockConditionName[];
  }

  return {
    ...(configFileClock ?? {}),
    enabled: true,
    ...(activeConditions !== undefined ? { activeConditions } : {}),
  };
}

async function closeAllExistingTabs(browser: BrowserMcpAdapter): Promise<void> {
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

// --- v0.45 read-only helpers ---

const READ_ONLY_BANNER = `[read-only mode]
  Disabled subsystems: raceConditions, penTesting, synthetic, authFlow, authProbe, V20 mutating-endpoint faults, V42 data-integrity
  Narrowed subsystems: crossUser (IDOR read-only only), xss (skipped), seedHooks (GET/OPTIONS/HEAD only)
  Browser-login POST is the only sanctioned mutation. Use --no-browser-login to suppress.
  Always-fire passive detectors: SEO, a11y, vision, perf vitals, static analysis, naturally-observed 5xx/4xx`;

function buildReadOnlyBanner(): string {
  return READ_ONLY_BANNER;
}

/**
 * Force-disable mutating subsystems on the resolved config object in-place.
 * Returns the list of subsystem names that were disabled.
 */
function applyReadOnlySubsystemGates(resolved: BugHunterConfig): string[] {
  const dropped: string[] = [];

  if (resolved.raceConditions?.enabled === true) {
    log.warn('read-only: race-conditions force-disabled');
    resolved.raceConditions = { ...resolved.raceConditions, enabled: false };
    dropped.push('raceConditions');
  }
  if (resolved.penTesting?.enabled === true) {
    log.warn('read-only: pen-testing force-disabled');
    resolved.penTesting = { ...resolved.penTesting, enabled: false };
    dropped.push('penTesting');
  }
  if (resolved.synthetic?.enabled === true) {
    log.warn('read-only: synthetic scenarios force-disabled');
    resolved.synthetic = { ...resolved.synthetic, enabled: false };
    dropped.push('synthetic');
  }
  if (resolved.authFlow?.enabled === true) {
    log.warn('read-only: auth-flow probes force-disabled (password-reset/session-fix mutate)');
    resolved.authFlow = { ...resolved.authFlow, enabled: false };
    dropped.push('authFlow');
  }
  if (resolved.authProbe?.enabled === true) {
    log.warn('read-only: auth-probe (rate-limit) force-disabled');
    resolved.authProbe = { ...resolved.authProbe, enabled: false };
    dropped.push('authProbe');
  }

  return dropped;
}

function buildReadOnlyTelemetry(
  planSkipReasons: Array<{ reason: string; count: number }>,
  droppedSubsystems: string[],
  banner: string,
): NonNullable<RunSummary['readOnly']> {
  const droppedTestCases = planSkipReasons
    .filter(r => r.reason.startsWith('read_only_'))
    .reduce((sum, r) => sum + r.count, 0);

  return {
    enabled: true,
    droppedTestCases,
    droppedSubsystems,
    blockedAtRuntime: 0,
    banner,
  };
}
