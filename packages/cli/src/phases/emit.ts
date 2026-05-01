// Phase 6: emit — write JSONL + summary (§ 3.7).

import type { BugCluster, CrossRunSummary, InfrastructureFailure, RunState, RunSummary, SeedHookExecution, VisionConsistencyTelemetry, PenTestingTelemetry } from '../types.js';
import { runPaths, appendJsonl, writeJsonFile } from '../store/filesystem.js';
import { openHistoryDb, previousRunForProject, clustersForRun, writeRunToHistory } from '../store/history.js';
import { log } from '../log.js';

const BUGHUNTER_VERSION = '0.1.0';

export type TestCounters = {
  testsPlanned: number;
  testsRan: number;
  testsSkipped: number;
  skipReasons: Array<{ reason: string; count: number }>;
  vision?: {
    enabled: boolean;
    called: number;
    succeeded: number;
    anomaliesFound: number;
    abortReason?: 'auth' | 'transport' | 'cost_cap';
    costUsd?: number;
    costCapUsd?: number;
    consistency?: VisionConsistencyTelemetry;
    /** v0.17: per-viewport telemetry. */
    byViewport?: Record<number, { uniqueScreenshots: number; anomaliesFound: number; deduped: number }>;
  };
  /** v0.6 performance summary — present when perf subsystem was enabled. */
  perfSummary?: RunSummary['perfSummary'];
  /** v0.6 bundle summary — present when bundle-probe was enabled. */
  bundleSummary?: RunSummary['bundleSummary'];
  /** v0.14 seed-hook executions — one per hook, in run order. */
  seedHookExecutions?: SeedHookExecution[];
  /** v0.8 heap attribution summary — present when analyze phase ran. */
  heapAttributionSummary?: RunSummary['heapAttributionSummary'];
  /** v0.16 pen-testing telemetry — present when penTesting.enabled = true. */
  penTesting?: PenTestingTelemetry;
};

