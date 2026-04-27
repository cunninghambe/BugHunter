// Phase 3: execute — bounded-parallel dispatch (§ 3.8).

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { BrowserMcpError } from '../adapters/browser-mcp-error.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type {
  TestCase, TestResult, BugDetection, InfrastructureFailure, PreState, PostState,
  ConsoleError, NetworkRequest, RunState, ToolMeta
} from '../types.js';
import { classifyConsoleErrors } from '../classify/console.js';
import { classifyNetworkRequests, normalizePath } from '../classify/network.js';
import { classifyMissingStateChange, MUTATION_OBSERVER_START_SCRIPT, MUTATION_OBSERVER_STOP_SCRIPT } from '../classify/state-change.js';
import { classifyDomErrorText } from '../classify/dom-error-text.js';
import { writeActionLog } from '../repro/action-log.js';
import { hashSchema } from '../util/hash.js';
import { runPaths } from '../store/filesystem.js';
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
};

export type ExecuteResult = {
  results: TestResult[];
  abortReason?: 'budget' | 'max_clusters' | 'max_infra_failures' | 'timeout';
  skipReasons: Array<{ reason: string; count: number }>;
};

export async function runExecute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { testCases, runState, browser, surface, maxRuntimeMs, budgetMs, concurrency, apiConcurrency, extraHeaders, toolMap, appBaseUrl } = opts;
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
    try {
      const result = tc.action.via === 'ui'
        ? await executeUiTest(tc, browser!, surface, runState.runId, paths.actionLogsDir, extraHeaders, appBaseUrl)
        : await executeApiTest(tc, surface, runState.runId, paths.actionLogsDir, toolMap);
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

async function executeUiTest(
  tc: TestCase,
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  runId: string,
  actionLogsDir: string,
  extraHeaders?: Record<string, string>,
  appBaseUrl?: string
): Promise<TestResult> {
  const start = Date.now();
  const bugs: BugDetection[] = [];
  const occurrenceId = createId();
  const headers = { 'X-BugHunter-Run': runId, ...(extraHeaders ?? {}) };

  // Construct absolute URL: tc.page may be a relative route ("/products")
  const pageUrl = tc.page.startsWith('http') ? tc.page : `${appBaseUrl ?? ''}${tc.page}`;

  // Pre-state capture
  const navResult = await browser.navigate(pageUrl, headers);
  const preConsoleErrors: ConsoleError[] = [];
  const preSnapshot = await browser.snapshot().catch(() => null);

  // Start MutationObserver
  try {
    await browser.evaluate(MUTATION_OBSERVER_START_SCRIPT);
  } catch (err) {
    log.warn('MutationObserver start failed; mutWindowMs will be 0', { err: String(err), tcId: tc.id });
  }

  // Execute action
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

  let postConsoleErrors: ConsoleError[] = [];
  let postNetworkRequests: NetworkRequest[] = [];
  let domErrorText = '';

  try {
    switch (tc.action.kind) {
      case 'click':
        if (tc.action.selector) await browser.click(tc.action.selector);
        break;
      case 'submit':
        if (tc.action.selector) await browser.click(tc.action.selector);
        break;
      case 'fill':
        if (tc.action.selector) {
          await browser.type(tc.action.selector, String(tc.action.input ?? ''));
        }
        break;
      case 'navigate':
        if (tc.action.selector) {
          const target = tc.action.selector.startsWith('http')
            ? tc.action.selector
            : `${appBaseUrl ?? ''}${tc.action.selector}`;
          await browser.navigate(target, headers);
        }
        break;
      case 'render':
        // Just capture post-state
        break;
    }
  } catch (err) {
    if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
      // Element not found is a test pre-condition failure, not an infrastructure failure
      const infra: InfrastructureFailure = {
        id: createId(),
        runId,
        timestamp: new Date().toISOString(),
        kind: 'browser_element_not_found',
        detail: err.message,
        role: tc.role,
        page: tc.page,
        action: tc.action,
      };
      return {
        testId: tc.id,
        passed: false,
        bugs: [],
        infrastructureFailure: infra,
        durationMs: Date.now() - start,
      };
    }
    if (err instanceof BrowserMcpError && (err.kind === 'transport' || err.kind === 'timeout')) {
      // Transport/timeout failures are browser_crash infra failures
      const infra: InfrastructureFailure = {
        id: createId(),
        runId,
        timestamp: new Date().toISOString(),
        kind: 'browser_crash',
        detail: err.message,
        role: tc.role,
        page: tc.page,
        action: tc.action,
      };
      return {
        testId: tc.id,
        passed: false,
        bugs: [],
        infrastructureFailure: infra,
        durationMs: Date.now() - start,
      };
    }
    throw new Error(`Browser action failed: ${String(err)}`);
  }

  // Stop MutationObserver and capture post-state
  const mutResult = await browser.evaluate(MUTATION_OBSERVER_STOP_SCRIPT).catch(() => null);
  const mutWindowMs = (mutResult?.value as { durationMs?: number })?.durationMs ?? 0;

  // Capture console errors via evaluate
  const consoleResult = await browser.evaluate(
    '(window.__bhConsoleErrors || []).map(e => ({ level: "error", text: e.text, stack: e.stack }))'
  ).catch(() => null);

  if (Array.isArray(consoleResult?.value)) {
    postConsoleErrors = consoleResult.value as ConsoleError[];
  }

  // Get post-snapshot
  const postSnapshot = await browser.snapshot().catch(() => null);
  const postNav = await browser.navigate('', {}).catch(() => ({ url: tc.page, title: '' })) as { url?: string; title?: string };

  const preState: PreState = {
    url: tc.page,
    title: navResult.title ?? '',
    consoleErrorCount: preConsoleErrors.length,
  };

  const postState: PostState = {
    url: postNav.url ?? tc.page,
    title: postNav.title ?? '',
    consoleErrors: postConsoleErrors,
    networkRequests: postNetworkRequests,
    domErrorTextDetected: !!domErrorText,
    mutationObserverWindowMs: mutWindowMs,
  };

  // Classify
  bugs.push(...classifyConsoleErrors(postConsoleErrors, tc.page));
  bugs.push(...classifyNetworkRequests(postNetworkRequests, tc.expectedOutcome, true));

  const missingChange = classifyMissingStateChange(preState, postState, tc.action, tc.page);
  if (missingChange) bugs.push(missingChange);

  if (domErrorText) {
    const domBug = classifyDomErrorText(domErrorText, tc.page, tc.action.selector ?? '');
    if (domBug) bugs.push(domBug);
  }

  // Suppress unused variable warnings — snapshots captured for future use
  void preSnapshot;
  void postSnapshot;

  // Write action log
  writeActionLog(actionLogsDir, actionLog);

  return {
    testId: tc.id,
    passed: bugs.length === 0,
    bugs,
    durationMs: Date.now() - start,
    preState,
    postState,
  };
}

