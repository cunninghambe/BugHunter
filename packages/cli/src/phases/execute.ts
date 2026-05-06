// Phase 3: execute — bounded-parallel dispatch (§ 3.8).

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import { executeRaceTest } from './race-runner.js';
import { executeMultiContextTest } from './multi-context-runner.js';
import { BrowserMcpError } from '../adapters/browser-mcp-error.js';
import type { SurfaceMcpAdapter, SurfaceCallResult } from '../adapters/surface-mcp.js';
import type {
  TestCase, TestResult, BugDetection, InfrastructureFailure, PreState, PostState,
  ConsoleError, NetworkRequest, RunState, ToolMeta, DiscoveredIds, BugHunterConfig, PerfArtifacts,
  InterimState, Action, NavTransition,
} from '../types.js';
import { probeHeaders, analyzeProbeResult } from '../security/header-probe.js';
import { extractIdsFromBody, mergeDiscoveredIds } from '../security/resource-id-extractor.js';
import { harvestIdsFromDom } from '../security/dom-id-harvester.js';
import { canaryAppearsAsHtml, canaryAppearsAsAttribute, canaryAppearsInScriptTag } from '../security/injection-palette.js';
import { XSS_OBSERVER_START_SCRIPT, XSS_OBSERVER_DRAIN_SCRIPT } from '../security/xss-observer.js';
import type { XssContext } from '../types.js';
import { classifyReactErrors } from '../classify/react.js';
import { classifyUnboundedList } from '../classify/unbounded-list.js';
import { classifyDomErrorText, CHECK_DOM_ERROR_SCRIPT } from '../classify/dom-error-text.js';
import { classifyNetworkRequests, normalizePath } from '../classify/network.js';
import { harEntriesToNetworkRequests } from '../adapters/har-writer.js';
import { classifyVitals } from '../classify/vitals.js';
import { classifyLongTasks } from '../classify/long-tasks.js';
import { classifyExcessiveRerenders } from '../classify/rerenders.js';
import { classifyNPlusOne, classifyDedupMissing, classifyCancelMissing } from '../classify/request-hygiene.js';
import { classifyMissingStateChange, MUTATION_OBSERVER_START_SCRIPT, MUTATION_OBSERVER_STOP_SCRIPT, ARIA_SNAPSHOT_SCRIPT, PORTAL_COUNT_SCRIPT } from '../classify/state-change.js';
import type { AriaSnapshot } from '../types.js';
import { classifyVisualAnomaliesConsistent } from '../classify/vision.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { VisionConfig } from '../types.js';
import { writeActionLog } from '../repro/action-log.js';
import { resolveActionLogUrl } from '../repro/replay.js';
import { runFormSubmit, waitForFormPresent, isStringKeyedRecord } from './form-submit-runner.js';
import {
  captureInterimState,
  runRefreshTransition,
  runRefreshMidMutation,
  runBackTransition,
  runForwardTransition,
  runBackThenForwardTransition,
  runDeepLinkNoAuth,
  runHistoryCorruptTransition,
  capturePostFormAndClassify,
} from './nav-transition-runner.js';
import { hashSchema } from '../util/hash.js';
import { runPaths, type RunPaths } from '../store/filesystem.js';
import { log } from '../log.js';
import { createId } from '../lib/ids.js';
import { nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';
import { MAX_CONSECUTIVE_INFRA_FAILURES } from '../config.js';
import { shrinkFuzzCase } from '../mutation/fuzz.js';
import type { PerfCollector } from '../perf/perf-collector.js';
import { ensureAxeLoaded, getAxeScript, classifyA11yDelta } from '../classify/accessibility.js';
import type { A11yViolation } from '../classify/accessibility.js';
import { classifyA11yBaseline } from '../classify/a11y-baseline.js';
import { PlaywrightKeyboardTrapProbe } from '../adapters/keyboard-trap-probe.js';
import { FocusTracker } from '../adapters/focus-tracker.js';
import type { FocusAfterActionResult } from '../classify/a11y-baseline.js';
import { classifySeoCorpus } from '../classify/seo.js';
import type { SeoPageInput } from '../classify/seo.js';
import { harEntriesToCsrfObservations } from '../adapters/har-writer.js';
import { detectMissingCsrf } from '../security/csrf-detector.js';
import { detectHallucinatedRoutes } from '../classify/hallucinated-route.js';
import type { DiscoveredPage, BrowserPlatformTelemetry, InvariantEvaluation } from '../types.js';
import { isReadOnlyAction, MutatingActionRejectedError } from '../util/read-only.js';
import { runBrowserPlatformProbe } from '../discovery/browser-platform-probe.js';
import type { BrowserPlatformProbeOpts } from '../discovery/browser-platform-probe.js';
import { detectNetworkFaultUnhandled } from '../classify/network-fault-unhandled.js';
import { detectOptimisticNoRevert } from '../classify/network-fault-optimistic-revert.js';
import type { OptimisticSnapshot } from '../classify/network-fault-optimistic-revert.js';
import { detectInfiniteLoading, CHECK_LOADING_SCRIPT } from '../classify/infinite-loading.js';
import { filterInvariants } from '../dataIntegrity/filter.js';
import { snapshotInvariantsBefore, evaluateInvariantsAfter } from '../dataIntegrity/evaluator.js';
import type { ActionResult } from '../dataIntegrity/evaluator.js';
import { appendJsonl } from '../store/filesystem.js';

export type ExecuteOptions = {
  testCases: TestCase[];
  runState: RunState;
  browser?: BrowserMcpAdapter;
  surface: SurfaceMcpAdapter;
  maxBugs: number;
  maxRuntimeMs: number;
  budgetMs?: number;
  concurrency: number;
  apiConcurrency: number;
  onClusterFound: (clusterKey: string) => number; // returns current cluster count
  extraHeaders?: Record<string, string>;
  enableA11y?: boolean;
  /** Tool catalog keyed by toolId; used to persist inputSchemaHash in action logs. */
  toolMap?: Map<string, ToolMeta>;
  /**
   * Base URL of the app under test. Used to convert relative page routes
   * ("/products") to absolute URLs for browser.navigate(). Required for
   * the browser path to work when tc.page is a relative route.
   */
  appBaseUrl?: string;
  /** Vision options — all three must be set together for vision to run. */
  visionEnabled?: boolean;
  visionConfig?: VisionConfig;
  visionClient?: VisionClientInterface;
  visionBudget?: VisionBudget;
  /**
   * When true, probe each discovered page URL for security headers (CSP, CORS, cookies).
   * Probes run once per unique origin before test execution. Default: true (matches config).
   */
  headerProbeEnabled?: boolean;
  /** Discovered page URLs to probe (from DiscoveryOutput.pages). Probe deduped by origin. */
  pageUrls?: string[];
  /** v0.6 perf collector — when present, observes each UI occurrence via CDP. */
  perfCollector?: PerfCollector;
  /** v0.6 a11y-strict: enable baseline axe scan + keyboard trap + focus-lost per page. */
  a11yStrict?: boolean;
  /** v0.6 SEO: enable SEO corpus pass after execute. */
  seoEnabled?: boolean;
  /** v0.6 SEO: suppresses seo_title_duplicate_across_routes detections. */
  seoSuppressDuplicateTitles?: boolean;
  /** v0.6 keyboard trap: max Tab presses (default 20). */
  keyboardTrapMaxPresses?: number;
  /** v0.11 max wait for form to appear after trigger click. Default 2000ms. */
  asyncMaxWaitMs?: number;
  /** v0.25: discovered pages list — used by hallucinated-route detector. */
  discoveryPages?: DiscoveredPage[];
  /** v0.25: dynamic routes for which no discoveryFixtures row was found. */
  fixtureUnresolvableRoutes?: Set<string>;
  /** v0.32: frozen clock — all emitted timestamps use this value when set. */
  clock?: Clock;
  /** v0.36 browser-platform probe options — when set, probe runs once per unique pageRoute. */
  browserPlatformOpts?: BrowserPlatformProbeOpts;
};

export type ExecuteResult = {
  results: TestResult[];
  abortReason?: 'budget' | 'max_clusters' | 'max_infra_failures' | 'timeout';
  skipReasons: Array<{ reason: string; count: number }>;
  /** Security header probe detections — emitted before test execution. */
  headerProbeDetections?: BugDetection[];
  /** v0.6 perf artifacts keyed by occurrenceId. Populated when perfCollector is set. */
  perfArtifacts?: Map<string, PerfArtifacts>;
  /** v0.6 a11y baseline detections (per-page, once per route). */
  a11yBaselineDetections?: BugDetection[];
  /** v0.6 SEO corpus detections. */
  seoDetections?: BugDetection[];
  /** v0.36 browser-platform probe detections — present when browserPlatformOpts is set. */
  browserPlatformDetections?: BugDetection[];
  /** v0.36 browser-platform probe telemetry. */
  browserPlatformTelemetry?: BrowserPlatformTelemetry;
  /** v0.42: all invariant evaluation records from the execute phase. */
  dataIntegrityEvaluations?: InvariantEvaluation[];
};

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { testCases, runState, browser, surface, maxRuntimeMs, budgetMs, concurrency, apiConcurrency, extraHeaders, toolMap, appBaseUrl, visionEnabled, visionConfig, visionClient, visionBudget, headerProbeEnabled, pageUrls, perfCollector, a11yStrict, seoEnabled, seoSuppressDuplicateTitles, keyboardTrapMaxPresses, asyncMaxWaitMs, discoveryPages, fixtureUnresolvableRoutes } = opts;
  const clock = opts.clock ?? { kind: 'wall' as const };
  const paths = runPaths(runState.projectDir, runState.runId);
  const deadline = Date.now() + Math.min(maxRuntimeMs, budgetMs ?? maxRuntimeMs);

  // Initialize discoveredIds on runState for IDOR cross-user phase.
  const discoveredIds: DiscoveredIds = runState.discoveredIds ?? new Map<string, Map<string, Set<string>>>();
  runState.discoveredIds = discoveredIds;

  // Per-page a11y baseline: track which routes have already been baselined.
  const baselinedRoutes = new Set<string>();
  const a11yBaselineDetections: BugDetection[] = [];
  const seoPageInputs: SeoPageInput[] = [];
  const browserPlatformDetections: BugDetection[] = [];
  const browserPlatformTelemetryAccum: BrowserPlatformTelemetry = {
    pagesProbed: 0,
    detectionsByKind: {},
    shadowHostsDiscovered: 0,
    workersInstrumented: 0,
    rtcConnectionsObserved: 0,
    permissionsForceDenied: 0,
    bootstrapInstallFailures: 0,
  };

  const keyboardProbe = new PlaywrightKeyboardTrapProbe();
  const focusTracker = new FocusTracker();
  const trapMaxPresses = keyboardTrapMaxPresses ?? 20;

  /**
   * Per-page baseline callback — runs once per unique pageRoute.
   * Called from inside executeUiTestInner before the action executes.
   * Returns a FocusAfterActionResult if the action is complete and focus should be tracked,
   * or undefined to signal baseline-only (no focus observation this call).
   */
  async function onPageBaseline(scope: TabScope, pageRoute: string): Promise<FocusAfterActionResult | undefined> {
    const isFirstVisit = !baselinedRoutes.has(pageRoute);
    baselinedRoutes.add(pageRoute);

    if (isFirstVisit) {
      // Inject axe-core via a11y flag
      if (a11yStrict === true || opts.enableA11y === true) {
        await ensureAxeLoaded(scope).catch(err => {
          log.warn('axe-inject: ensureAxeLoaded failed, baseline scan may return empty', { err: String(err) });
        });
        const axeResult = await scope.evaluate(getAxeScript(opts.runState.config.mobile?.enabled === true)).catch(() => null);
        const axeValue = axeResult?.value as { violations?: unknown } | null | undefined;
        const violations: A11yViolation[] = Array.isArray(axeValue?.violations)
          ? (axeValue.violations as A11yViolation[])
          : [];

        let keyboardTrap = undefined;
        if (a11yStrict === true) {
          keyboardTrap = await keyboardProbe.probe(scope, trapMaxPresses).catch(err => {
            log.warn('keyboard-trap-probe: failed', { err: String(err), page: pageRoute });
            return undefined;
          });
        }

        const baselineDetections = classifyA11yBaseline({
          pageRoute,
          axeViolations: violations,
          keyboardTrap,
        });
        a11yBaselineDetections.push(...baselineDetections);
      }

      // SEO scraping — always runs when seoEnabled (independent of a11y-strict)
      if (seoEnabled === true) {
        const seoData = await scope.evaluate(`
          (function() {
            var title = document.title || null;
            var metaDesc = null;
            var metaDescEl = document.querySelector('meta[name="description"]');
            if (metaDescEl !== null) metaDesc = metaDescEl.getAttribute('content');
            var canonicalHref = null;
            var canonicalEl = document.querySelector('link[rel="canonical"]');
            if (canonicalEl !== null) canonicalHref = canonicalEl.getAttribute('href');
            var h1Count = document.querySelectorAll('h1').length;
            var metaRobots = null;
            var robotsEl = document.querySelector('meta[name="robots"]');
            if (robotsEl !== null) metaRobots = robotsEl.getAttribute('content');
            return { title: title || null, metaDescription: metaDesc, canonicalHref: canonicalHref, h1Count: h1Count, metaRobots: metaRobots };
          })()
        `).catch(() => null);

        if (seoData?.value !== undefined && seoData.value !== null) {
          const d = seoData.value as { title: string | null; metaDescription: string | null; canonicalHref: string | null; h1Count: number; metaRobots: string | null };
          seoPageInputs.push({
            pageRoute,
            title: d.title,
            metaDescription: d.metaDescription,
            canonicalHref: d.canonicalHref,
            h1Count: d.h1Count,
            metaRobots: d.metaRobots,
          });
        }
      }

      // v0.36 browser-platform probe — after axe+SEO, gated on opts.browserPlatformOpts
      if (opts.browserPlatformOpts !== undefined) {
        const probeOpts = { ...opts.browserPlatformOpts, pageRoute };
        const probeResult = await runBrowserPlatformProbe(scope, probeOpts).catch(err => {
          log.warn('browser-platform-probe: failed', { err: String(err), page: pageRoute });
          return null;
        });
        if (probeResult !== null) {
          browserPlatformTelemetryAccum.pagesProbed++;
          if (probeResult.ok) {
            browserPlatformDetections.push(...probeResult.detections);
            for (const d of probeResult.detections) {
              browserPlatformTelemetryAccum.detectionsByKind[d.kind] =
                (browserPlatformTelemetryAccum.detectionsByKind[d.kind] ?? 0) + 1;
            }
            if (probeResult.telemetry.shadowHostsDiscovered !== undefined) {
              browserPlatformTelemetryAccum.shadowHostsDiscovered += probeResult.telemetry.shadowHostsDiscovered;
            }
            if (probeResult.telemetry.workersInstrumented !== undefined) {
              browserPlatformTelemetryAccum.workersInstrumented += probeResult.telemetry.workersInstrumented;
            }
            if (probeResult.telemetry.rtcConnectionsObserved !== undefined) {
              browserPlatformTelemetryAccum.rtcConnectionsObserved += probeResult.telemetry.rtcConnectionsObserved;
            }
            if (probeResult.telemetry.bootstrapInstallFailures !== undefined) {
              browserPlatformTelemetryAccum.bootstrapInstallFailures += probeResult.telemetry.bootstrapInstallFailures;
            }
          } else {
            log.warn('browser-platform-probe: probe returned not-ok', { reason: probeResult.reason, page: pageRoute });
            browserPlatformTelemetryAccum.bootstrapInstallFailures++;
          }
        }
      }
    }

    // Focus tracking: call after every action if a11y-strict
    if (a11yStrict === true) {
      return focusTracker.observe(scope, 'page-action').catch(err => {
        log.warn('focus-tracker: observe failed', { err: String(err), page: pageRoute });
        return undefined;
      });
    }

    return undefined;
  }

  const uiQueue = testCases.filter(t => t.action.via === 'ui');
  const apiQueue = testCases.filter(t => t.action.via === 'api');

  const results: TestResult[] = [];
  const perfArtifacts = new Map<string, PerfArtifacts>();
  const allDataIntegrityEvaluations: InvariantEvaluation[] = [];
  let abortReason: ExecuteResult['abortReason'];
  let consecutiveInfraFailures = runState.consecutiveInfraFailures;

  // v0.42: resolve data-integrity config once
  const diConfig = runState.config.dataIntegrity ?? null;
  const diEnabled = diConfig !== null && diConfig.enabled !== false && diConfig.invariants.length > 0;
  const diEvalCtx = {
    projectDir: runState.projectDir,
    appBaseUrl: appBaseUrl ?? '',
    runId: runState.runId,
  };

  // Compute skip reasons and emit pre-execution banner
  const skipReasons: Array<{ reason: string; count: number }> = [];
  if (browser === undefined && uiQueue.length > 0) {
    skipReasons.push({ reason: 'no browserMcpUrl configured', count: uiQueue.length });
  }

  const willRun = apiQueue.length + (browser !== undefined ? uiQueue.length : 0);
  const willSkip = uiQueue.length - (browser !== undefined ? uiQueue.length : 0);
  const apiLabel = `${apiQueue.length} api`;
  const uiLabel = browser !== undefined ? `, ${uiQueue.length} ui` : '';
  const skipLabel = willSkip > 0
    ? `, ${willSkip} skipped (${skipReasons.map(r => r.reason).join(', ')})`
    : '';
  process.stdout.write(
    `Executing ${testCases.length} planned tests: ${willRun} will run (${apiLabel}${uiLabel})${skipLabel}\n`
  );

  // axe-core is now injected per-page via ensureAxeLoaded() in onPageBaseline,
  // using scope.evaluate() to bypass camofox-mcp's 256 KB init_script limit (#165).
  // AXE_INJECT_SCRIPT / addInitScript path removed — kept exported for legacy callers.

  async function runTest(tc: TestCase): Promise<TestResult> {
    const start = Date.now();
    const syntheticOccurrenceId = createId();

    try {
      // v0.45 Tier 3: runtime guard — fatal if a mutating action reaches executors in read-only mode.
      // Tier 2 (plan) should prevent this; if it fires, we have a gating bug.
      if (runState.config.readOnly === true && !isReadOnlyAction(tc.action, toolMap ?? new Map<string, ToolMeta>())) {
        throw new MutatingActionRejectedError(
          `read-only mode: refusing to execute action kind=${tc.action.kind} toolId=${'toolId' in tc.action ? (tc.action.toolId ?? 'unknown') : 'none'}`
        );
      }

      // v0.19: race test cases take a separate path
      if (tc.race !== undefined && browser !== undefined) {
        const raceConfig = runState.config.raceConditions ?? {};
        const result = await executeRaceTest(tc, {
          browser,
          runId: runState.runId,
          appBaseUrl: appBaseUrl ?? '',
          config: raceConfig,
          reRunForFlakes: runState.config.reRunForFlakes,
        });
        return result;
      }

      // v0.40: multi-context test cases take a separate path (runs last, after race)
      if (tc.multiContext !== undefined && browser !== undefined) {
        const result = await executeMultiContextTest(tc, {
          browser,
          surface,
          runId: runState.runId,
          appBaseUrl: appBaseUrl ?? '',
          config: runState.config.multiContext ?? {},
          clock,
        });
        return result;
      }

      // v0.42: snapshot invariant before clauses for mutating actions
      const isMutating = isMutatingTestCase(tc, toolMap);
      // diEnabled implies diConfig !== null (see declaration above)
      const matchingInvariants = (diEnabled && isMutating)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- diEnabled is true only when diConfig !== null
        ? filterInvariants(diConfig!.invariants, tc)
        : [];
      const diPending = matchingInvariants.length > 0
        ? await snapshotInvariantsBefore(matchingInvariants, tc, diEvalCtx)
        : [];

      let result: TestResult;
      let apiCapturedCall: SurfaceCallResult | undefined;
      if (tc.action.via === 'ui') {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- browser is defined whenever ui tests are queued (see skip guard above)
        result = await executeUiTest(tc, browser!, surface, runState.runId, paths, extraHeaders, appBaseUrl, visionEnabled, visionConfig, visionClient, visionBudget, discoveredIds, onPageBaseline, asyncMaxWaitMs, { enableA11y: opts.enableA11y, enablePerf: perfCollector !== undefined, mobile: opts.runState.config.mobile?.enabled === true }, clock, perfCollector, syntheticOccurrenceId);
      } else {
        const outcome = await executeApiTest(tc, surface, runState.runId, paths, toolMap, discoveredIds, appBaseUrl, clock);
        result = outcome.testResult;
        apiCapturedCall = outcome.capturedCall;
      }

      // v0.42: evaluate invariant after clauses and collect detections
      if (diPending.length > 0) {
        const toolMeta = toolMap?.get(tc.action.toolId ?? '');
        const resolvedUrl = resolveActionLogUrl(tc.page, appBaseUrl) ?? tc.page;
        const actionResult: ActionResult = {
          url: resolvedUrl,
          method: toolMeta?.method,
          status: apiCapturedCall?.status,
          responseBody: apiCapturedCall?.body,
          requestBody: tc.action.input,
          requestHeaders: apiCapturedCall?.headers,
          idempotencyKey: apiCapturedCall?.headers?.['idempotency-key'] ?? apiCapturedCall?.headers?.['Idempotency-Key'],
        };
        const { evaluations, detections } = await evaluateInvariantsAfter(diPending, tc, actionResult, diEvalCtx);
        allDataIntegrityEvaluations.push(...evaluations);
        for (const ev of evaluations) {
          appendJsonl(paths.dataIntegrityJsonl, ev);
        }
        if (detections.length > 0) {
          result.bugs.push(...detections);
          result.passed = false;
        }
      }

      // Perf drain: collect vitals/HAR after the action completes
      if (perfCollector !== undefined && tc.action.via === 'ui') {
        const { perf, har } = await perfCollector.drain(result.occurrenceId).catch(err => {
          log.warn('perf-collector: drain failed', { err: String(err), occurrenceId: result.occurrenceId });
          return { perf: { occurrenceId: result.occurrenceId, webVitals: [], longTasks: [], heapSamples: [], renderEvents: [], navigationEvents: [] }, har: { log: { version: '1.2' as const, creator: { name: 'bughunter', version: '0.6' }, entries: [] } } };
        });
        perfArtifacts.set(result.occurrenceId, perf);

        // Audit-fix: HAR entries → NetworkRequest[] for UI-path classification.
        // Without this, network_5xx / network_4xx_unexpected / 404_for_linked_route
        // could only fire on direct API tests; UI tests had postState.networkRequests = []
        // hardcoded so the classifier saw nothing.
        if (har.log.entries.length > 0 && result.postState !== undefined) {
          const networkRequests = harEntriesToNetworkRequests(har.log.entries);
          result.postState.networkRequests = networkRequests;
          const networkBugs = classifyNetworkRequests(networkRequests, tc.expectedOutcome, true, tc.role);
          result.bugs.push(...networkBugs);
          if (networkBugs.length > 0) result.passed = false;
        }

        // Audit-fix: wire dead perf classifiers (slow_lcp/inp/high_cls, main_thread_blocked,
        // excessive_re_renders, n_plus_one_api_calls, request_dedup_missing). These existed
        // as exported functions with passing unit tests but were never called from any
        // production runner — perfCollector captured PerfArtifacts and HAR but the
        // classification half of v0.6 was never wired. Threshold lookup respects config.
        const perfCfg = runState.config.perf;
        const vitalsBugs = classifyVitals(perf, tc.page, tc.action.kind, {
          lcpMs: perfCfg?.vitalsThresholds?.lcpMs,
          inpMs: perfCfg?.vitalsThresholds?.inpMs,
          cls: perfCfg?.vitalsThresholds?.cls,
        });
        const longTaskBugs = classifyLongTasks(perf, tc.page, perfCfg?.longTaskMs);
        const rerenderBugs = classifyExcessiveRerenders(perf, {
          rerenderCountThreshold: perfCfg?.rerenderCountThreshold,
          rerenderWindowMs: perfCfg?.rerenderWindowMs,
        });
        const nplusOneBugs = classifyNPlusOne(har, perfCfg?.requestHygiene?.nPlusOneThreshold);
        const dedupBugs = classifyDedupMissing(har);
        // V24: wire request_cancellation_missing — requires NavigationEvent[] from CDP session.
        // Returns [] when navigationEvents.length < 2 (single-page test), so no false positives.
        const cancelBugs = classifyCancelMissing(har, perf.navigationEvents ?? []);
        const allPerfBugs = [...vitalsBugs, ...longTaskBugs, ...rerenderBugs, ...nplusOneBugs, ...dedupBugs, ...cancelBugs];
        if (allPerfBugs.length > 0) {
          result.bugs.push(...allPerfBugs);
          result.passed = false;
        }

        // V25: CSRF detection from HAR (gates on headers.enabled)
        if (har.log.entries.length > 0 && opts.runState.config.headers?.enabled !== false) {
          const observations = harEntriesToCsrfObservations(har.log.entries);
          const csrfBugs = detectMissingCsrf(observations, {
            cookieNamePatterns: opts.runState.config.headers?.csrf?.cookieNamePatterns,
          });
          if (csrfBugs.length > 0) {
            result.bugs.push(...csrfBugs);
            result.passed = false;
          }
        }

        // V25: Hallucinated-route detection for render test cases
        if (tc.action.kind === 'render' && discoveryPages !== undefined && discoveryPages.length > 0) {
          const unresolved = fixtureUnresolvableRoutes ?? new Set<string>();
          const hallucinatedOut = detectHallucinatedRoutes({
            renderResults: [result],
            pages: discoveryPages,
            fixtureUnresolvableRoutes: unresolved,
          });
          const entry = hallucinatedOut.perTestId.get(result.testId);
          if (entry !== undefined) {
            result.bugs = result.bugs.filter(d => !entry.removePredicate(d));
            result.bugs.push(...entry.add);
            if (entry.add.length > 0) result.passed = false;
          }
        }
      }

      return result;
    } catch (err) {
      const infra: InfrastructureFailure = {
        id: createId(),
        runId: runState.runId,
        timestamp: nowIso(clock),
        kind: 'generic',
        detail: String(err),
        role: tc.role,
        page: tc.page,
        action: tc.action,
      };
      return {
        testId: tc.id,
        occurrenceId: syntheticOccurrenceId,
        passed: false,
        bugs: [],
        infrastructureFailure: infra,
        durationMs: Date.now() - start,
      };
    }
  }

  // Run in bounded parallel batches
  async function drainQueue(queue: TestCase[], poolSize: number): Promise<void> {
    const inFlight = new Set<Promise<void>>();

    for (const tc of queue) {
      if (Date.now() > deadline) {
        abortReason = 'budget';
        break;
      }
      if (consecutiveInfraFailures >= MAX_CONSECUTIVE_INFRA_FAILURES) {
        abortReason = 'max_infra_failures';
        break;
      }

      const p = runTest(tc).then(result => {
        results.push(result);
        if (result.infrastructureFailure !== undefined) {
          consecutiveInfraFailures++;
          log.warn('Infrastructure failure', result.infrastructureFailure);
        } else {
          consecutiveInfraFailures = 0;
        }
        inFlight.delete(p);
      });
      inFlight.add(p);

      if (inFlight.size >= poolSize) {
        await Promise.race(inFlight);
      }
    }

    await Promise.allSettled(inFlight);
  }

  // Run UI and API queues concurrently (different pools)
  await Promise.all([
    browser !== undefined ? drainQueue(uiQueue, concurrency) : Promise.resolve(),
    drainQueue(apiQueue, apiConcurrency),
  ]);

  // Header probes: once per unique origin, after all tests so as not to inflate runtime at start.
  const headerProbeDetections = await runHeaderProbes(pageUrls, appBaseUrl, headerProbeEnabled, runState.config);

  // SEO corpus pass: classify across all scraped pages after execute completes.
  let seoDetections: BugDetection[] | undefined;
  if (seoEnabled === true && seoPageInputs.length > 0) {
    const origin = appBaseUrl ?? (pageUrls?.[0] !== undefined ? new URL(pageUrls[0].startsWith('http') ? pageUrls[0] : `http://localhost${pageUrls[0]}`).origin : '');
    const robotsTxt = await fetchRobotsTxt(origin);
    seoDetections = classifySeoCorpus({ pages: seoPageInputs, robotsTxt, origin, suppressDuplicateTitles: seoSuppressDuplicateTitles });
    log.info('seo-corpus: complete', { pagesScraped: seoPageInputs.length, detections: seoDetections.length });
  }

  return {
    results,
    abortReason,
    skipReasons,
    headerProbeDetections,
    perfArtifacts: perfArtifacts.size > 0 ? perfArtifacts : undefined,
    a11yBaselineDetections: a11yBaselineDetections.length > 0 ? a11yBaselineDetections : undefined,
    seoDetections: seoDetections !== undefined && seoDetections.length > 0 ? seoDetections : undefined,
    browserPlatformDetections: browserPlatformDetections.length > 0 ? browserPlatformDetections : undefined,
    browserPlatformTelemetry: opts.browserPlatformOpts !== undefined ? browserPlatformTelemetryAccum : undefined,
    dataIntegrityEvaluations: allDataIntegrityEvaluations.length > 0 ? allDataIntegrityEvaluations : undefined,
  };
}

