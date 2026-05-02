// v0.44: Calibration discriminated-union types.

import type { BugKind } from '../types.js';

// ---------------------------------------------------------------------------
// Match outcomes — one per gold entry (true/false positive/negative) plus one
// per unmatched cluster (false_positive).
// ---------------------------------------------------------------------------

export type MatchOutcome =
  | { kind: 'true_positive'; goldId: string; clusterId: string; matchVia: 'bugIdentity' | 'structural'; bugKind: BugKind }
  | { kind: 'false_negative'; goldId: string; bugKind: BugKind; reason: string }
  | { kind: 'true_negative'; goldId: string; bugKind: BugKind }
  | { kind: 'false_positive'; clusterId: string; bugKind: BugKind; rootCause: string };

// ---------------------------------------------------------------------------
// Per-kind aggregated report entry
// ---------------------------------------------------------------------------

export type KindReportStatus =
  | 'ok'
  | 'below_threshold'
  | 'expected_silent'
  | 'no_data';

export type KindReport = {
  status: KindReportStatus;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  lowConfidence: boolean;
  thresholdPrecision?: number;
  thresholdRecall?: number;
  passes?: boolean;
  /** Only present for deferred kinds. */
  registryStatus?: 'deferred';
};

// ---------------------------------------------------------------------------
// Full calibration report shape
// ---------------------------------------------------------------------------

export type CalibrationReport = {
  version: 1;
  schemaVersion: 'v0.44.0';
  generatedAt: string;
  benchAppId: string;
  benchVersion: string;
  bughunterVersion: string;
  bughunterCommit: string;
  underlyingRunId: string;
  underlyingRunDir: string;
  overall: {
    totalClusters: number;
    totalGoldEntries: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number;
    recall: number;
    f1: number;
  };
  perKind: Record<string, KindReport>;
  matches: MatchOutcome[];
  thresholdViolations: string[];
};

// ---------------------------------------------------------------------------
// Acceptance thresholds shape
// ---------------------------------------------------------------------------

export type KindThreshold = {
  precision: number;
  recall: number;
  rationale?: string;
};

export type AcceptanceThresholds = {
  default: KindThreshold;
  perKind: Record<string, KindThreshold>;
};