async function executeApiTest(
  tc: TestCase,
  surface: SurfaceMcpAdapter,
  runId: string,
  actionLogsDir: string,
  toolMap?: Map<string, ToolMeta>
): Promise<TestResult> {
  const start = Date.now();
  const bugs: BugDetection[] = [];
  const occurrenceId = createId();

  if (!tc.action.toolId) {
    return { testId: tc.id, passed: true, bugs: [], durationMs: 0 };
  }

  const result = await surface.surface_call({
    toolId: tc.action.toolId,
    role: tc.role,
    input: tc.action.input ?? {},
    noAutoRelogin: tc.action.palette !== 'happy',
  });

  // surface_call_failed
  if (!result.ok && tc.action.palette === 'happy') {
    const status = result.status ?? 0;
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
        responseBodyShape: result.error?.message,
      });
    }
  }

  // Network classification via status
  if (result.status) {
    const req: NetworkRequest = {
      method: 'POST',
      path: tc.action.toolId,
      status: result.status,
      duration: result.durationMs,
    };
    bugs.push(...classifyNetworkRequests([req], tc.expectedOutcome, true));
  }

  // Write action log
  const toolSchema = toolMap?.get(tc.action.toolId)?.inputSchema;
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
  writeActionLog(actionLogsDir, actionLog);

  return {
    testId: tc.id,
    passed: bugs.length === 0,
    bugs,
    durationMs: Date.now() - start,
  };
}