/**
 * v0.42: determine if a test case is mutating. Uses toolMap for API tests;
 * for UI tests, submit/click actions are treated as mutating (render is safe).
 */
function isMutatingTestCase(tc: TestCase, toolMap: Map<string, ToolMeta> | undefined): boolean {
  if (tc.action.via === 'api') {
    const tool = tc.action.toolId !== undefined ? toolMap?.get(tc.action.toolId) : undefined;
    return tool?.sideEffectClass === 'mutating';
  }
  // For UI actions: submit and click (non-render) are treated as mutating
  return tc.action.kind === 'submit' || tc.action.kind === 'click';
}

/**
 * Returns true when a 4xx response is an expected validation rejection of probe-generated
 * bad inputs — not a real bug. 5xx responses and empty bodies are never suppressed.
 *
 * Applies to BOTH mutator palettes (fuzz/null/edge/out_of_bounds, where input was
 * deliberately bad) AND happy palettes when the synthesized happy input was just
 * incomplete enough that a real Zod schema rejected it. Spoonworks calibration
 * (May 2026) showed many happy probes hitting `field is required` validation
 * because the probe input doesn't include every required field — that's a probe
 * coverage gap, not an app bug.
 *
 * @internal exported for unit tests only
 */
export function isMutatorValidationRejection(tc: TestCase, callResult: SurfaceCallResult): boolean {
  const status = callResult.status ?? 0;
  if (status < 400 || status >= 500) return false;

  const { body } = callResult;
  if (body === undefined || body === null) return false;
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  if (bodyStr.trim().length === 0) return false;

  // ZodError shape — either `issues` (parse error) or `error.formErrors`/
  // `error.fieldErrors` (Zod's flatten() output, which Spoonworks-style
  // routes return).
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>;
    if ('issues' in rec && Array.isArray(rec.issues)) return true;
    // Nested error.formErrors / error.fieldErrors (Zod flatten)
    if ('error' in rec && typeof rec.error === 'object' && rec.error !== null) {
      const err = rec.error as Record<string, unknown>;
      if (Array.isArray(err.formErrors) || (err.fieldErrors !== undefined && err.fieldErrors !== null && typeof err.fieldErrors === 'object')) {
        return true;
      }
    }
    // Top-level formErrors / fieldErrors
    if (Array.isArray(rec.formErrors) || (rec.fieldErrors !== undefined && rec.fieldErrors !== null && typeof rec.fieldErrors === 'object')) {
      return true;
    }
    // Generic validation message
    if ('error' in rec) {
      const errStr = String(rec.error).toLowerCase();
      if (errStr.includes('valid') || errStr.includes('invalid') || errStr.includes('bad request') || errStr.includes('zod') || errStr.includes('required')) return true;
    }
    if ('message' in rec) {
      const msgStr = String(rec.message).toLowerCase();
      if (msgStr.includes('valid') || msgStr.includes('required') || msgStr.includes('zod')) return true;
    }
  }

  // Header signals
  const headers: Record<string, string> = callResult.headers ?? {};
  const lowerHeaders: Record<string, string> = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if ((lowerHeaders['x-error-type'] ?? '').toLowerCase().includes('valid')) return true;
  if ((lowerHeaders['content-type'] ?? '').toLowerCase().includes('validation')) return true;

  return false;
}

