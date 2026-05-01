// v0.19 race-condition runner — executeRaceTest + runInterleaved.
// Wraps the browser-MCP adapter; orchestrates observation sampling.

import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type {
  TestCase, TestResult, BugDetection, InfrastructureFailure,
  RaceObservation, InterleavingVariant, RaceConditionsConfig,
  RaceConditionsTelemetry,
} from '../types.js';
import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'node:crypto';
import { log } from '../log.js';
import {
  detectDoubleSubmit,
  detectClickThenNavigate,
  detectOptimisticRevert,
  detectInterleavedMutations,
  detectCrossTab,
  type DoubleSubmitPlan,
  type ClickThenNavigatePlan,
  type OptimisticRevertPlan,
  type InterleavedMutationsPlan,
  type CrossTabPlan,
} from '../security/race-detectors.js';

export type RaceTestContext = {
  browser: BrowserMcpAdapter;
  runId: string;
  appBaseUrl: string;
  config: RaceConditionsConfig;
  reRunForFlakes?: boolean;
};

/**
 * Execute a race-condition test case. Called by execute.ts when testCase.race is set.
 * Acquires a tab from the browser adapter, logs in, runs the interleaved plan,
 * collects observations, runs the detector.
 */
export async function executeRaceTest(tc: TestCase, ctx: RaceTestContext): Promise<TestResult> {
  const start = Date.now();
  const occurrenceId = createId();

  if (tc.race === undefined) {
    throw new Error('executeRaceTest called on non-race test case');
  }

  const variant = tc.race.variant;
  const pageUrl = tc.page.startsWith('http') ? tc.page : `${ctx.appBaseUrl}${tc.page}`;
  const toolId = tc.action.toolId ?? '';

  try {
    const bugs = await ctx.browser.withTab(pageUrl, undefined, async (scope) => {
      return runInterleavedVariant(scope, tc, variant, toolId, pageUrl, ctx);
    });

    return {
      testId: tc.id,
      occurrenceId,
      passed: bugs.length === 0,
      bugs,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const infra: InfrastructureFailure = {
      id: createId(),
      runId: ctx.runId,
      timestamp: new Date().toISOString(),
      kind: 'generic',
      detail: `race-runner: ${String(err)}`,
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
      durationMs: Date.now() - start,
    };
  }
}

async function runInterleavedVariant(
  scope: TabScope,
  tc: TestCase,
  variant: InterleavingVariant,
  toolId: string,
  pageUrl: string,
  ctx: RaceTestContext,
): Promise<BugDetection[]> {
  switch (variant.kind) {
    case 'double_submit':
      return runDoubleSubmit(scope, tc, variant, toolId, pageUrl, ctx);
    case 'click_then_navigate':
      return runClickThenNavigate(scope, tc, variant, toolId, pageUrl, ctx);
    case 'optimistic_revert':
      return runOptimisticRevert(scope, tc, variant, toolId, pageUrl, ctx);
    case 'interleaved_mutations':
      return runInterleavedMutations(scope, tc, variant, toolId, pageUrl);
    case 'cross_tab':
      return runCrossTab(tc, variant, toolId, pageUrl, ctx);
  }
}

// ---- double_submit ----

async function runDoubleSubmit(
  scope: TabScope,
  tc: TestCase,
  variant: InterleavingVariant & { kind: 'double_submit' },
  toolId: string,
  pageUrl: string,
  ctx: RaceTestContext,
): Promise<BugDetection[]> {
  const raceNonce = createId();
  const selector = tc.action.selector ?? '';

  // Baseline observation before firing
  const baseObs = await captureObservation(scope, 0, selector);

  // Fire twice in the same microtask (no await between them) — real concurrency per spec.
  const toolPath = tc.action.toolId ?? pageUrl;
  await Promise.all([
    fireClick(scope, selector, 50),
    fireClick(scope, selector, variant.gapMs),
  ]);

  // Capture observations at [0, 50, 200, 1000]ms post-fire
  const obs = await captureAtOffsets(scope, selector, [0, 50, 200, 1000]);
  obs[0] = baseObs; // override index 0 with true baseline

  const plan: DoubleSubmitPlan = {
    variant,
    toolId,
    toolPath,
    raceNonce,
  };

  const detection = detectDoubleSubmit(plan, obs);
  if (detection === null) return [];

  // Flake check: if reRunForFlakes is enabled, re-run twice more; require ≥2-of-3
  if (ctx.reRunForFlakes === true && ctx.config.strict !== true) {
    return verifyWithConsensus(detection, () =>
      runDoubleSubmit(scope, tc, variant, toolId, pageUrl, { ...ctx, reRunForFlakes: false })
    );
  }

  return [detection];
}

// ---- click_then_navigate ----

async function runClickThenNavigate(
  scope: TabScope,
  tc: TestCase,
  variant: InterleavingVariant & { kind: 'click_then_navigate' },
  toolId: string,
  pageUrl: string,
  ctx: RaceTestContext,
): Promise<BugDetection[]> {
  const selector = tc.action.selector ?? '';
  const toolPath = tc.action.toolId ?? pageUrl;

  // Fire action and immediately navigate — no await between them
  await Promise.all([
    fireClick(scope, selector, 0),
    scope.navigate(variant.targetRoute).catch(() => null),
  ]);

  const obs = await captureAtOffsets(scope, selector, [0, 100, 300, 2000]);

  const plan: ClickThenNavigatePlan = {
    variant,
    toolId,
    toolPath,
    pageRoute: tc.page,
  };

  const detection = detectClickThenNavigate(plan, obs);
  if (detection === null) return [];

  if (ctx.reRunForFlakes === true && ctx.config.strict !== true) {
    return verifyWithConsensus(detection, () =>
      runClickThenNavigate(scope, tc, variant, toolId, pageUrl, { ...ctx, reRunForFlakes: false })
    );
  }

  return [detection];
}

// ---- optimistic_revert ----

async function runOptimisticRevert(
  scope: TabScope,
  tc: TestCase,
  variant: InterleavingVariant & { kind: 'optimistic_revert' },
  toolId: string,
  pageUrl: string,
  ctx: RaceTestContext,
): Promise<BugDetection[]> {
  const selector = tc.action.selector ?? '';
  const toolPath = tc.action.toolId ?? pageUrl;

  // Check if routeFulfill is supported — skip if not (EC-10)
  if (ctx.browser.routeFulfill === undefined) {
    log.info('race-runner: optimistic_revert skipped — routeFulfill not supported', { toolId });
    return [];
  }

  // Register route interception scoped to this tool's method + path (EC-9)
  // Conservative default: method + path only (body hash would require inspecting the request body
  // before it's sent, which adds complexity beyond v0.19 scope).
  const parts = toolPath.split(' ');
  const method = parts[0] ?? 'POST';
  const joined = parts.slice(1).join(' ');
  const path = joined !== '' ? joined : toolPath;
  const unregister = await ctx.browser.routeFulfill(
    { method, path },
    { status: variant.forcedStatus, body: variant.forcedBody },
  ).catch((err: unknown) => {
    log.warn('race-runner: routeFulfill failed', { err: String(err), toolId });
    return null;
  });

  if (unregister === null) return [];

  try {
    await fireClick(scope, selector, 0);
    const obs = await captureAtOffsets(scope, selector, [0, 300, 1000, 5000]);

    const plan: OptimisticRevertPlan = {
      variant,
      toolId,
      toolPath,
      pageRoute: tc.page,
    };

    const detection = detectOptimisticRevert(plan, obs);
    if (detection === null) return [];

    if (ctx.reRunForFlakes === true && ctx.config.strict !== true) {
      return verifyWithConsensus(detection, () =>
        runOptimisticRevert(scope, tc, variant, toolId, pageUrl, { ...ctx, reRunForFlakes: false })
      );
    }

    return [detection];
  } finally {
    await unregister();
  }
}

// ---- interleaved_mutations ----

async function runInterleavedMutations(
  scope: TabScope,
  tc: TestCase,
  variant: InterleavingVariant & { kind: 'interleaved_mutations' },
  toolId: string,
  _pageUrl: string,
): Promise<BugDetection[]> {
  const selectorA = tc.action.selector ?? '';
  // For interleaved_mutations, siblingActionId is the sibling tool's selector stored in the variant
  const selectorB = variant.siblingActionId;
  const toolPath = tc.action.toolId ?? tc.page;

  const allRunObs: RaceObservation[][] = [];

  for (let i = 0; i < variant.consensusRuns; i++) {
    // Fire both actions in the same microtask — real concurrency per spec
    await Promise.all([
      fireClick(scope, selectorA, 0),
      fireClick(scope, selectorB, variant.gapMs),
    ]);
    const obs = await captureAtOffsets(scope, selectorA, [0, 100, 500, 2000]);
    allRunObs.push(obs);
  }

  const plan: InterleavedMutationsPlan = {
    variant,
    toolId,
    toolPath,
    siblingToolId: variant.siblingActionId,
    pageRoute: tc.page,
  };

  const detection = detectInterleavedMutations(plan, allRunObs);
  return detection !== null ? [detection] : [];
}

// ---- cross_tab ----

async function runCrossTab(
  tc: TestCase,
  variant: InterleavingVariant & { kind: 'cross_tab' },
  toolId: string,
  pageUrl: string,
  ctx: RaceTestContext,
): Promise<BugDetection[]> {
  const selector = tc.action.selector ?? '';
  const toolPath = tc.action.toolId ?? pageUrl;
  let tab1Obs: RaceObservation[] = [];
  let tab2Obs: RaceObservation[] = [];

  await ctx.browser.withTab(pageUrl, undefined, async (scope1) => {
    await ctx.browser.withTab(pageUrl, undefined, async (scope2) => {
      // Fire in both tabs simultaneously
      const [obs1, obs2] = await Promise.all([
        (async () => {
          await fireClick(scope1, selector, 0);
          return captureAtOffsets(scope1, selector, [0, 500, 2000, 5000]);
        })(),
        (async () => {
          await fireClick(scope2, selector, 0);
          return captureAtOffsets(scope2, selector, [0, 500, 2000, 5000]);
        })(),
      ]);
      tab1Obs = obs1;
      tab2Obs = obs2;
    });
  });

  const plan: CrossTabPlan = {
    variant,
    toolId,
    toolPath,
    pageRoute: tc.page,
  };

  const detection = detectCrossTab(plan, tab1Obs, tab2Obs);
  if (detection === null) return [];

  if (ctx.reRunForFlakes === true && ctx.config.strict !== true) {
    return verifyWithConsensus(detection, () => runCrossTab(tc, variant, toolId, pageUrl, { ...ctx, reRunForFlakes: false }));
  }

  return [detection];
}

// ---- observation helpers ----

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

  // SHA1 of target selector's outerHTML, first 12 hex chars
  let targetSelectorHash = '';
  let targetSelectorState: RaceObservation['targetSelectorState'] = 'pre';

  if (targetSelector !== '') {
    const outerHtml = await scope.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(targetSelector)});return el?el.outerHTML:null;})()`
    ).then(r => typeof r.value === 'string' ? r.value : null).catch(() => null);

    if (outerHtml !== null) {
      targetSelectorHash = createHash('sha1').update(outerHtml).digest('hex').slice(0, 12);
      // Heuristic state classification based on DOM content
      targetSelectorState = classifyTargetState(outerHtml);
    }
  }

  return {
    offsetMs,
    url,
    consoleErrorCount,
    targetSelectorHash,
    toastVisible,
    targetSelectorState,
  };
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
    if (delay > 0) {
      await sleep(delay);
    }
    elapsed = offset;
    const obs = await captureObservation(scope, offset, targetSelector);
    observations.push(obs);
  }

  return observations;
}

function classifyTargetState(outerHtml: string): RaceObservation['targetSelectorState'] {
  const lower = outerHtml.toLowerCase();
  if (/error|failed|failure/.test(lower)) return 'errored';
  if (/success|saved|created|updated|done|✓|✔/.test(lower)) return 'optimistic';
  return 'pre';
}

async function fireClick(scope: TabScope, selector: string, delayMs: number): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);
  if (selector === '') return;
  await scope.click(selector).catch(err => {
    log.debug('race-runner: click failed', { selector, err: String(err) });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Consensus verification: re-run twice more, require ≥2-of-3 to confirm.
 * If only 1-of-3 confirms, marks detection as flaky.
 */
async function verifyWithConsensus(
  firstDetection: BugDetection,
  rerun: () => Promise<BugDetection[]>,
): Promise<BugDetection[]> {
  const [r2, r3] = await Promise.all([rerun(), rerun()]);
  const confirmCount = 1 + (r2.length > 0 ? 1 : 0) + (r3.length > 0 ? 1 : 0);

  if (confirmCount >= 2) return [firstDetection];

  // 1-of-3 → flaky
  if (firstDetection.raceContext !== undefined) {
    return [{ ...firstDetection, raceContext: { ...firstDetection.raceContext, flaky: true } }];
  }
  return [firstDetection];
}

const RACE_BUG_KINDS = new Set([
  'race_condition_double_submit',
  'race_condition_click_navigate',
  'race_condition_optimistic_revert',
  'race_condition_interleaved_mutations',
  'race_condition_cross_tab',
]);

/**
 * Build summary.raceConditions telemetry from the executed test set.
 * Race tests are identified by `tc.race !== undefined`. Returns undefined when
 * race-conditions are disabled so callers can omit the field entirely.
 */
export function buildRaceConditionsTelemetry(
  testCases: readonly TestCase[],
  results: readonly TestResult[],
  config: RaceConditionsConfig,
): RaceConditionsTelemetry | undefined {
  if (config.enabled !== true) return undefined;

  const raceTcs = testCases.filter(tc => tc.race !== undefined);
  const raceTcIds = new Set(raceTcs.map(tc => tc.id));
  const raceResults = results.filter(r => raceTcIds.has(r.testId));

  const variantsRunSet = new Set<InterleavingVariant['kind']>();
  for (const tc of raceTcs) {
    if (tc.race?.variant.kind !== undefined) variantsRunSet.add(tc.race.variant.kind);
  }

  const detectionsByKind: Record<string, number> = {};
  let flakyDetections = 0;
  let testsTimedOut = 0;
  let testsSucceeded = 0;
  let durationMs = 0;
  const skipReasonsMap = new Map<string, number>();

  for (const r of raceResults) {
    durationMs += r.durationMs;
    if (r.infrastructureFailure !== undefined) {
      const detail = r.infrastructureFailure.detail ?? '';
      if (/timeout/i.test(detail)) testsTimedOut++;
      const reason = r.infrastructureFailure.kind ?? 'infrastructure_failure';
      skipReasonsMap.set(reason, (skipReasonsMap.get(reason) ?? 0) + 1);
      continue;
    }
    if (r.bugs.length === 0) testsSucceeded++;
    for (const bug of r.bugs) {
      if (!RACE_BUG_KINDS.has(bug.kind)) continue;
      detectionsByKind[bug.kind] = (detectionsByKind[bug.kind] ?? 0) + 1;
      if (bug.raceContext?.flaky === true) flakyDetections++;
    }
  }

  return {
    enabled: true,
    variantsRun: Array.from(variantsRunSet),
    testsAttempted: raceTcs.length,
    testsSucceeded,
    testsTimedOut,
    testsSkipped: Array.from(skipReasonsMap.entries()).map(([reason, count]) => ({ reason, count })),
    detectionsByKind,
    flakyDetections,
    durationMs,
  };
}
