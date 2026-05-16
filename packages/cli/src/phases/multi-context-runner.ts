// v0.40 multi-context runner — executeMultiContextTest + fire-gate + lifecycle dispatch.
// Separate from race-runner.ts (different lifecycle, cost model, and timeout shape).

import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type {
  TestCase, TestResult, BugDetection, InfrastructureFailure,
  RaceObservation, MultiContextConfig, MultiContextTelemetry, MultiContextVariant,
  SnapshotCapture,
} from '../types.js';
import { createId } from '../lib/ids.js';
import { nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';
import { perfMs } from '../lib/perf.js';
import { createHash } from 'node:crypto';
import { log } from '../log.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { loginInTabScope } from '../discovery/browser-login.js';
import type { BrowserLoginPlan } from '../discovery/browser-login.js';
import {
  detectMultiContextStateDivergence,
  detectVisibilityChangeStateLoss,
  detectMultiUserInconsistentSnapshot,
} from '../security/multi-context-detectors.js';
import type {
  StateDivergencePlan,
  LifecycleStateLossPlan,
  InconsistentSnapshotPlan,
} from '../security/multi-context-detectors.js';

export type MultiContextTestContext = {
  browser: BrowserMcpAdapter;
  surface: SurfaceMcpAdapter;
  runId: string;
  appBaseUrl: string;
  config: MultiContextConfig;
  clock?: Clock;
};

// ---- fire-gate pattern ----

type FireGate = { gate: Promise<void>; release: () => void };

function makeFireGate(): FireGate {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { gate, release };
}

// ---- lifecycle dispatch ----

type LifecycleEventKind = 'visibilitychange' | 'pageshow' | 'pagehide' | 'freeze' | 'resume';

async function dispatchLifecycle(scope: TabScope, kind: LifecycleEventKind): Promise<void> {
  switch (kind) {
    case 'visibilitychange':
      await scope.evaluate(
        `(function(){Object.defineProperty(document,'visibilityState',{get:()=>'hidden',configurable:true});Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));})()`
      );
      return;
    case 'pagehide':
      await scope.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
      return;
    case 'pageshow':
      await scope.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
      return;
    case 'freeze':
      await scope.evaluate(`document.dispatchEvent(new Event('freeze',{bubbles:true}))`);
      return;
    case 'resume':
      await scope.evaluate(
        `(function(){Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});document.dispatchEvent(new Event('resume',{bubbles:true}));document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));})()`
      );
      return;
  }
}

// ---- observation helpers (mirrors race-runner.ts) ----

async function captureObservation(
  scope: TabScope,
  offsetMs: number,
  targetSelector: string,
): Promise<RaceObservation> {
  const url = await scope.evaluate('window.location.href').then(r => String(r.value ?? '')).catch(() => '');
  const consoleErrorCount = await scope.evaluate('(window.__bh_console_errors||[]).length').then(r => Number(r.value ?? 0)).catch(() => 0);
  const toastVisible = await scope.evaluate(
    '!!document.querySelector("[role=\'alert\'], .toast, .notification, [class*=\'toast\'], [class*=\'notification\']")'
  ).then(r => r.value === true).catch(() => false);

  let targetSelectorHash = '';
  let targetSelectorState: RaceObservation['targetSelectorState'] = 'pre';

  if (targetSelector !== '') {
    const outerHtml = await scope.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(targetSelector)});return el?el.outerHTML:null;})()`
    ).then(r => typeof r.value === 'string' ? r.value : null).catch(() => null);

    if (outerHtml !== null) {
      targetSelectorHash = createHash('sha1').update(outerHtml).digest('hex').slice(0, 12);
      const lower = outerHtml.toLowerCase();
      if (/error|failed|failure/.test(lower)) targetSelectorState = 'errored';
      else if (/success|saved|created|updated|done|✓|✔/.test(lower)) targetSelectorState = 'optimistic';
    }
  }

  return { offsetMs, url, consoleErrorCount, targetSelectorHash, toastVisible, targetSelectorState };
}

async function captureAtOffsets(
  scope: TabScope,
  targetSelector: string,
  offsets: number[],
): Promise<RaceObservation[]> {
  const observations: RaceObservation[] = [];
  let elapsed = 0;
  for (const offset of offsets) {
    const delay = offset - elapsed;
    if (delay > 0) await sleep(delay);
    elapsed = offset;
    observations.push(await captureObservation(scope, offset, targetSelector));
  }
  return observations;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

// ---- per-tab fire helper ----

async function fireOnGate(
  scope: TabScope,
  gate: Promise<void>,
  selector: string,
  offsets: number[],
): Promise<RaceObservation[]> {
  await gate;
  if (selector !== '') {
    await scope.click(selector).catch(err => {
      log.debug('multi-context-runner: click failed', { selector, err: String(err) });
    });
  }
  return captureAtOffsets(scope, selector, offsets);
}

// ---- main executor ----

export async function executeMultiContextTest(
  tc: TestCase,
  ctx: MultiContextTestContext,
): Promise<TestResult> {
  const start = perfMs();
  const occurrenceId = createId();
  const clock = ctx.clock ?? { kind: 'wall' as const };

  if (tc.multiContext === undefined) {
    throw new Error('executeMultiContextTest called on non-multi-context test case');
  }

  const variant = tc.multiContext.variant;
  const pageUrl = tc.page.startsWith('http') ? tc.page : `${ctx.appBaseUrl}${tc.page}`;
  const selector = tc.action.selector ?? '';
  const toolId = tc.action.toolId ?? '';

  const perTestTimeoutMs = ctx.config.perTestTimeoutMs ?? 120_000;

  try {
    const bugs = await Promise.race([
      runMultiContextVariant(tc, variant, selector, toolId, pageUrl, ctx),
      sleep(perTestTimeoutMs).then((): BugDetection[] => {
        log.warn('multi-context-runner: per-test timeout', { testId: tc.id, timeoutMs: perTestTimeoutMs });
        return [];
      }),
    ]);

    return {
      testId: tc.id,
      occurrenceId,
      passed: bugs.length === 0,
      bugs,
      durationMs: perfMs() - start,
    };
  } catch (err) {
    const infra: InfrastructureFailure = {
      id: createId(),
      runId: ctx.runId,
      timestamp: nowIso(clock),
      kind: 'generic',
      detail: `multi-context-runner: ${String(err)}`,
      role: tc.role,
      page: tc.page,
      action: tc.action,
    };
    return {
      testId: tc.id,
      occurrenceId,
      passed: false,
      bugs: [],
      infrastructureFailure: infra,
      durationMs: perfMs() - start,
    };
  }
}

async function runMultiContextVariant(
  tc: TestCase,
  variant: MultiContextVariant,
  selector: string,
  toolId: string,
  pageUrl: string,
  ctx: MultiContextTestContext,
): Promise<BugDetection[]> {
  switch (variant.kind) {
    case 'state_divergence':
      return runStateDivergence(tc, variant, selector, toolId, pageUrl, ctx);
    case 'lifecycle_state_loss':
      return runLifecycleStateLoss(tc, variant, selector, toolId, pageUrl, ctx);
    case 'inconsistent_snapshot':
      return runInconsistentSnapshot(tc, variant, selector, toolId, pageUrl, ctx);
  }
}

// ---- state_divergence ----

async function runStateDivergence(
  tc: TestCase,
  variant: MultiContextVariant & { kind: 'state_divergence' },
  selector: string,
  toolId: string,
  pageUrl: string,
  ctx: MultiContextTestContext,
): Promise<BugDetection[]> {
  const n = variant.n;
  const offsets = [0, 100, 500, 2000, variant.settleMs];
  let observationsByContext: RaceObservation[][] = [];

  const loginPlan = await resolveLoginPlan(ctx.surface, tc.role);

  await openNTabs(ctx.browser, pageUrl, n, async (scopes) => {
    await loginAllScopes(scopes, tc.role, loginPlan);
    await Promise.all(scopes.map(scope => scope.navigate(pageUrl)));

    const { gate, release } = makeFireGate();
    const tasks = scopes.map(scope => fireOnGate(scope, gate, selector, offsets));
    release();
    observationsByContext = await Promise.all(tasks);
  });

  const plan: StateDivergencePlan = {
    variant,
    toolId,
    toolPath: tc.action.toolId ?? pageUrl,
    pageRoute: tc.page,
    nonCommutativeFields: variant.nonCommutativeFields,
  };

  const detection = detectMultiContextStateDivergence(plan, observationsByContext);
  if (detection === null) return [];

  const consensusRuns = ctx.config.consensusRunsByVariant?.['state_divergence'] ?? 5;
  const consensusVotes = ctx.config.consensusVotesRequiredByVariant?.['state_divergence'] ?? 3;

  return runConsensus(detection, consensusRuns, consensusVotes, () =>
    runStateDivergence(tc, variant, selector, toolId, pageUrl, ctx)
  );
}

// ---- lifecycle_state_loss ----

async function runLifecycleStateLoss(
  tc: TestCase,
  variant: MultiContextVariant & { kind: 'lifecycle_state_loss' },
  selector: string,
  toolId: string,
  pageUrl: string,
  ctx: MultiContextTestContext,
): Promise<BugDetection[]> {
  const lifecycleAt = variant.midActionDelayMs;
  let observations: RaceObservation[] = [];

  const loginPlan = await resolveLoginPlan(ctx.surface, tc.role);

  await ctx.browser.withTab(pageUrl, undefined, async (scope) => {
    if (loginPlan !== null) {
      await loginInTabScope(scope, tc.role, loginPlan, { verifyTimeoutMs: 10_000, verifyPollMs: 500 });
    }
    await scope.navigate(pageUrl);

    const baseline = await captureObservation(scope, 0, selector);

    if (selector !== '') {
      await scope.click(selector).catch(err => {
        log.debug('multi-context-runner: lifecycle click failed', { selector, err: String(err) });
      });
    }

    const optimistic = await captureObservation(scope, 100, selector);

    await sleep(lifecycleAt);
    await dispatchLifecycle(scope, variant.lifecycleEvent);

    const postLifecyclePlus200 = await captureObservation(scope, lifecycleAt + 200, selector);
    await sleep(variant.settleMs);
    const finalObs = await captureObservation(scope, lifecycleAt + variant.settleMs, selector);

    observations = [baseline, optimistic, postLifecyclePlus200, finalObs];
  });

  const plan: LifecycleStateLossPlan = {
    variant,
    toolId,
    toolPath: tc.action.toolId ?? pageUrl,
    pageRoute: tc.page,
  };

  const detection = detectVisibilityChangeStateLoss(plan, observations);
  if (detection === null) return [];

  const consensusRuns = ctx.config.consensusRunsByVariant?.['lifecycle_state_loss'] ?? 3;
  const consensusVotes = ctx.config.consensusVotesRequiredByVariant?.['lifecycle_state_loss'] ?? 2;

  return runConsensus(detection, consensusRuns, consensusVotes, () =>
    runLifecycleStateLoss(tc, variant, selector, toolId, pageUrl, ctx)
  );
}

// ---- inconsistent_snapshot ----

async function runInconsistentSnapshot(
  tc: TestCase,
  variant: MultiContextVariant & { kind: 'inconsistent_snapshot' },
  selector: string,
  toolId: string,
  pageUrl: string,
  ctx: MultiContextTestContext,
): Promise<BugDetection[]> {
  const writerSettleMs = variant.writerSettleMs;
  const midOffsetMs = writerSettleMs / 2;

  const loginPlan = await resolveLoginPlan(ctx.surface, tc.role);
  let writerObservations: RaceObservation[] = [];
  let readerCaptures!: { pre: SnapshotCapture; mid: SnapshotCapture; post: SnapshotCapture };

  await ctx.browser.withTab(pageUrl, undefined, async (writerScope) => {
    await ctx.browser.withTab(pageUrl, undefined, async (readerScope) => {
      if (loginPlan !== null) {
        await Promise.all([
          loginInTabScope(writerScope, tc.role, loginPlan, { verifyTimeoutMs: 10_000, verifyPollMs: 500 }),
          loginInTabScope(readerScope, tc.role, loginPlan, { verifyTimeoutMs: 10_000, verifyPollMs: 500 }),
        ]);
      }
      await Promise.all([
        writerScope.navigate(pageUrl),
        readerScope.navigate(`${ctx.appBaseUrl}${variant.readerEndpoint}`),
      ]);

      const pre = await fetchCapture(readerScope, variant.readerEndpoint, ctx.appBaseUrl, 0);

      const writerStart = perfMs();
      const [writerObs, midCapture, postCapture] = await Promise.all([
        (async () => {
          if (selector !== '') {
            await writerScope.click(selector).catch(err => {
              log.debug('multi-context-runner: writer click failed', { selector, err: String(err) });
            });
          }
          return captureAtOffsets(writerScope, selector, [0, 100, 500, writerSettleMs]);
        })(),
        sleep(midOffsetMs).then(() => fetchCapture(readerScope, variant.readerEndpoint, ctx.appBaseUrl, perfMs() - writerStart)),
        sleep(writerSettleMs).then(() => fetchCapture(readerScope, variant.readerEndpoint, ctx.appBaseUrl, perfMs() - writerStart)),
      ]);

      writerObservations = writerObs;
      readerCaptures = { pre, mid: midCapture, post: postCapture };
    });
  });

  const plan: InconsistentSnapshotPlan = {
    variant,
    writerToolId: toolId,
    toolPath: tc.action.toolId ?? pageUrl,
    pageRoute: tc.page,
  };

  const detection = detectMultiUserInconsistentSnapshot(plan, writerObservations, readerCaptures);
  if (detection === null) return [];

  const consensusRuns = ctx.config.consensusRunsByVariant?.['inconsistent_snapshot'] ?? 3;
  const consensusVotes = ctx.config.consensusVotesRequiredByVariant?.['inconsistent_snapshot'] ?? 2;

  return runConsensus(detection, consensusRuns, consensusVotes, () =>
    runInconsistentSnapshot(tc, variant, selector, toolId, pageUrl, ctx)
  );
}

// ---- helpers ----

async function resolveLoginPlan(
  surface: SurfaceMcpAdapter,
  role: string,
): Promise<BrowserLoginPlan | null> {
  try {
    const plan = await surface.surface_describe_auth({ role });
    if (plan.authKind !== 'form' && plan.authKind !== 'nextauth') return null;
    return plan as BrowserLoginPlan;
  } catch {
    return null;
  }
}

async function loginAllScopes(
  scopes: TabScope[],
  role: string,
  loginPlan: BrowserLoginPlan | null,
): Promise<void> {
  if (loginPlan === null) return;
  await Promise.all(
    scopes.map(scope => loginInTabScope(scope, role, loginPlan, { verifyTimeoutMs: 10_000, verifyPollMs: 500 }))
  );
}

/**
 * Open N tabs via recursive withTab nesting so all scopes remain open concurrently
 * during fn. Closes all tabs in finally (withTab handles this).
 */
async function openNTabs(
  browser: BrowserMcpAdapter,
  initialUrl: string,
  n: number,
  fn: (scopes: TabScope[]) => Promise<void>,
): Promise<void> {
  const scopes: TabScope[] = [];

  async function open(remaining: number): Promise<void> {
    if (remaining === 0) {
      await fn(scopes);
      return;
    }
    await browser.withTab(initialUrl, undefined, async (scope) => {
      scopes.push(scope);
      await open(remaining - 1);
      scopes.pop();
    });
  }

  await open(n);
}

async function fetchCapture(
  scope: TabScope,
  endpoint: string,
  appBaseUrl: string,
  offsetMs: number,
): Promise<SnapshotCapture> {
  const fullUrl = `${appBaseUrl}${endpoint}`;
  try {
    const result = await scope.evaluate(
      `(async function(){` +
      `var r=await fetch(${JSON.stringify(fullUrl)},{credentials:'include'});` +
      `var body=null;try{body=await r.json();}catch(e){}` +
      `return{status:r.status,body:body,etag:r.headers.get('etag'),lastModified:r.headers.get('last-modified'),xSnapshotVersion:r.headers.get('x-snapshot-version')};` +
      `})()`
    );
    const val = result.value as { status?: number; body?: unknown; etag?: string | null; lastModified?: string | null; xSnapshotVersion?: string | null } | null;
    return {
      offsetMs,
      responseStatus: val?.status ?? 0,
      responseBody: val?.body ?? null,
      headers: {
        etag: val?.etag ?? undefined,
        lastModified: val?.lastModified ?? undefined,
        xSnapshotVersion: val?.xSnapshotVersion ?? undefined,
      },
    };
  } catch {
    return { offsetMs, responseStatus: 0, responseBody: null, headers: {} };
  }
}

async function runConsensus(
  firstDetection: BugDetection,
  totalRuns: number,
  requiredVotes: number,
  rerun: () => Promise<BugDetection[]>,
): Promise<BugDetection[]> {
  if (totalRuns <= 1) return [firstDetection];

  let votes = 1;
  for (let i = 1; i < totalRuns; i++) {
    const r = await rerun();
    if (r.length > 0) votes++;
  }

  if (votes >= requiredVotes) return [firstDetection];

  // Didn't reach required votes — mark flaky
  if (firstDetection.multiContextContext !== undefined) {
    return [{ ...firstDetection, multiContextContext: { ...firstDetection.multiContextContext, flaky: true } }];
  }
  return [firstDetection];
}

// ---- telemetry builder ----

const MULTI_CONTEXT_BUG_KINDS = new Set([
  'multi_context_state_divergence',
  'visibility_change_state_loss',
  'multi_user_inconsistent_snapshot',
]);

export function buildMultiContextTelemetry(
  testCases: readonly TestCase[],
  results: readonly TestResult[],
  config: MultiContextConfig,
): MultiContextTelemetry | undefined {
  if (config.enabled !== true) return undefined;

  const mcTcs = testCases.filter(tc => tc.multiContext !== undefined);
  const mcTcIds = new Set(mcTcs.map(tc => tc.id));
  const mcResults = results.filter(r => mcTcIds.has(r.testId));

  const variantsRunSet = new Set<MultiContextVariant['kind']>();
  for (const tc of mcTcs) {
    if (tc.multiContext?.variant.kind !== undefined) variantsRunSet.add(tc.multiContext.variant.kind);
  }

  const detectionsByKind: Record<string, number> = {};
  let flakyDetections = 0;
  let testsTimedOut = 0;
  let testsSucceeded = 0;
  let durationMs = 0;
  const skipReasonsMap = new Map<string, number>();

  for (const r of mcResults) {
    durationMs += r.durationMs;
    if (r.infrastructureFailure !== undefined) {
      if (/timeout/i.test(r.infrastructureFailure.detail)) testsTimedOut++;
      const reason = r.infrastructureFailure.kind;
      skipReasonsMap.set(reason, (skipReasonsMap.get(reason) ?? 0) + 1);
      continue;
    }
    if (r.bugs.length === 0) testsSucceeded++;
    for (const bug of r.bugs) {
      if (!MULTI_CONTEXT_BUG_KINDS.has(bug.kind)) continue;
      detectionsByKind[bug.kind] = (detectionsByKind[bug.kind] ?? 0) + 1;
      if (bug.multiContextContext?.flaky === true) flakyDetections++;
    }
  }

  return {
    enabled: true,
    n: config.n ?? 3,
    variantsRun: Array.from(variantsRunSet),
    testsPlanned: mcTcs.length,
    testsSucceeded,
    testsTimedOut,
    testsSkipped: Array.from(skipReasonsMap.entries()).map(([reason, count]) => ({ reason, count })),
    detectionsByKind,
    flakyDetections,
    durationMs,
  };
}