/**
 * Fetch robots.txt for the given origin. Returns null on any error.
 * Cached in-memory for the life of the execute phase.
 */
async function fetchRobotsTxt(origin: string): Promise<string | null> {
  if (origin === '') return null;
  try {
    const res = await fetch(`${origin}/robots.txt`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

type ArtifactPaths = Pick<RunPaths, 'actionLogsDir' | 'screenshotsDir' | 'domDir' | 'consoleDir' | 'networkDir'>;

async function persistUiArtifacts(
  scope: TabScope,
  occurrenceId: string,
  postSnapshot: { snapshot: string } | null,
  postConsoleErrors: ConsoleError[],
  artifactPaths: ArtifactPaths,
): Promise<void> {
  const { screenshotsDir, domDir, consoleDir, networkDir } = artifactPaths;

  await scope
    .screenshot(path.join(screenshotsDir, `${occurrenceId}.png`))
    .catch(err => log.warn('screenshot failed', { occurrenceId, err: String(err) }));

  if (postSnapshot?.snapshot !== undefined && postSnapshot.snapshot !== '') {
    fs.writeFileSync(path.join(domDir, `${occurrenceId}.html`), postSnapshot.snapshot);
  }

  const consoleContent = postConsoleErrors.length > 0
    ? `${postConsoleErrors.map(e => JSON.stringify({ level: e.level, text: e.text, stack: e.stack })).join('\n')  }\n`
    : '';
  fs.writeFileSync(path.join(consoleDir, `${occurrenceId}.log`), consoleContent);

  // HAR v0.1 stub: real network capture deferred to camofox-mcp v0.2.
  // Emits a valid empty HAR so retest existence check passes.
  fs.writeFileSync(
    path.join(networkDir, `${occurrenceId}.har`),
    JSON.stringify({ log: { version: '1.2', creator: { name: 'bughunter', version: '0.1' }, entries: [] } }),
  );
}

async function executeUiTestInner(
  scope: TabScope,
  tc: TestCase,
  runId: string,
  occurrenceId: string,
  start: number,
  appBaseUrl: string | undefined,
  artifactPaths: ArtifactPaths,
  actionLog: Parameters<typeof writeActionLog>[1],
  visionEnabled?: boolean,
  visionConfig?: VisionConfig,
  visionClient?: VisionClientInterface,
  visionBudget?: VisionBudget,
  discoveredIds?: DiscoveredIds,
  onPageBaseline?: (scope: TabScope, pageRoute: string) => Promise<FocusAfterActionResult | undefined>,
  asyncMaxWaitMs?: number,
  /** V24: extra flags for deferred detector wiring. */
  extras?: { enableA11y?: boolean; enablePerf?: boolean; mobile?: boolean },
  clock: Clock = { kind: 'wall' },
): Promise<TestResult> {
  const bugs: BugDetection[] = [];
  const preConsoleErrors: ConsoleError[] = [];
  const preSnapshot = await scope.snapshot().catch(() => null);

  // State-page re-establishment: if discovery reached this page via a click trigger
  // after navigating to a base route, re-issue the trigger click so the action runs
  // against the correct DOM state. Skipped for `navigate` actions (those take us off
  // the state-page anyway). Must run before MutationObserver start so that trigger-click
  // DOM mutations are not attributed to the action under test, and before the a11y
  // baseline hook so the baseline reflects the correct tab content.
  if (tc.stateContext !== undefined && tc.action.kind !== 'navigate') {
    const triggerRes = await scope.clickByHint(tc.stateContext.triggerHint);
    if (!triggerRes.clicked) {
      return {
        testId: tc.id,
        occurrenceId,
        passed: false,
        bugs: [],
        infrastructureFailure: {
          id: createId(),
          runId,
          timestamp: nowIso(clock),
          kind: 'browser_element_not_found',
          detail: `state-nav: trigger_not_found (hint=${JSON.stringify(tc.stateContext.triggerHint)}, baseRoute=${tc.stateContext.baseRoute})`,
          role: tc.role,
          page: tc.page,
          action: tc.action,
        },
        durationMs: Date.now() - start,
      };
    }
    // For submit actions: replace the fixed 250ms sleep with a bounded form-present poll.
    // For other actions: keep the 250ms settle to let DOM stabilize before the action.
    if (tc.action.kind === 'submit' && tc.action.selector !== undefined) {
      const waitMs = asyncMaxWaitMs ?? 2000;
      const { present } = await waitForFormPresent(scope, tc.action.selector, waitMs);
      if (!present) {
        return {
          testId: tc.id,
          occurrenceId,
          passed: false,
          bugs: [],
          infrastructureFailure: {
            id: createId(),
            runId,
            timestamp: nowIso(clock),
            kind: 'browser_element_not_found',
            detail: `submit: form_never_rendered (formSelector=${tc.action.selector})`,
            role: tc.role,
            page: tc.page,
            action: tc.action,
          },
          durationMs: Date.now() - start,
        };
      }
    } else {
      await new Promise<void>(r => { setTimeout(r, 250); });
    }
  }

  // Per-page baseline hook (a11y-strict): runs once per route before any action.
  let focusAfterThisAction: FocusAfterActionResult | undefined;
  if (onPageBaseline !== undefined) {
    focusAfterThisAction = await onPageBaseline(scope, tc.page).catch(err => {
      log.warn('a11y-baseline: per-page hook failed', { err: String(err), page: tc.page });
      return undefined;
    });
  }

  // V24: pre-action DOM error-text probe. Always-on (cheap ~5ms). Compare with post to avoid
  // blaming the action for pre-existing error text (EC-4 in spec).
  const preErrEval = await scope.evaluate(CHECK_DOM_ERROR_SCRIPT).catch(err => {
    log.debug('v24: pre dom-error-text eval failed', { err: String(err), occurrenceId });
    return null;
  });
  const preDomErrFound = (preErrEval?.value as { found?: boolean } | null | undefined)?.found === true;

  // V24: pre-action axe delta capture. Gated on enableA11y (--a11y flag).
  // Runs AFTER onPageBaseline so axe is loaded on the page (EC-2 in spec).
  // ensureAxeLoaded short-circuits if axe is already present from the baseline call.
  let preA11yViolations: A11yViolation[] = [];
  if (extras?.enableA11y === true) {
    await ensureAxeLoaded(scope).catch(err => {
      log.debug('v24: pre axe-inject failed', { err: String(err), occurrenceId });
    });
    const preAxeRes = await scope.evaluate(getAxeScript(extras?.mobile === true)).catch(err => {
      log.debug('v24: pre axe-run failed', { err: String(err), occurrenceId });
      return null;
    });
    const v = (preAxeRes?.value as { violations?: unknown } | null | undefined)?.violations;
    preA11yViolations = Array.isArray(v) ? (v as A11yViolation[]) : [];
  }

  // v0.45: capture ARIA state + portal baseline before action fires (click actions only).
  let preAriaSnapshot: AriaSnapshot | undefined;
  let prePortalCount = 0;
  if (tc.action.kind === 'click' && tc.action.selector !== undefined) {
    const setSelRes = await scope.evaluate(
      `(function(){ window.__bhAriaSelector = ${JSON.stringify(tc.action.selector)}; return true; })()`
    ).catch(() => null);
    if (setSelRes !== null) {
      const ariaRes = await scope.evaluate(ARIA_SNAPSHOT_SCRIPT).catch(() => null);
      const raw = ariaRes?.value as Record<string, unknown> | null | undefined;
      if (raw !== null && raw !== undefined) {
        preAriaSnapshot = raw as AriaSnapshot;
      }
    }
    const portalRes = await scope.evaluate(PORTAL_COUNT_SCRIPT).catch(() => null);
    prePortalCount = typeof portalRes?.value === 'number' ? portalRes.value : 0;
  }

  try {
    await scope.evaluate(MUTATION_OBSERVER_START_SCRIPT);
  } catch (err) {
    log.warn('MutationObserver start failed; mutWindowMs will be 0', { err: String(err), tcId: tc.id });
  }

  if (tc.action.injectionNonce !== undefined) {
    try {
      await scope.evaluate(XSS_OBSERVER_START_SCRIPT);
    } catch (err) {
      log.debug('xss-observer start failed', { err: String(err), tcId: tc.id });
    }
  }

  try {
    switch (tc.action.kind) {
      case 'click': {
        if (tc.action.selector === undefined) throw new Error('execute: click action missing selector');
        if (tc.action.selector === '') throw new Error('execute: click action has empty selector — planning bug?');
        if (scope.clickWithObservation !== undefined) {
          const obs = await scope.clickWithObservation(tc.action.selector);
          if (obs.accessibleNameAbsent === true) {
            bugs.push({
              kind: 'interactive_element_missing_accessible_name',
              rootCause: `Interactive <${obs.tagName}${obs.role !== null ? ` role="${obs.role}"` : ''}> has no accessible name on ${tc.page}`,
              pageRoute: tc.page,
              selectorClass: tc.action.selector,
              a11yContext: {
                triggeringSelector: tc.action.selector,
                activeElementTag: obs.tagName,
              },
            });
          }
        } else {
          await scope.click(tc.action.selector);
        }
        break;
      }
      case 'submit': {
        if (tc.action.selector === undefined) throw new Error('execute: submit action missing selector');
        if (tc.action.selector === '') throw new Error('execute: submit action has empty selector — planning bug?');
        const inputRecord = isStringKeyedRecord(tc.action.input) ? tc.action.input : {};
        if (tc.action.palette === 'xss_inject') {
          // For XSS injection tests, a form submit failure is non-fatal: the server
          // may still reflect the canary (e.g. in a redirect or partial render).
          await runFormSubmit(scope, tc.action.selector, inputRecord, { asyncMaxWaitMs: asyncMaxWaitMs ?? 2000 })
            .catch(err => {
              log.debug('xss-inject: form submit failed, continuing to detection', { err: String(err), tcId: tc.id });
            });
        } else {
          await runFormSubmit(scope, tc.action.selector, inputRecord, { asyncMaxWaitMs: asyncMaxWaitMs ?? 2000 });
        }
        break;
      }
      case 'fill':
        if (tc.action.selector === undefined) throw new Error('execute: fill action missing selector');
        if (tc.action.selector === '') throw new Error('execute: fill action has empty selector — planning bug?');
        await scope.type(tc.action.selector, String(tc.action.input ?? ''));
        break;
      case 'navigate':
        if (tc.action.selector === undefined) throw new Error('execute: navigate action missing selector');
        if (tc.action.selector === '') throw new Error('execute: navigate action has empty selector — planning bug?');
        {
          const target = tc.action.selector.startsWith('http')
            ? tc.action.selector
            : `${appBaseUrl ?? ''}${tc.action.selector}`;
          await scope.navigate(target);
        }
        break;
      case 'render':
        break;

      case 'api_call':
        // api_call actions are only dispatched via executeApiTest; reaching here is a bug.
        throw new Error(`execute: api_call action reached UI executor — planning bug?`);

      case 'nav_transition': {
        // v0.22 three-phase observation (§3.5):
        //   1. Run navSeed via recursive dispatch (short-settle).
        //   2. Capture interimState.
        //   3. Drive the transition.
        //   4. postState captured below as normal.
        if (tc.action.transition === undefined) {
          throw new Error('execute: nav_transition action missing transition payload');
        }
        const navSeed = tc.action.navSeed;
        let interim: InterimState | undefined;

        if (navSeed !== undefined) {
          if (tc.action.transition.kind === 'refresh') {
            // refresh-mid-mutation: fire reload immediately, before seed settles.
            // Execute the seed dispatch without waiting for settle.
            await runNavSeedAction(scope, navSeed, runId, occurrenceId, appBaseUrl, asyncMaxWaitMs, tc);
            interim = await runRefreshMidMutation(scope, navSeed);
          } else {
            // All other transitions: run seed with normal settle, capture interim, fire transition.
            await runNavSeedAction(scope, navSeed, runId, occurrenceId, appBaseUrl, asyncMaxWaitMs, tc);
            interim = await captureInterimState(scope, navSeed);
            await driveNavTransition(scope, tc.action.transition);
          }
        } else {
          // No seed (deep_link_no_auth, history_corrupt with no seed per §5).
          interim = await captureInterimState(scope, undefined);
          await driveNavTransition(scope, tc.action.transition);
        }

        // Store on the result below (after postState capture).
        // Using a local reference captured by the result assembly at the end of this function.
        Object.assign(tc, { __v22InterimState: interim });
        break;
      }
    }
  } catch (err) {
    if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
      return {
        testId: tc.id,
        occurrenceId,
        passed: false,
        bugs: [],
        infrastructureFailure: {
          id: createId(),
          runId,
          timestamp: nowIso(clock),
          kind: 'browser_element_not_found',
          detail: (err as BrowserMcpError).message,
          role: tc.role,
          page: tc.page,
          action: tc.action,
        } as InfrastructureFailure,
        durationMs: Date.now() - start,
      };
    }
    if (err instanceof BrowserMcpError && (err.kind === 'transport' || err.kind === 'timeout')) {
      return {
        testId: tc.id,
        occurrenceId,
        passed: false,
        bugs: [],
        infrastructureFailure: {
          id: createId(),
          runId,
          timestamp: nowIso(clock),
          kind: 'browser_crash',
          detail: (err as BrowserMcpError).message,
          role: tc.role,
          page: tc.page,
          action: tc.action,
        } as InfrastructureFailure,
        durationMs: Date.now() - start,
      };
    }
    throw new Error(`Browser action failed: ${String(err)}`);
  }

  // v0.20: capture optimistic snapshot ~200ms post-action for detectOptimisticNoRevert.
  // Only for fault-injected cases; the 200ms window is the standard optimistic-UI settle time.
  if (tc.faultInjected !== undefined) {
    await new Promise<void>(r => { setTimeout(r, 200); });
    const optSnap = await scope.snapshot().catch(() => null);
    if (optSnap?.snapshot !== undefined && optSnap.snapshot !== '') {
      Object.assign(tc, {
        __v20OptimisticSnapshot: { snapshot: optSnap.snapshot, capturedAtOffsetMs: 200 },
      });
    }
  }

  // Focus-after-action probe: emit if focus landed on body/null after successful action.
  if (focusAfterThisAction !== undefined) {
    bugs.push(...classifyA11yBaseline({
      pageRoute: tc.page,
      axeViolations: [],
      focusAfterAction: focusAfterThisAction,
    }));
  }

  const mutResult = await scope.evaluate(MUTATION_OBSERVER_STOP_SCRIPT).catch(() => null);
  const mutWindowMs = (mutResult?.value as { durationMs?: number } | undefined)?.durationMs ?? 0;

  const consoleResult = await scope.evaluate(
    '(window.__bhConsoleErrors || []).map(e => ({ level: "error", text: e.text, stack: e.stack }))'
  ).catch(() => null);

  const postConsoleErrors: ConsoleError[] = Array.isArray(consoleResult?.value)
    ? (consoleResult.value as ConsoleError[])
    : [];

  const postSnapshot = await scope.snapshot().catch(() => null);

  // V24: post-action DOM error-text probe.
  const postErrEval = await scope.evaluate(CHECK_DOM_ERROR_SCRIPT).catch(err => {
    log.debug('v24: post dom-error-text eval failed', { err: String(err), occurrenceId });
    return null;
  });
  const postErrPayload = postErrEval?.value as { found?: boolean; text?: string } | null | undefined;
  const postDomErrFound = postErrPayload?.found === true;
  const postDomErrText = postErrPayload?.text ?? '';

  // V24: post-action outerHTML capture for unbounded_list_render. Gated on enablePerf.
  // Capped at 2 MiB; truncation under-counts rows (false-negative, not false-positive).
  let outerHtml = '';
  if (extras?.enablePerf === true) {
    const outerHtmlEval = await scope.evaluate(
      '(function(){var s=document.documentElement.outerHTML||"";return s.length>2097152?s.slice(0,2097152):s;})()'
    ).catch(err => {
      log.debug('v24: outerHTML capture failed', { err: String(err), occurrenceId });
      return null;
    });
    outerHtml = typeof outerHtmlEval?.value === 'string' ? outerHtmlEval.value : '';
  }

  // V24: post-action axe delta capture. Gated on enableA11y.
  // ensureAxeLoaded short-circuits if axe survived the action (SPA persistent window).
  let postA11yViolations: A11yViolation[] = [];
  if (extras?.enableA11y === true) {
    await ensureAxeLoaded(scope).catch(err => {
      log.debug('v24: post axe-inject failed', { err: String(err), occurrenceId });
    });
    const postAxeRes = await scope.evaluate(getAxeScript(extras?.mobile === true)).catch(err => {
      log.debug('v24: post axe-run failed', { err: String(err), occurrenceId });
      return null;
    });
    const v = (postAxeRes?.value as { violations?: unknown } | null | undefined)?.violations;
    postA11yViolations = Array.isArray(v) ? (v as A11yViolation[]) : [];
  }

  // DOM-side ID harvest for cross-user IDOR phase.
  if (postSnapshot?.snapshot !== undefined && discoveredIds !== undefined) {
    const uiIds = harvestIdsFromDom(postSnapshot.snapshot, []);
    if (uiIds.length > 0) {
      mergeDiscoveredIds(discoveredIds, tc.role, '__ui_dom__', uiIds);
    }
  }

  // XSS detection: snapshot reflection + DOM observer drain
  if (tc.action.injectionNonce !== undefined) {
    const nonce = tc.action.injectionNonce;
    const snapshot = postSnapshot?.snapshot ?? '';

    // Reflected XSS: canary appears in the page HTML
    if (snapshot !== '') {
      const xssReflected = detectXssReflection(snapshot, nonce, tc.page, '', 'form_field');
      if (xssReflected !== null) bugs.push(xssReflected);
    }

    // DOM XSS: observer fired
    const drainResult = await scope.evaluate(XSS_OBSERVER_DRAIN_SCRIPT).catch(err => {
      log.debug('xss-observer drain failed', { err: String(err), tcId: tc.id });
      return null;
    });
    if (Array.isArray(drainResult?.value)) {
      type DrainEntry = { nonce: string; fired: boolean; sink: string };
      const entries = drainResult.value as DrainEntry[];
      const fired = entries.find(e => e.nonce === nonce && e.fired === true);
      if (fired !== undefined) {
        const xssContext: XssContext = {
          variant: 'dom_observer',
          injectionPoint: 'form_field',
          fieldName: '',
          sink: fired.sink === 'dom_inserted' ? 'dom_inserted' : 'window_assign',
          nonce,
        };
        bugs.push({
          kind: 'xss_dom',
          rootCause: `XSS DOM execution detected: canary nonce ${nonce} fired via ${fired.sink}`,
          pageRoute: tc.page,
          xssContext,
        });
      }
    }
  }

  // v0.45: post-action ARIA state + portal count (click actions only).
  let postAriaSnapshot: AriaSnapshot | undefined;
  let newPortalCount: number | undefined;
  if (tc.action.kind === 'click' && tc.action.selector !== undefined) {
    const ariaRes = await scope.evaluate(ARIA_SNAPSHOT_SCRIPT).catch(() => null);
    const raw = ariaRes?.value as Record<string, unknown> | null | undefined;
    if (raw !== null && raw !== undefined) {
      postAriaSnapshot = raw as AriaSnapshot;
    }
    const portalRes = await scope.evaluate(PORTAL_COUNT_SCRIPT).catch(() => null);
    const postPortalCount = typeof portalRes?.value === 'number' ? portalRes.value : 0;
    newPortalCount = Math.max(0, postPortalCount - prePortalCount);
  }

  const preState: PreState = {
    url: tc.page,
    title: '',
    consoleErrorCount: preConsoleErrors.length,
    ariaSnapshot: preAriaSnapshot,
  };

  const postState: PostState = {
    url: tc.page,
    title: '',
    consoleErrors: postConsoleErrors,
    networkRequests: [],
    // V24: set the real value instead of hardcoded false, so classifyMissingStateChange sees it.
    domErrorTextDetected: postDomErrFound,
    mutationObserverWindowMs: mutWindowMs,
    ariaSnapshot: postAriaSnapshot,
    newPortalCount,
  };

  // V24: classifyReactErrors replaces classifyConsoleErrors — it emits hydration_mismatch,
  // react_error, and console_error (fallthrough), so no classifications are lost.
  // classifyConsoleErrors remains in console.ts but is no longer called from here.
  bugs.push(...classifyReactErrors(postConsoleErrors, tc.page));
  bugs.push(...classifyNetworkRequests([], tc.expectedOutcome, true, tc.role));

  // V24: dom_error_text — emit only if error appeared post-action and was NOT already present
  // pre-action (EC-4 in spec: pre-existing error text is not the action's fault).
  if (postDomErrFound && !preDomErrFound) {
    const domErrDetection = classifyDomErrorText(postDomErrText, tc.page, '');
    if (domErrDetection !== null) bugs.push(domErrDetection);
  }

  // V24: unbounded_list_render — gated on enablePerf (outerHTML captured only when perf is on).
  if (extras?.enablePerf === true) {
    bugs.push(...classifyUnboundedList(outerHtml, tc.page));
  }

  // V24: accessibility_critical delta — gated on enableA11y (--a11y flag).
  if (extras?.enableA11y === true) {
    bugs.push(...classifyA11yDelta(preA11yViolations, postA11yViolations, tc.page));
  }

  const missingChange = classifyMissingStateChange(preState, postState, tc.action, tc.page);
  if (missingChange !== null) bugs.push(missingChange);

  void preSnapshot;

  await persistUiArtifacts(scope, occurrenceId, postSnapshot, postConsoleErrors, artifactPaths);

  // v0.22: nav_transition post-state classification.
  // interimState was captured and stashed on tc as a side-channel via __v22InterimState.
  const interimState: InterimState | undefined = (tc as unknown as Record<string, unknown>).__v22InterimState as InterimState | undefined;
  if (tc.action.kind === 'nav_transition' && interimState !== undefined && tc.action.transition !== undefined) {
    const navBugs = await capturePostFormAndClassify(
      scope, preState, interimState, postState,
      tc.action.navSeed, tc.page, tc.formSignature,
    );
    bugs.push(...navBugs);
  }

  // Per-occurrence vision pass: only when missing_state_change fired and vision is active.
  if (missingChange !== null && visionEnabled === true && visionClient !== undefined && visionBudget?.tryConsume() === true) {
    const screenshotPath = path.join(artifactPaths.screenshotsDir, `${occurrenceId}.png`);
    let hashOk = true;
    try {
      const buf = fs.readFileSync(screenshotPath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      hashOk = visionBudget.tryConsumeHash(hash);
    } catch {
      // screenshot missing — still try vision (will fail gracefully inside classify)
    }
    if (hashOk) {
      const consistent = await classifyVisualAnomaliesConsistent({
        screenshotPath,
        url: tc.page,
        action: tc.action,
        role: tc.role,
        config: visionConfig,
        client: visionClient,
        budget: visionBudget,
        consistencyRuns: visionConfig?.consistencyRuns ?? 2,
        agreementMode: visionConfig?.agreementMode ?? 'strict',
      }).catch(err => {
        log.warn('vision: classification failed', { occurrenceId, err: String(err) });
        return null;
      });
      if (consistent !== null) {
        bugs.push(...consistent.detections);
      }
    }
  }

  return {
    testId: tc.id,
    occurrenceId,
    passed: bugs.length === 0,
    bugs,
    durationMs: Date.now() - start,
    preState,
    postState,
    ...(interimState !== undefined ? { interimState } : {}),
  };
}

/** Dispatch a seed action through the action switch (shared logic for nav_transition). */
async function runNavSeedAction(
  scope: TabScope,
  seed: Action,
  runId: string,
  occurrenceId: string,
  appBaseUrl: string | undefined,
  asyncMaxWaitMs: number | undefined,
  tc: TestCase,
): Promise<void> {
  switch (seed.kind) {
    case 'click': {
      if (seed.selector === undefined || seed.selector === '') {
        throw new Error('nav-seed: click action missing selector');
      }
      if (scope.clickWithObservation !== undefined) {
        await scope.clickWithObservation(seed.selector);
      } else {
        await scope.click(seed.selector);
      }
      break;
    }
    case 'submit': {
      if (seed.selector === undefined || seed.selector === '') {
        throw new Error('nav-seed: submit action missing selector');
      }
      const inputRecord = isStringKeyedRecord(seed.input) ? seed.input : {};
      await runFormSubmit(scope, seed.selector, inputRecord, {
        asyncMaxWaitMs: asyncMaxWaitMs ?? 2000,
        fillOnly: seed.fillOnly === true,
      });
      break;
    }
    case 'fill': {
      if (seed.selector === undefined || seed.selector === '') {
        throw new Error('nav-seed: fill action missing selector');
      }
      await scope.type(seed.selector, String(seed.input ?? ''));
      break;
    }
    case 'navigate': {
      if (seed.selector === undefined || seed.selector === '') {
        throw new Error('nav-seed: navigate action missing selector');
      }
      const target = seed.selector.startsWith('http')
        ? seed.selector
        : `${appBaseUrl ?? ''}${seed.selector}`;
      await scope.navigate(target);
      break;
    }
    case 'render':
      break;
    case 'nav_transition':
      // Nested nav_transition seeds are not supported — spec disallows chaining (§3.1).
      throw new Error('nav-seed: nested nav_transition not supported');
    case 'api_call':
      throw new Error('nav-seed: api_call cannot be a nav_transition seed (§3.8)');
  }
  void runId; void occurrenceId; void tc;
}

/** Drive the actual transition after the seed. */
async function driveNavTransition(
  scope: TabScope,
  transition: NavTransition,
): Promise<void> {
  switch (transition.kind) {
    case 'refresh':
      await runRefreshTransition(scope);
      break;
    case 'back':
      await runBackTransition(scope);
      break;
    case 'forward':
      await runForwardTransition(scope);
      break;
    case 'back_then_forward':
      await runBackThenForwardTransition(scope);
      break;
    case 'deep_link_no_auth':
      await runDeepLinkNoAuth(scope, transition.capturedUrl);
      break;
    case 'history_corrupt':
      await runHistoryCorruptTransition(scope, transition.pushStates);
      break;
  }
}

async function executeUiTest(
  tc: TestCase,
  browser: BrowserMcpAdapter,
  _surface: SurfaceMcpAdapter,
  runId: string,
  paths: ArtifactPaths,
  extraHeaders?: Record<string, string>,
  appBaseUrl?: string,
  visionEnabled?: boolean,
  visionConfig?: VisionConfig,
  visionClient?: VisionClientInterface,
  visionBudget?: VisionBudget,
  discoveredIds?: DiscoveredIds,
  onPageBaseline?: (scope: TabScope, pageRoute: string) => Promise<FocusAfterActionResult | undefined>,
  asyncMaxWaitMs?: number,
  /** V24: extra flags for deferred detector wiring. */
  extras?: { enableA11y?: boolean; enablePerf?: boolean; mobile?: boolean },
  clock: Clock = { kind: 'wall' },
  /** #146: co-located Web Vitals collector — injected into the main crawl tab. */
  perfCollector?: PerfCollector,
  /** Occurrence id used to tag the CDP action window (generated by runTest). */
  perfOccurrenceId?: string,
): Promise<TestResult> {
  const start = Date.now();
  const occurrenceId = createId();
  const headers = { 'X-BugHunter-Run': runId, ...(extraHeaders ?? {}) };
  const navTarget = tc.stateContext !== undefined ? tc.stateContext.baseRoute : tc.page;
  const pageUrl = navTarget.startsWith('http') ? navTarget : `${appBaseUrl ?? ''}${navTarget}`;

  const absolutePage = resolveActionLogUrl(tc.page, appBaseUrl) ?? tc.page;
  const actionLog = {
    occurrenceId,
    runId,
    role: tc.role,
    page: absolutePage,
    baseUrl: absolutePage,
    actions: [{
      step: 0,
      kind: tc.action.kind,
      selector: tc.action.selector,
      url: absolutePage,
      value: tc.action.input,
      role: tc.role,
      toolId: tc.action.toolId,
      palette: tc.action.palette,
      input: tc.action.input,
      timestamp: nowIso(clock),
    }],
    createdAt: nowIso(clock),
    stateContext: tc.stateContext,
  };

  let result: TestResult;
  try {
    result = await browser.withTab(pageUrl, headers, async (scope) => {
      // #146: inject Web Vitals into the main crawl tab (same tab, no race).
      if (perfCollector !== undefined) {
        await perfCollector.observe(scope, pageUrl).catch(err =>
          log.warn('perf-collector: observe failed', { err: String(err), page: tc.page })
        );
        perfCollector.tick(perfOccurrenceId ?? occurrenceId);
      }

      // v0.20: apply network fault before executing the action; clear in finally.
      if (tc.faultInjected !== undefined) {
        if (scope.applyNetworkFault === undefined) {
          return {
            testId: tc.id,
            occurrenceId,
            passed: false,
            bugs: [],
            infrastructureFailure: {
              id: createId(),
              runId,
              timestamp: nowIso(clock),
              kind: 'generic',
              detail: 'network fault: applyNetworkFault not available on tab scope',
              role: tc.role,
              page: tc.page,
              action: tc.action,
            },
            durationMs: Date.now() - start,
          } satisfies TestResult;
        }
        const applyResult = await scope.applyNetworkFault(tc.faultInjected).catch((err: unknown) => {
          return { applied: false as const, reason: String(err) };
        });
        if (!applyResult.applied) {
          return {
            testId: tc.id,
            occurrenceId,
            passed: false,
            bugs: [],
            infrastructureFailure: {
              id: createId(),
              runId,
              timestamp: nowIso(clock),
              kind: 'generic',
              detail: `network fault apply failed: ${'reason' in applyResult ? applyResult.reason : 'unknown'}`,
              role: tc.role,
              page: tc.page,
              action: tc.action,
            },
            durationMs: Date.now() - start,
          } satisfies TestResult;
        }
      }

      // v0.20: capture pre-action spinner state before the inner executor fires the action.
      const preSpinnerEval = tc.faultInjected !== undefined
        ? await scope.evaluate(CHECK_LOADING_SCRIPT).catch(() => null)
        : null;
      const preHadSpinner = preSpinnerEval?.value === true;

      let innerResult: TestResult;
      try {
        innerResult = await executeUiTestInner(scope, tc, runId, occurrenceId, start, appBaseUrl, paths, actionLog, visionEnabled, visionConfig, visionClient, visionBudget, discoveredIds, onPageBaseline, asyncMaxWaitMs, extras, clock);
      } finally {
        if (tc.faultInjected !== undefined && scope.clearNetworkFault !== undefined) {
          await scope.clearNetworkFault().catch(() => {});
        }
      }

      // #146: read Web Vitals from scope before the tab closes.
      if (perfCollector !== undefined) {
        await perfCollector.captureVitals().catch(err =>
          log.warn('perf-collector: captureVitals failed', { err: String(err), page: tc.page })
        );
      }

      // v0.20: run network-fault detectors when fault was applied.
      if (tc.faultInjected !== undefined && innerResult.preState !== undefined && innerResult.postState !== undefined) {
        const retryStormThresholdRps = 10; // default; TODO: wire from config
        const faultAsyncMaxWaitMs = asyncMaxWaitMs ?? 30_000;

        const unhandled = detectNetworkFaultUnhandled(
          innerResult.preState,
          innerResult.postState,
          tc.faultInjected,
          retryStormThresholdRps,
          faultAsyncMaxWaitMs,
        );
        if (unhandled !== null) innerResult.bugs.push({ ...unhandled, triggeringAction: tc.action, pageRoute: tc.page });

        // v0.20: read the optimistic snapshot stashed on tc by executeUiTestInner.
        const optimisticSnapshot = (tc as unknown as Record<string, unknown>).__v20OptimisticSnapshot as OptimisticSnapshot | undefined ?? null;
        const noRevert = detectOptimisticNoRevert(
          innerResult.preState,
          innerResult.postState,
          tc.faultInjected,
          optimisticSnapshot,
          retryStormThresholdRps,
        );
        if (noRevert !== null) innerResult.bugs.push({ ...noRevert, triggeringAction: tc.action, pageRoute: tc.page });

        // v0.20: capture post-action spinner state and pass real signals to detectInfiniteLoading.
        const postSpinnerEval = await scope.evaluate(CHECK_LOADING_SCRIPT).catch(() => null);
        const postHasSpinner = postSpinnerEval?.value === true;
        const infiniteLoad = detectInfiniteLoading(
          innerResult.preState,
          innerResult.postState,
          tc.faultInjected,
          preHadSpinner,
          postHasSpinner,
        );
        if (infiniteLoad !== null) innerResult.bugs.push({ ...infiniteLoad, triggeringAction: tc.action, pageRoute: tc.page });
      }

      return innerResult;
    });
  } catch (err) {
    // withTab itself failed (openTab or closeTab threw, or fn re-threw after unexpected error)
    result = {
      testId: tc.id,
      occurrenceId,
      passed: false,
      bugs: [],
      infrastructureFailure: {
        id: createId(),
        runId,
        timestamp: nowIso(clock),
        kind: 'generic',
        detail: String(err),
        role: tc.role,
        page: tc.page,
        action: tc.action,
      },
      durationMs: Date.now() - start,
    };
  } finally {
    try {
      writeActionLog(paths.actionLogsDir, actionLog);
    } catch (writeErr) {
      log.warn('writeActionLog failed', { occurrenceId, err: String(writeErr) });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- try+catch above always assigns result before finally
  return result!;
}

type ApiTestOutcome = { testResult: TestResult; capturedCall?: SurfaceCallResult };

async function executeApiTest(
  tc: TestCase,
  surface: SurfaceMcpAdapter,
  runId: string,
  paths: ArtifactPaths,
  toolMap?: Map<string, ToolMeta>,
  discoveredIds?: DiscoveredIds,
  appBaseUrl?: string,
  clock: Clock = { kind: 'wall' },
): Promise<ApiTestOutcome> {
  const start = Date.now();
  const bugs: BugDetection[] = [];
  const occurrenceId = createId();
  let capturedCall: SurfaceCallResult | undefined;

  const toolSchema = (tc.action.toolId !== undefined && tc.action.toolId !== '') ? toolMap?.get(tc.action.toolId)?.inputSchema : undefined;
  const absolutePage = resolveActionLogUrl(tc.page, appBaseUrl) ?? tc.page;
  const actionLog = {
    occurrenceId,
    runId,
    role: tc.role,
    page: absolutePage,
    baseUrl: absolutePage,
    actions: [{
      step: 0,
      kind: tc.action.kind,
      url: absolutePage,
      role: tc.role,
      toolId: tc.action.toolId,
      palette: tc.action.palette,
      input: tc.action.input,
      inputSchemaHash: toolSchema !== undefined ? hashSchema(toolSchema) : undefined,
      timestamp: nowIso(clock),
    }],
    createdAt: nowIso(clock),
  };

  // Resolve the call identifier: prefer toolId (HTTP route key), fall back to toolName
  // (MCP tool name) when SurfaceMCP omits toolId from ToolMeta — observed on openapi/express
  // stacks where toolId is absent at runtime despite the TypeScript type requiring it (#178).
  const callToolId = tc.action.toolId !== undefined && tc.action.toolId !== ''
    ? tc.action.toolId
    : undefined;
  const callToolName = callToolId === undefined ? (tc.action.toolName ?? undefined) : undefined;
  const hasCallTarget = callToolId !== undefined || callToolName !== undefined;

  let result: TestResult;
  try {
    if (!hasCallTarget) {
      result = { testId: tc.id, occurrenceId, passed: true, bugs: [], durationMs: 0 };
    } else {
      const callResult = await surface.surface_call({
        ...(callToolId !== undefined ? { toolId: callToolId } : { name: callToolName }),
        role: tc.role,
        input: tc.action.input ?? {},
        noAutoRelogin: tc.action.palette !== 'happy',
      });
      capturedCall = callResult;

      // Harvest resource IDs from successful responses for IDOR cross-user phase.
      const toolIdForHarvest = callToolId ?? callToolName ?? '';
      if (callResult.ok === true && discoveredIds !== undefined) {
        const ids = extractIdsFromBody(callResult.body);
        if (ids.length > 0) {
          mergeDiscoveredIds(discoveredIds, tc.role, toolIdForHarvest, ids);
        }
      }

      // XSS reflection check.
      // Only meaningful when the response renders as HTML — for an
      // application/json response the browser never parses any literal
      // `<script>` text in the body as a script. Responses to fuzz/edge
      // inputs frequently echo the payload via Zod-style validation error
      // messages, which produced FP `xss_reflected` clusters before this
      // gate (see Spoonworks calibration, May 2026).
      if (tc.action.injectionNonce !== undefined) {
        const nonce = tc.action.injectionNonce;
        const contentType = (callResult.headers?.['content-type'] ?? callResult.headers?.['Content-Type'] ?? '').toLowerCase();
        const isJsonResponse = contentType.includes('application/json')
          || (callResult.body !== undefined && callResult.body !== null && typeof callResult.body === 'object');
        if (!isJsonResponse) {
          const bodyStr = typeof callResult.body === 'string'
            ? callResult.body
            : JSON.stringify(callResult.body ?? '');
          const xssDetection = detectXssReflection(bodyStr, nonce, tc.page, callToolId ?? callToolName ?? '', 'json_body');
          if (xssDetection !== null) bugs.push(xssDetection);
        }
      }

      // surface_call_failed
      if (callResult.ok !== true && tc.action.palette === 'happy') {
        const status = callResult.status ?? 0;
        const isAnonymous = tc.role === 'anonymous' || tc.role === 'anon';
        // Suppress: 401/403 from anon (correct security response, separate
        // auth_bypass_via_unauthed_route detector handles the inverse), 429
        // (rate-limit hit during scan, not an app bug), 422 ("Unprocessable
        // Entity" — HTTP-spec validation failure). Spoonworks calibration
        // (May 2026).
        const skipStatus =
          ((status === 401 || status === 403) && isAnonymous)
          || status === 429
          || status === 422;
        if (status >= 400 && status < 500 && !skipStatus) {
          if (!isMutatorValidationRejection(tc, callResult)) {
            const meta = callToolId !== undefined ? toolMap?.get(callToolId) : undefined;
            const endpoint = meta !== undefined
              ? `${meta.method} ${normalizePath(meta.path)}`
              : (callToolId ?? callToolName);
            if (meta === undefined) {
              log.debug(`toolMap miss for toolId ${callToolId ?? callToolName}; using bare id as endpoint`);
            }
            // 404s on happy probes with empty/placeholder inputs are usually
            // probe-coverage gaps (no real :id was discovered), not app bugs.
            // Mark as low confidence so the default --min-confidence=medium
            // gate hides them but they remain in bugs-low-confidence.jsonl
            // for triage. Spoonworks calibration (May 2026).
            const inputObj = (tc.action.input ?? {}) as Record<string, unknown>;
            const probeInputLooksSynthetic =
              Object.keys(inputObj).length === 0 ||
              Object.values(inputObj).some(v =>
                typeof v === 'string' && (v === '' || /^test value$|^test\.local|^aaaa+$/i.test(v))
              );
            const isLikelyProbeGap = status === 404 && probeInputLooksSynthetic;
            bugs.push({
              kind: 'surface_call_failed',
              rootCause: `surface_call failed with status ${status} for tool ${callToolId ?? callToolName}`,
              endpoint,
              status,
              responseBodyShape: callResult.error?.message,
              confidence: isLikelyProbeGap ? 'low' : 'high',
            });
          }
        }
      }

      // Network classification via status.
      // status: 0 means "request never completed" (connectivity failure, CORS, abort) —
      // treat it as a real signal, not as "no status reported". Only skip when
      // the field is entirely absent (undefined).
      if (callResult.status !== undefined) {
        const req: NetworkRequest = {
          method: 'POST',
          path: callToolId ?? callToolName ?? '',
          status: callResult.status,
          duration: callResult.durationMs,
        };
        bugs.push(...classifyNetworkRequests([req], tc.expectedOutcome, true, tc.role));
      }

      result = {
        testId: tc.id,
        occurrenceId,
        passed: bugs.length === 0,
        bugs,
        durationMs: Date.now() - start,
      };
    }
  } catch (err) {
    result = {
      testId: tc.id,
      occurrenceId,
      passed: false,
      bugs: [],
      infrastructureFailure: {
        id: createId(),
        runId,
        timestamp: nowIso(clock),
        kind: 'generic',
        detail: String(err),
        role: tc.role,
        page: tc.page,
        action: tc.action,
      },
      durationMs: Date.now() - start,
    };
  } finally {
    // API occurrences only emit the action log; no screenshot/DOM/console/HAR.
    try {
      writeActionLog(paths.actionLogsDir, actionLog);
    } catch (writeErr) {
      log.warn('writeActionLog failed', { occurrenceId, err: String(writeErr) });
    }
  }
  // v0.39: attempt shrinking when a fuzz case produced bugs (bounded budget).
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- try+catch above always assigns result
  if (tc.fuzzMeta !== undefined && result!.bugs.length > 0) {
    const fuzzMeta = tc.fuzzMeta;
    const shrinkBudgetMs = 30_000;
    const shrinkMaxSteps = 50;
    try {
      const shrunkValue = await shrinkFuzzCase(
        { strategy: fuzzMeta.strategy, subSeed: fuzzMeta.subSeed, drawIndex: fuzzMeta.drawIndex, originalValue: tc.action.input },
        async (value) => {
          const shrunkInput = buildShrunkInput(tc, value);
          try {
            const callResult = await surface.surface_call({
              ...(callToolId !== undefined ? { toolId: callToolId } : { name: callToolName }),
              role: tc.role,
              input: shrunkInput,
              noAutoRelogin: true,
            });
            return callResult.ok !== true || (callResult.status !== undefined && callResult.status >= 400);
          } catch {
            return false;
          }
        },
        { shrinkMaxSteps, shrinkBudgetMs },
      );
      if (shrunkValue !== undefined) {
        tc.fuzzMeta = { ...fuzzMeta, shrunkValue };
      }
    } catch (shrinkErr) {
      log.debug('fuzz shrink error (suppressed)', { err: String(shrinkErr) });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- try+catch above always assigns result before finally
  return { testResult: result!, capturedCall };
}

function buildShrunkInput(tc: TestCase, shrunkValue: unknown): unknown {
  if (typeof tc.action.input === 'object' && tc.action.input !== null && typeof shrunkValue === 'object' && shrunkValue !== null) {
    return { ...(tc.action.input as Record<string, unknown>), ...(shrunkValue as Record<string, unknown>) };
  }
  return shrunkValue;
}

/**
 * Check body for XSS canary reflection. Returns a BugDetection or null.
 */
function detectXssReflection(
  body: string,
  nonce: string,
  pageRoute: string,
  endpoint: string,
  injectionPoint: XssContext['injectionPoint'],
): BugDetection | null {
  let sink: XssContext['sink'] | null = null;
  if (canaryAppearsInScriptTag(body, nonce)) {
    sink = 'reflected_script';
  } else if (canaryAppearsAsAttribute(body, nonce)) {
    sink = 'reflected_attr';
  } else if (canaryAppearsAsHtml(body, nonce)) {
    sink = 'reflected_html';
  }
  if (sink === null) return null;

  const xssContext: XssContext = {
    variant: 'canary_reflected',
    injectionPoint,
    fieldName: '',
    sink,
    nonce,
  };
  return {
    kind: 'xss_reflected',
    rootCause: `XSS reflected: canary nonce ${nonce} appeared as ${sink}`,
    pageRoute: pageRoute !== '' ? pageRoute : undefined,
    endpoint: endpoint !== '' ? endpoint : undefined,
    xssContext,
    // Reflected-script in real HTML is high; reflected-attr / reflected-html
    // are still strong signals but more prone to FPs in odd contexts (e.g.
    // attribute-encoded text content). injectionPoint==='json_body' should
    // never reach here post-fix (caller skips JSON responses).
    confidence: sink === 'reflected_script' ? 'high' : 'medium',
  };
}

type ProbedOriginState = { count: number; routes: Set<string> };
const MAX_PROBES_PER_ORIGIN = 2;

/**
 * Build the absolute URL from a page route and a base URL.
 * Returns null if the absolute URL cannot be parsed.
 */
function buildAbsoluteUrl(pageRoute: string, baseUrl: string): string | null {
  const abs = pageRoute.startsWith('http') ? pageRoute : `${baseUrl}${pageRoute}`;
  try {
    new URL(abs);
    return abs;
  } catch {
    log.debug('header-probe: skipped (URL parse failed)', { absoluteUrl: abs });
    return null;
  }
}

/**
 * For each origin, select up to MAX_PROBES_PER_ORIGIN representative routes:
 * prefer '/', then the longest pathname, then alphabetically first.
 */
function dedupeRoutesPerOrigin(
  urls: string[],
  baseUrl: string,
  maxProbes: number,
): Array<{ absoluteUrl: string; origin: string }> {
  const originRoutes = new Map<string, string[]>();

  for (const pageRoute of urls) {
    const abs = buildAbsoluteUrl(pageRoute, baseUrl);
    if (abs === null) continue;
    const origin = new URL(abs).origin;
    const existing = originRoutes.get(origin) ?? [];
    existing.push(abs);
    originRoutes.set(origin, existing);
  }

  const result: Array<{ absoluteUrl: string; origin: string }> = [];

  for (const [origin, routes] of originRoutes) {
    if (result.length >= maxProbes) break;

    const sorted = [...new Set(routes)].sort((a, b) => {
      const pa = new URL(a).pathname;
      const pb = new URL(b).pathname;
      if (pa === '/') return -1;
      if (pb === '/') return 1;
      if (pb.length !== pa.length) return pb.length - pa.length;
      return pa.localeCompare(pb);
    });

    const selected = sorted.slice(0, MAX_PROBES_PER_ORIGIN);
    for (const absoluteUrl of selected) {
      result.push({ absoluteUrl, origin });
    }
  }

  return result;
}

/**
 * Probe a single URL, retrying once on network error or 5xx (250ms backoff).
 */
async function probeAndAnalyze(
  absoluteUrl: string,
  config: BugHunterConfig,
): Promise<{ detections: BugDetection[]; status: number; durationMs: number }> {
  const analyzeOpts = {
    cspLocalhostMode: config.headers?.csp?.localhostMode,
    cookieLocalhostMode: config.headers?.cookies?.localhostMode,
    csrfCookieNamePatterns: config.headers?.csrf?.cookieNamePatterns,
    stackTraceFingerprintLength: config.headers?.stackTrace?.frameFingerprintLength,
  };

  const delay250 = (): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, 250); });
  const attempt = async (): Promise<ReturnType<typeof probeHeaders>> => probeHeaders({ url: absoluteUrl, method: 'GET' });

  let probeResult: Awaited<ReturnType<typeof probeHeaders>>;
  try {
    probeResult = await attempt();
    if (probeResult.status >= 500) {
      await delay250();
      probeResult = await attempt();
    }
  } catch {
    await delay250();
    probeResult = await attempt();
  }

  const detections = analyzeProbeResult(probeResult, absoluteUrl, analyzeOpts);
  return { detections, status: probeResult.status, durationMs: probeResult.durationMs };
}

/**
 * Probe security headers for each unique origin in the given page URL list.
 * Up to MAX_PROBES_PER_ORIGIN routes per origin; capped by config.headers.maxHeaderProbes.
 */
async function runHeaderProbes(
  pageUrls: string[] | undefined,
  appBaseUrl: string | undefined,
  enabled: boolean | undefined,
  config: BugHunterConfig,
): Promise<BugDetection[]> {
  const totalPageUrls = pageUrls?.length ?? 0;
  const maxProbes = config.headers?.maxHeaderProbes ?? 100;

  log.info('header-probe: starting', { enabled: enabled !== false, totalPageUrls, appBaseUrl, maxProbes });

  if (enabled === false) {
    log.info('header-probe: complete', { originsAttempted: 0, originsSucceeded: 0, totalDetections: 0 });
    return [];
  }

  const urls = pageUrls ?? [];
  const baseUrl = appBaseUrl ?? '';
  const probeTargets = dedupeRoutesPerOrigin(urls, baseUrl, maxProbes);

  const detections: BugDetection[] = [];
  const probedOrigins = new Map<string, ProbedOriginState>();
  let originsSucceeded = 0;

  for (const { absoluteUrl, origin } of probeTargets) {
    const state = probedOrigins.get(origin);
    if (state !== undefined && state.count >= MAX_PROBES_PER_ORIGIN) {
      log.debug('header-probe: skipped (origin already probed)', { absoluteUrl, origin });
      continue;
    }

    log.info('header-probe: probing origin', { origin, absoluteUrl });

    try {
      const { detections: found, status, durationMs } = await probeAndAnalyze(absoluteUrl, config);
      detections.push(...found);
      originsSucceeded++;

      const entry = probedOrigins.get(origin) ?? { count: 0, routes: new Set<string>() };
      entry.count++;
      entry.routes.add(absoluteUrl);
      probedOrigins.set(origin, entry);

      log.info('header-probe: origin probed', { origin, status, durationMs, detectionCount: found.length });
    } catch (err) {
      log.warn('header-probe: request failed', { absoluteUrl, err: String(err) });
    }
  }

  log.info('header-probe: complete', {
    originsAttempted: probedOrigins.size,
    originsSucceeded,
    totalDetections: detections.length,
  });

  return detections;
}
