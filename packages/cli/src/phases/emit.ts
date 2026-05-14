// Phase 6: emit — write JSONL + summary (§ 3.7).

import * as fs from 'node:fs';
import type { BugCluster, CrossRunSummary, InfrastructureFailure, RunState, RunSummary, SeedHookExecution, VisionConsistencyTelemetry, PenTestingTelemetry, RaceConditionsTelemetry, IdorTelemetry, BrowserPlatformTelemetry, Severity, ClockTestingTelemetry, NetworkFaultsTelemetry, MultiContextTelemetry, DataIntegritySummary, InvariantEvaluation, MobileSummary } from '../types.js';
import { runPaths, appendJsonl, writeJsonFile } from '../store/filesystem.js';
import { buildCoverage } from './coverage.js';
import { canonicalStringify } from '../lib/canonical.js';
import { openHistoryDb, previousRunForProject, clustersForRun, writeRunToHistory } from '../store/history.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import { log } from '../log.js';
import { fireNotifications } from '../notify/send.js';
import { nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';

const BUGHUNTER_VERSION = '0.1.0';
// v0.29: per-kind severity lookup from DETECTOR_REGISTRY defaultSeverity (#147).
const registryLookup: Partial<Record<string, { defaultSeverity?: Severity }>> = Object.fromEntries(
  DETECTOR_REGISTRY.map(e => [e.kind, e]),
);

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
  /** v0.19 race-condition telemetry — present when raceConditions.enabled = true. */
  raceConditions?: RaceConditionsTelemetry;
  /** v0.40 multi-context telemetry — present when multiContext.enabled = true. */
  multiContext?: MultiContextTelemetry;
  /** v0.21 IDOR telemetry — present when idor.enabled = true. */
  idor?: IdorTelemetry;
  /** v0.36: browser-platform probe telemetry — present when browserPlatform.enabled = true. */
  browserPlatform?: BrowserPlatformTelemetry;
  /** #176: per-surface budget allocation telemetry — present on multi-surface runs (≥2 ready surfaces). */
  perSurface?: RunSummary['perSurface'];
  /** v0.20: network-fault telemetry — present when networkFaults.enabled = true. */
  networkFaults?: NetworkFaultsTelemetry;
  /** v0.28: number of clusters suppressed by .bughunter/suppressions.json. */
  suppressedClusters?: number;
  /** v0.28: suppressed sample details (up to 20). */
  suppressedSamples?: RunSummary['suppressedSamples'];
  /** v0.23: clock-testing telemetry — present when clockTesting.enabled = true. */
  clockTesting?: ClockTestingTelemetry;
  /** v0.32: determinism telemetry — present when any determinism flag is set. */
  deterministic?: {
    seed?: number;
    frozenClockIso?: string;
    frozenNetworkPath?: string;
    networkReplay?: { matched: number; missed: number; unmatchedRecorded: number };
  };
  /** v0.42: data-integrity invariant evaluations from the execute phase. */
  dataIntegrityEvaluations?: InvariantEvaluation[];
  /** v0.42: data-integrity config status. */
  dataIntegrityEnabled?: boolean;
  /** v0.42: number of configured invariants. */
  dataIntegrityInvariantsConfigured?: number;
  /** v0.41: mobile / responsive test telemetry — present when --mobile flag is set. */
  mobile?: MobileSummary;
};

