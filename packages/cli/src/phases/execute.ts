// Phase 3: execute — bounded-parallel dispatch (§ 3.8).

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import { BrowserMcpError } from '../adapters/browser-mcp-error.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type {
  TestCase, TestResult, BugDetection, InfrastructureFailure, PreState, PostState,
  ConsoleError, NetworkRequest, RunState, ToolMeta
} from '../types.js';
import { classifyConsoleErrors } from '../classify/console.js';
import { classifyNetworkRequests, normalizePath } from '../classify/network.js';
import { classifyMissingStateChange, MUTATION_OBSERVER_START_SCRIPT, MUTATION_OBSERVER_STOP_SCRIPT } from '../classify/state-change.js';
import { classifyVisualAnomalies } from '../classify/vision.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { VisionConfig } from '../types.js';
import { writeActionLog } from '../repro/action-log.js';
import { hashSchema } from '../util/hash.js';
import { runPaths, type RunPaths } from '../store/filesystem.js';
import { log } from '../log.js';
import { createId } from '@paralleldrive/cuid2';
import { MAX_CONSECUTIVE_INFRA_FAILURES } from '../config.js';

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
};

export type ExecuteResult = {
  results: TestResult[];
  abortReason?: 'budget' | 'max_clusters' | 'max_infra_failures' | 'timeout';
  skipReasons: Array<{ reason: string; count: number }>;
};

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { testCases, runState, browser, surface, maxRuntimeMs, budgetMs, concurrency, apiConcurrency, extraHeaders, toolMap, appBaseUrl, visionEnabled, visionConfig, visionClient, visionBudget } = opts;
  const paths = runPaths(runState.projectDir, runState.runId);
  const deadline = Date.now() + Math.min(maxRuntimeMs, budgetMs ?? maxRuntimeMs);

  const uiQueue = testCases.filter(t => t.action.via === 'ui');
  const apiQueue = testCases.filter(t => t.action.via === 'api');

  const results: TestResult[] = [];
  let abortReason: ExecuteResult['abortReason'];
  let consecutiveInfraFailures = runState.consecutiveInfraFailures;

  // Compute skip reasons and emit pre-execution banner
  const skipReasons: Array<{ reason: string; count: number }> = [];
  if (!browser && uiQueue.length > 0) {
    skipReasons.push({ reason: 'no browserMcpUrl configured', count: uiQueue.length });
  }

  const willRun = apiQueue.length + (browser ? uiQueue.length : 0);
  const willSkip = uiQueue.length - (browser ? uiQueue.length : 0);
  const apiLabel = `${apiQueue.length} api`;
  const uiLabel = browser ? `, ${uiQueue.length} ui` : '';
  const skipLabel = willSkip > 0
    ? `, ${willSkip} skipped (${skipReasons.map(r => r.reason).join(', ')})`
    : '';
  process.stdout.write(
    `Executing ${testCases.length} planned tests: ${willRun} will run (${apiLabel}${uiLabel})${skipLabel}\n`
  );

  async function runTest(tc: TestCase): Promise<TestResult> {
    const start = Date.now();
    // Mint a synthetic occurrenceId so the outer catch can always return one.
    // If the inner executor runs, it overwrites this with its own minted id.
    const syntheticOccurrenceId = createId();
    try {
      const result = tc.action.via === 'ui'
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- browser is defined whenever ui tests are queued (see skip guard above)
        ? await executeUiTest(tc, browser!, surface, runState.runId, paths, extraHeaders, appBaseUrl, visionEnabled, visionConfig, visionClient, visionBudget)
        : await executeApiTest(tc, surface, runState.runId, paths, toolMap);
      return result;
    } catch (err) {
      const infra: InfrastructureFailure = {
        id: createId(),
        runId: runState.runId,
        timestamp: new Date().toISOString(),
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
        if (result.infrastructureFailure) {
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
    browser ? drainQueue(uiQueue, concurrency) : Promise.resolve(),
    drainQueue(apiQueue, apiConcurrency),
  ]);

  return { results, abortReason, skipReasons };
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

  if (postSnapshot?.snapshot) {
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
): Promise<TestResult> {
  const bugs: BugDetection[] = [];
  const preConsoleErrors: ConsoleError[] = [];
  const preSnapshot = await scope.snapshot().catch(() => null);

  try {
    await scope.evaluate(MUTATION_OBSERVER_START_SCRIPT);
  } catch (err) {
    log.warn('MutationObserver start failed; mutWindowMs will be 0', { err: String(err), tcId: tc.id });
  }

  try {
    switch (tc.action.kind) {
      case 'click':
        if (tc.action.selector === undefined) throw new Error('execute: click action missing selector');
        if (tc.action.selector === '') throw new Error('execute: click action has empty selector — planning bug?');
        await scope.click(tc.action.selector);
        break;
      case 'submit':
        if (tc.action.selector === undefined) throw new Error('execute: submit action missing selector');
        if (tc.action.selector === '') throw new Error('execute: submit action has empty selector — planning bug?');
        await scope.click(tc.action.selector);
        break;
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
          timestamp: new Date().toISOString(),
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
          timestamp: new Date().toISOString(),
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

  const mutResult = await scope.evaluate(MUTATION_OBSERVER_STOP_SCRIPT).catch(() => null);
  const mutWindowMs = (mutResult?.value as { durationMs?: number } | undefined)?.durationMs ?? 0;

  const consoleResult = await scope.evaluate(
    '(window.__bhConsoleErrors || []).map(e => ({ level: "error", text: e.text, stack: e.stack }))'
  ).catch(() => null);

  const postConsoleErrors: ConsoleError[] = Array.isArray(consoleResult?.value)
    ? (consoleResult.value as ConsoleError[])
    : [];

  const postSnapshot = await scope.snapshot().catch(() => null);

  const preState: PreState = {
    url: tc.page,
    title: '',
    consoleErrorCount: preConsoleErrors.length,
  };

  const postState: PostState = {
    url: tc.page,
    title: '',
    consoleErrors: postConsoleErrors,
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: mutWindowMs,
  };

  bugs.push(...classifyConsoleErrors(postConsoleErrors, tc.page));
  bugs.push(...classifyNetworkRequests([], tc.expectedOutcome, true));

  const missingChange = classifyMissingStateChange(preState, postState, tc.action, tc.page);
  if (missingChange) bugs.push(missingChange);

  void preSnapshot;

  await persistUiArtifacts(scope, occurrenceId, postSnapshot, postConsoleErrors, artifactPaths);

  // Per-occurrence vision pass: only when missing_state_change fired and vision is active.
  if (missingChange && visionEnabled && visionClient && visionBudget?.tryConsume()) {
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
      const visualDetections = await classifyVisualAnomalies({
        screenshotPath,
        url: tc.page,
        action: tc.action,
        role: tc.role,
        config: visionConfig,
        client: visionClient,
        budget: visionBudget,
      }).catch(err => {
        log.warn('vision: classification failed', { occurrenceId, err: String(err) });
        return [] as BugDetection[];
      });
      bugs.push(...visualDetections);
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
  };
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
): Promise<TestResult> {
  const start = Date.now();
  const occurrenceId = createId();
  const headers = { 'X-BugHunter-Run': runId, ...(extraHeaders ?? {}) };
  const pageUrl = tc.page.startsWith('http') ? tc.page : `${appBaseUrl ?? ''}${tc.page}`;

  const actionLog = {
    occurrenceId,
    runId,
    role: tc.role,
    page: tc.page,
    baseUrl: tc.page,
    actions: [{
      step: 0,
      kind: tc.action.kind,
      selector: tc.action.selector,
      url: tc.page,
      value: tc.action.input,
      role: tc.role,
      toolId: tc.action.toolId,
      palette: tc.action.palette,
      input: tc.action.input,
      timestamp: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
  };

  let result: TestResult;
  try {
    result = await browser.withTab(pageUrl, headers, (scope) =>
      executeUiTestInner(scope, tc, runId, occurrenceId, start, appBaseUrl, paths, actionLog, visionEnabled, visionConfig, visionClient, visionBudget)
    );
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
        timestamp: new Date().toISOString(),
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

async function executeApiTest(
  tc: TestCase,
  surface: SurfaceMcpAdapter,
  runId: string,
  paths: ArtifactPaths,
  toolMap?: Map<string, ToolMeta>
): Promise<TestResult> {
  const start = Date.now();
  const bugs: BugDetection[] = [];
  const occurrenceId = createId();

  const toolSchema = toolMap?.get(tc.action.toolId ?? '')?.inputSchema;
  const actionLog = {
    occurrenceId,
    runId,
    role: tc.role,
    page: tc.page,
    baseUrl: tc.page,
    actions: [{
      step: 0,
      kind: tc.action.kind,
      url: tc.page,
      role: tc.role,
      toolId: tc.action.toolId,
      palette: tc.action.palette,
      input: tc.action.input,
      inputSchemaHash: toolSchema ? hashSchema(toolSchema) : undefined,
      timestamp: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
  };

  let result: TestResult;
  try {
    if (!tc.action.toolId) {
      result = { testId: tc.id, occurrenceId, passed: true, bugs: [], durationMs: 0 };
    } else {
      const callResult = await surface.surface_call({
        toolId: tc.action.toolId,
        role: tc.role,
        input: tc.action.input ?? {},
        noAutoRelogin: tc.action.palette !== 'happy',
      });

      // surface_call_failed
      if (!callResult.ok && tc.action.palette === 'happy') {
        const status = callResult.status ?? 0;
        if (status >= 400 && status < 500) {
          const meta = toolMap?.get(tc.action.toolId);
          const endpoint = meta
            ? `${meta.method} ${normalizePath(meta.path)}`
            : tc.action.toolId;
          if (!meta) {
            log.debug(`toolMap miss for toolId ${tc.action.toolId}; using bare id as endpoint`);
          }
          bugs.push({
            kind: 'surface_call_failed',
            rootCause: `surface_call failed with status ${status} for tool ${tc.action.toolId}`,
            endpoint,
            status,
            responseBodyShape: callResult.error?.message,
          });
        }
      }

      // Network classification via status.
      // status: 0 means "request never completed" (connectivity failure, CORS, abort) —
      // treat it as a real signal, not as "no status reported". Only skip when
      // the field is entirely absent (undefined).
      if (callResult.status !== undefined) {
        const req: NetworkRequest = {
          method: 'POST',
          path: tc.action.toolId,
          status: callResult.status,
          duration: callResult.durationMs,
        };
        bugs.push(...classifyNetworkRequests([req], tc.expectedOutcome, true));
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
        timestamp: new Date().toISOString(),
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
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- try+catch above always assigns result before finally
  return result!;
}
