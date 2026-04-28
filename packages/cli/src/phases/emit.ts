// Phase 6: emit — write JSONL + summary (§ 3.7).

import type { BugCluster, InfrastructureFailure, RunState, RunSummary, SeedHookExecution } from '../types.js';
import { runPaths, appendJsonl, writeJsonFile } from '../store/filesystem.js';
import { log } from '../log.js';

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
  };
  /** v0.6 performance summary — present when perf subsystem was enabled. */
  perfSummary?: RunSummary['perfSummary'];
  /** v0.6 bundle summary — present when bundle-probe was enabled. */
  bundleSummary?: RunSummary['bundleSummary'];
  /** v0.14 seed-hook executions — one per hook, in run order. */
  seedHookExecutions?: SeedHookExecution[];
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
  };

  writeJsonFile(paths.summaryFile, summary);

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