export function runEmit(
  clusters: BugCluster[],
  infraFailures: InfrastructureFailure[],
  runState: RunState,
  projectedRuntimeMs: number,
  actualRuntimeMs: number,
  counters?: TestCounters,
  clock: Clock = { kind: 'wall' }
): void {
  const paths = runPaths(runState.projectDir, runState.runId);

  const byKind: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };

  // Set severity on every cluster from registry default, then sort by
  // (severity desc, confidence desc, signatureKey asc) so bugs.jsonl leads
  // with the most important findings. signatureKey tiebreaker preserves V32
  // deterministic byte-identity within ties.
  for (const cluster of clusters) {
    const sev: Severity = cluster.severity ?? registryLookup[cluster.kind]?.defaultSeverity ?? 'info';
    (cluster as BugCluster & { severity: Severity }).severity = sev;
  }
  const sevRank = (s: Severity | undefined): number =>
    s === 'critical' ? 3 : s === 'major' ? 2 : s === 'minor' ? 1 : 0;
  const confRank = (c: BugCluster['confidence']): number =>
    c === 'high' ? 2 : c === 'medium' ? 1 : 0;
  const sortedClusters = [...clusters].sort((a, b) => {
    const ds = sevRank(b.severity) - sevRank(a.severity);
    if (ds !== 0) return ds;
    const dc = confRank(b.confidence) - confRank(a.confidence);
    if (dc !== 0) return dc;
    return (a.signatureKey ?? '').localeCompare(b.signatureKey ?? '');
  });

  for (const cluster of sortedClusters) {
    bySeverity[cluster.severity ?? 'info'] += 1;
    byKind[cluster.kind] = (byKind[cluster.kind] ?? 0) + 1;
    for (const occ of cluster.occurrences) {
      byRole[occ.role] = (byRole[occ.role] ?? 0) + 1;
    }
    // v0.32: use canonical (sorted-keys) serialisation for deterministic bugs.jsonl.
    fs.appendFileSync(paths.bugsFile, `${canonicalStringify(cluster)}\n`);
  }

  for (const failure of infraFailures) {
    appendJsonl(paths.infraFile, failure);
  }

  const testsPlanned = counters?.testsPlanned ?? 0;
  const testsRan = counters?.testsRan ?? 0;
  const testsSkipped = counters?.testsSkipped ?? 0;
  const skipReasons = counters?.skipReasons ?? [];

  const crawlTelemetry = runState.discovery?.crawlTelemetry;
  const probeTelemetry = runState.discovery?.probe?.telemetry;
  const summary = {
    runId: runState.runId,
    viewerVersion: BUGHUNTER_VERSION,
    bugs_filed: clusters.length,
    bugs_specced: 0,
    bugs_attempted_fix: 0,
    bugs_architect_refused: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
    byKind,
    byRole,
    bySeverity,
    projectedRuntimeMs,
    actualRuntimeMs,
    testsPlanned,
    testsRan,
    testsSkipped,
    skippedReasons: skipReasons,
    suppressedClusters: counters?.suppressedClusters ?? 0,
    ...(counters?.suppressedSamples !== undefined && counters.suppressedSamples.length > 0
      ? { suppressedSamples: counters.suppressedSamples }
      : {}),
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
    ...(counters?.raceConditions !== undefined ? { raceConditions: counters.raceConditions } : {}),
    ...(counters?.multiContext !== undefined ? { multiContext: counters.multiContext } : {}),
    ...(counters?.idor !== undefined ? { idor: counters.idor } : {}),
    ...(counters?.clockTesting !== undefined ? { clockTesting: counters.clockTesting } : {}),
    ...(counters?.browserPlatform !== undefined ? { browserPlatform: counters.browserPlatform } : {}),
    ...(counters?.perSurface !== undefined ? { perSurface: counters.perSurface } : {}),
    ...(counters?.networkFaults !== undefined ? { networkFaults: counters.networkFaults } : {}),
    ...(counters?.deterministic !== undefined ? { deterministic: counters.deterministic } : {}),
    ...(counters?.dataIntegrityEvaluations !== undefined ? { dataIntegrity: buildDataIntegritySummary(counters) } : {}),
    ...(counters?.mobile !== undefined ? { mobile: counters.mobile } : {}),
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

  try {
    const coverage = buildCoverage(runState.runId, nowIso(clock), runState, clusters, counters);
    writeJsonFile(paths.coverageFile, coverage);
  } catch (err) {
    log.warn('coverage.json write failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }

  // v0.48: Fire notifications concurrently after summary.json is written.
  if (runState.config.notifications !== undefined) {
    const notifyConfig = runState.config.notifications;
    fireNotifications({
      config: notifyConfig,
      projectDir: runState.projectDir,
      runId: runState.runId,
      projectName: runState.config.projectName,
      clusters,
      bySeverity: Object.fromEntries(Object.entries(bySeverity)) as Record<string, number>,
      byKind,
      crossRun,
      actualRuntimeMs,
    }).then(results => {
      const failed = results.filter(r => !r.ok);
      if (failed.length > 0) {
        log.warn('notify: some notifications failed', { count: failed.length });
        if (notifyConfig.failOnNotifyError === true) {
          process.exitCode = 1;
        }
      }
    }).catch(err => {
      log.warn('notify: unexpected error', { error: err instanceof Error ? err.message : String(err) });
      if (notifyConfig.failOnNotifyError === true) {
        process.exitCode = 1;
      }
    });
  }

  const skipLines = skipReasons.map(r => `Skipped: ${r.reason} (${r.count})`);

  const perfLines = buildPerfSummaryLines(counters?.perfSummary);
  const bundleLines = buildBundleSummaryLines(counters?.bundleSummary);
  const perSurfaceLines = buildPerSurfaceLines(counters?.perSurface);

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
    ...perSurfaceLines,
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

function buildDataIntegritySummary(counters: TestCounters): DataIntegritySummary {
  const evaluations = counters.dataIntegrityEvaluations ?? [];
  const counts = { passed: 0, violated: 0, skipped: 0, queryFailed: 0 };
  let durationMsTotal = 0;
  const violations: DataIntegritySummary['violations'] = [];
  const evaluatedActionIds = new Set<string>();

  for (const ev of evaluations) {
    durationMsTotal += ev.durationMs;
    evaluatedActionIds.add(ev.actionId);
    if (ev.outcome === 'passed') counts.passed++;
    else if (ev.outcome === 'violated') { counts.violated++; violations.push({ invariantName: ev.invariantName, bugKind: ev.bugKind, actionId: ev.actionId }); }
    else if (ev.outcome === 'skipped') counts.skipped++;
    else counts.queryFailed++;
  }

  return {
    enabled: counters.dataIntegrityEnabled !== false,
    invariantsConfigured: counters.dataIntegrityInvariantsConfigured ?? 0,
    actionsEvaluated: evaluatedActionIds.size,
    evaluations: counts,
    violations,
    durationMsTotal,
  };
}

function buildPerSurfaceLines(perSurface: RunSummary['perSurface']): string[] {
  if (perSurface === undefined || perSurface.length === 0) return [];
  const lines = ['', 'Per-surface budget vs elapsed:'];
  for (const s of perSurface) {
    const budget = s.budgetMs !== undefined ? `${Math.round(s.budgetMs / 1000)}s` : 'unlimited';
    const elapsed = `${Math.round(s.elapsedMs / 1000)}s`;
    lines.push(`  ${s.surfaceName}: elapsed=${elapsed} budget=${budget}`);
  }
  return lines;
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