export function runEmit(
  clusters: BugCluster[],
  infraFailures: InfrastructureFailure[],
  runState: RunState,
  projectedRuntimeMs: number,
  actualRuntimeMs: number,
  counters?: TestCounters
): void {
  const paths = runPaths(runState.projectDir, runState.runId);

  for (const cluster of clusters) {
    appendJsonl(paths.bugsFile, cluster);
  }

  for (const failure of infraFailures) {
    appendJsonl(paths.infraFile, failure);
  }

  const byKind: Record<string, number> = {};
  const byRole: Record<string, number> = {};

  for (const cluster of clusters) {
    byKind[cluster.kind] = (byKind[cluster.kind] ?? 0) + 1;
    for (const occ of cluster.occurrences) {
      byRole[occ.role] = (byRole[occ.role] ?? 0) + 1;
    }
  }

  const testsPlanned = counters?.testsPlanned ?? 0;
  const testsRan = counters?.testsRan ?? 0;
  const testsSkipped = counters?.testsSkipped ?? 0;
  const skipReasons = counters?.skipReasons ?? [];

  const crawlTelemetry = runState.discovery?.crawlTelemetry;
  const probeTelemetry = runState.discovery?.probe?.telemetry;
  const summary = {
    runId: runState.runId,
    bugs_filed: clusters.length,
    bugs_attempted_fix: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
    byKind,
    byRole,
    projectedRuntimeMs,
    actualRuntimeMs,
    testsPlanned,
    testsRan,
    testsSkipped,
    skippedReasons: skipReasons,
    ...(counters?.vision !== undefined ? { vision: counters.vision } : {}),
    ...(crawlTelemetry !== undefined ? { discovery: { ...crawlTelemetry, ...(probeTelemetry !== undefined ? { probe: { telemetry: probeTelemetry } } : {}) } } : {}),
    ...(probeTelemetry !== undefined && crawlTelemetry === undefined ? { discovery: { probe: { telemetry: probeTelemetry } } } : {}),
    ...(counters?.perfSummary !== undefined ? { perfSummary: counters.perfSummary } : {}),
    ...(counters?.bundleSummary !== undefined ? { bundleSummary: counters.bundleSummary } : {}),
    ...(probeTelemetry !== undefined ? { formReachabilityProbes: buildProbeCounters(runState) } : {}),
    ...(counters?.seedHookExecutions !== undefined && counters.seedHookExecutions.length > 0
      ? { seedHookExecutions: counters.seedHookExecutions }
      : {}),
    ...(counters?.heapAttributionSummary !== undefined ? { heapAttributionSummary: counters.heapAttributionSummary } : {}),
    ...(counters?.penTesting !== undefined ? { penTesting: counters.penTesting } : {}),
  };

  let crossRun: CrossRunSummary | undefined;
  const db = openHistoryDb(runState.projectDir);
  try {
    const prev = previousRunForProject(db, runState.config.projectName, runState.runId);
    if (prev !== undefined) {
      const prevClusters = clustersForRun(db, prev.run_id);
      const prevByIdentity = new Map(prevClusters.map(c => [c.bug_identity, c]));
      const currIdentities = new Set(
        clusters.filter(c => c.bugIdentity !== undefined).map(c => c.bugIdentity as string),
      );
      let newBugs = 0;
      let persistent = 0;
      let regressed = 0;
      for (const c of clusters) {
        if (c.bugIdentity === undefined) continue;
        const prior = prevByIdentity.get(c.bugIdentity);
        if (prior === undefined) newBugs++;
        else if (prior.verdict === 'verified_fixed') regressed++;
        else persistent++;
      }
      let goneSinceLast = 0;
      for (const pc of prevClusters) {
        if (!currIdentities.has(pc.bug_identity)) goneSinceLast++;
      }
      crossRun = { previousRunId: prev.run_id, newBugs, persistent, goneSinceLast, regressed };
      log.info('crossRun computed', crossRun);
    } else {
      log.info('discovery.first-run-for-project: no prior run found; crossRun omitted from summary');
    }
    writeRunToHistory(db, runState, clusters, BUGHUNTER_VERSION);
  } catch (err) {
    log.warn('history.db write failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    db.close();
  }

  writeJsonFile(paths.summaryFile, { ...summary, ...(crossRun !== undefined ? { crossRun } : {}) });

  const skipLines = skipReasons.map(r => `Skipped: ${r.reason} (${r.count})`);

  const perfLines = buildPerfSummaryLines(counters?.perfSummary);
  const bundleLines = buildBundleSummaryLines(counters?.bundleSummary);

  const lines = [
    `\n=== BugHunter Run ${runState.runId} ===`,
    `Total clusters: ${clusters.length}`,
    `Infrastructure failures: ${infraFailures.length}`,
    `Actual runtime: ${Math.round(actualRuntimeMs / 1000)}s`,
    `Tests: ${testsPlanned} planned, ${testsRan} ran, ${testsSkipped} skipped`,
    ...skipLines,
    '',
    'By kind:',
    ...Object.entries(byKind).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'By role:',
    ...Object.entries(byRole).map(([r, v]) => `  ${r}: ${v}`),
    ...perfLines,
    ...bundleLines,
    '',
    `Bugs: ${paths.bugsFile}`,
    `Summary: ${paths.summaryFile}`,
  ];

  process.stdout.write(`${lines.join('\n')  }\n`);
  log.info('Emitted', { clusters: clusters.length, infraFailures: infraFailures.length });
}

function buildPerfSummaryLines(perf: RunSummary['perfSummary']): string[] {
  if (perf === undefined) return [];
  const lines = ['', 'Performance summary:'];
  if (perf.longestTaskMs > 0) lines.push(`  Longest task: ${perf.longestTaskMs}ms`);
  if (perf.totalNetworkRequests > 0) lines.push(`  Network requests: ${perf.totalNetworkRequests}`);
  if (perf.heapGrowthBytesPerSec !== undefined) {
    lines.push(`  Heap growth: ${Math.round(perf.heapGrowthBytesPerSec / 1024)}KB/s`);
  }
  if (perf.worstNPlusOne !== undefined) {
    lines.push(`  Worst N+1: ${perf.worstNPlusOne.endpoint} (${perf.worstNPlusOne.count}x)`);
  }
  const pageCount = Object.keys(perf.vitalsByPage).length;
  if (pageCount > 0) lines.push(`  Web vitals measured on ${pageCount} page(s)`);
  return lines;
}

function buildProbeCounters(runState: RunState): { run: number; skippedByBudget: number; durationMs: number } {
  const t = runState.discovery?.probe?.telemetry;
  return { run: t?.probesRun ?? 0, skippedByBudget: t?.skippedByBudget ?? 0, durationMs: t?.durationMs ?? 0 };
}

function buildBundleSummaryLines(bundle: RunSummary['bundleSummary']): string[] {
  if (bundle === undefined) return [];
  const jskb = Math.round(bundle.initialJsBytesGzipped / 1024);
  const csskb = Math.round(bundle.initialCssBytesGzipped / 1024);
  const exceeded = bundle.budgetExceeded ? ' ⚠ budget exceeded' : '';
  return [
    '',
    'Bundle summary:',
    `  Initial JS: ${jskb}KB gzipped`,
    `  Initial CSS: ${csskb}KB gzipped${exceeded}`,
  ];
}
