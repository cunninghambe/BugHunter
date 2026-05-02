// v0.44: aggregateReport — build CalibrationReport from match outcomes.

import type { MatchOutcome, KindReport, KindReportStatus, CalibrationReport, AcceptanceThresholds } from './types.js';
import type { DetectorRegistryEntry } from '../detectors/registry.js';
import type { BugKind } from '../types.js';

type ReportInput = {
  outcomes: MatchOutcome[];
  registry: readonly DetectorRegistryEntry[];
  thresholds: AcceptanceThresholds;
  benchAppId: string;
  benchVersion: string;
  bughunterVersion: string;
  bughunterCommit: string;
  underlyingRunId: string;
  underlyingRunDir: string;
  totalClusters: number;
  totalGoldEntries: number;
};

function getThreshold(kind: string, thresholds: AcceptanceThresholds): { precision: number; recall: number } {
  return thresholds.perKind[kind] ?? thresholds.default;
}

function computeF1(p: number, r: number): number {
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

function buildKindReport(
  kind: string,
  registryEntry: DetectorRegistryEntry,
  outcomes: MatchOutcome[],
  thresholds: AcceptanceThresholds,
  enforceThresholds: boolean,
): { report: KindReport; isViolation: boolean } {
  const tp = outcomes.filter(o => o.kind === 'true_positive' && o.bugKind === kind).length;
  const fp = outcomes.filter(o => o.kind === 'false_positive' && o.bugKind === kind).length;
  const fn = outcomes.filter(o => o.kind === 'false_negative' && o.bugKind === kind).length;
  const tn = outcomes.filter(o => o.kind === 'true_negative' && o.bugKind === kind).length;

  const isDeferred = registryEntry.status === 'deferred';

  // Deferred kinds: if tn > 0 and no false positives, mark as expected_silent
  if (isDeferred) {
    const precision = fp === 0 ? 1.0 : tp / (tp + fp);
    const recall = fn === 0 ? 1.0 : tp / (tp + fn);
    const report: KindReport = {
      status: 'expected_silent',
      tp, fp, fn, tn,
      precision, recall,
      f1: computeF1(precision, recall),
      lowConfidence: false,
      registryStatus: 'deferred',
    };
    return { report, isViolation: false };
  }

  // Wired kinds with no gold data
  if (tp + fn === 0 && tp + fp === 0) {
    const report: KindReport = {
      status: 'no_data',
      tp, fp, fn, tn,
      precision: 1.0,
      recall: 1.0,
      f1: 1.0,
      lowConfidence: true,
    };
    return { report, isViolation: false };
  }

  const precision = tp + fp === 0 ? 1.0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1.0 : tp / (tp + fn);
  const f1 = computeF1(precision, recall);
  const lowConfidence = tp + fn < 3;

  const threshold = getThreshold(kind, thresholds);
  const belowThreshold = precision < threshold.precision || recall < threshold.recall;

  let status: KindReportStatus;
  let isViolation = false;
  if (belowThreshold && !lowConfidence && enforceThresholds) {
    status = 'below_threshold';
    isViolation = true;
  } else {
    status = 'ok';
  }

  const report: KindReport = {
    status,
    tp, fp, fn, tn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    lowConfidence,
    thresholdPrecision: threshold.precision,
    thresholdRecall: threshold.recall,
    passes: !belowThreshold || lowConfidence,
  };

  return { report, isViolation };
}

export function aggregateReport(input: ReportInput, enforceThresholds: boolean): CalibrationReport {
  const { outcomes, registry, thresholds } = input;

  const perKind: Record<string, KindReport> = {};
  const violations: string[] = [];

  for (const entry of registry) {
    const { report, isViolation } = buildKindReport(
      entry.kind, entry, outcomes, thresholds, enforceThresholds,
    );
    perKind[entry.kind] = report;
    if (isViolation) violations.push(entry.kind);
  }

  // Overall aggregates
  const tp = outcomes.filter(o => o.kind === 'true_positive').length;
  const fp = outcomes.filter(o => o.kind === 'false_positive').length;
  const fn = outcomes.filter(o => o.kind === 'false_negative').length;
  const tn = outcomes.filter(o => o.kind === 'true_negative').length;
  const overallPrecision = tp + fp === 0 ? 1.0 : tp / (tp + fp);
  const overallRecall = tp + fn === 0 ? 1.0 : tp / (tp + fn);
  const overallF1 = computeF1(overallPrecision, overallRecall);

  return {
    version: 1,
    schemaVersion: 'v0.44.0',
    generatedAt: new Date().toISOString(),
    benchAppId: input.benchAppId,
    benchVersion: input.benchVersion,
    bughunterVersion: input.bughunterVersion,
    bughunterCommit: input.bughunterCommit,
    underlyingRunId: input.underlyingRunId,
    underlyingRunDir: input.underlyingRunDir,
    overall: {
      totalClusters: input.totalClusters,
      totalGoldEntries: input.totalGoldEntries,
      tp, fp, fn, tn,
      precision: Math.round(overallPrecision * 1000) / 1000,
      recall: Math.round(overallRecall * 1000) / 1000,
      f1: Math.round(overallF1 * 1000) / 1000,
    },
    perKind,
    matches: outcomes,
    thresholdViolations: violations,
  };
}

/** Format a one-line human summary for stdout. */
export function formatSummaryLine(report: CalibrationReport): string {
  const { overall, thresholdViolations, benchAppId } = report;
  const base =
    `calibrate[${benchAppId}] tp=${overall.tp} fp=${overall.fp} fn=${overall.fn} ` +
    `precision=${overall.precision} recall=${overall.recall} f1=${overall.f1}`;
  if (thresholdViolations.length > 0) {
    return `${base} VIOLATIONS: ${thresholdViolations.join(', ')}`;
  }
  return `${base} OK`;
}

/** Collect bugIdentity updates from structural matches for --record-identities. */
export function kindCoverage(
  registry: readonly DetectorRegistryEntry[],
  outcomes: MatchOutcome[],
): { uncoveredWiredKinds: BugKind[]; deferredWithPositiveGold: BugKind[] } {
  const goldKinds = new Set(
    outcomes
      .filter(o => o.kind === 'true_positive' || o.kind === 'false_negative')
      .map(o => o.bugKind),
  );

  const uncoveredWiredKinds = registry
    .filter(e => e.status === 'wired' && !goldKinds.has(e.kind))
    .map(e => e.kind);

  const trueNegativeKinds = new Set(
    outcomes.filter(o => o.kind === 'true_negative').map(o => o.bugKind),
  );
  const deferredWithPositiveGold = registry
    .filter(e => e.status === 'deferred' && !trueNegativeKinds.has(e.kind) && goldKinds.has(e.kind))
    .map(e => e.kind);

  return { uncoveredWiredKinds, deferredWithPositiveGold };
}
