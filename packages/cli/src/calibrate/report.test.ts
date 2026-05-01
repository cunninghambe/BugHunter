// v0.44: Unit tests for aggregateReport.

import { describe, it, expect } from 'vitest';
import { aggregateReport, formatSummaryLine } from './report.js';
import type { MatchOutcome, AcceptanceThresholds } from './types.js';
import type { DetectorRegistryEntry } from '../detectors/registry.js';

const THRESHOLDS: AcceptanceThresholds = {
  default: { precision: 0.85, recall: 0.80 },
  perKind: {
    visual_anomaly: { precision: 0.70, recall: 0.70 },
  },
};

function makeEntry(kind: string, status: 'wired' | 'deferred'): DetectorRegistryEntry {
  return {
    kind: kind as DetectorRegistryEntry['kind'],
    status,
    inputSource: 'production',
    specReference: 'SPEC.md',
  };
}

const BASE_INPUT = {
  benchAppId: 'test-app',
  benchVersion: '0.1.0',
  bughunterVersion: '0.44.0',
  bughunterCommit: 'abc123',
  underlyingRunId: 'run_001',
  underlyingRunDir: '.bughunter/runs/run_001',
  totalClusters: 0,
  totalGoldEntries: 0,
};

describe('aggregateReport', () => {
  it('all true_positives → precision 1.0, recall 1.0', () => {
    const registry = [makeEntry('console_error', 'wired')];
    const outcomes: MatchOutcome[] = [
      { kind: 'true_positive', goldId: 'app-001', clusterId: 'ck_1', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-002', clusterId: 'ck_2', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-003', clusterId: 'ck_3', matchVia: 'bugIdentity', bugKind: 'console_error' },
    ];
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 3, totalGoldEntries: 3 }, false);
    expect(report.perKind['console_error']?.precision).toBe(1.0);
    expect(report.perKind['console_error']?.recall).toBe(1.0);
    expect(report.perKind['console_error']?.status).toBe('ok');
    expect(report.perKind['console_error']?.passes).toBe(true);
  });

  it('deferred kind with true_negative → expected_silent status', () => {
    const registry = [makeEntry('xss_stored', 'deferred')];
    const outcomes: MatchOutcome[] = [
      { kind: 'true_negative', goldId: 'app-d01', bugKind: 'xss_stored' },
    ];
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 0, totalGoldEntries: 1 }, false);
    const entry = report.perKind['xss_stored'];
    expect(entry?.status).toBe('expected_silent');
    expect(entry?.registryStatus).toBe('deferred');
    expect(entry?.tn).toBe(1);
  });

  it('no gold data for wired kind → no_data status, lowConfidence true', () => {
    const registry = [makeEntry('console_error', 'wired')];
    const report = aggregateReport({ ...BASE_INPUT, outcomes: [], registry, thresholds: THRESHOLDS }, false);
    const entry = report.perKind['console_error'];
    expect(entry?.status).toBe('no_data');
    expect(entry?.lowConfidence).toBe(true);
  });

  it('below threshold with enforceThresholds → below_threshold + violation', () => {
    const registry = [makeEntry('console_error', 'wired')];
    const outcomes: MatchOutcome[] = [
      { kind: 'true_positive', goldId: 'app-001', clusterId: 'ck_1', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-002', clusterId: 'ck_2', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-003', clusterId: 'ck_3', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'false_positive', clusterId: 'ck_fp', bugKind: 'console_error', rootCause: 'extra cluster' },
      { kind: 'false_positive', clusterId: 'ck_fp2', bugKind: 'console_error', rootCause: 'extra cluster 2' },
      { kind: 'false_negative', goldId: 'app-004', bugKind: 'console_error', reason: 'no_cluster_with_matching_identity' },
    ];
    // precision = 3/5 = 0.6 < 0.85 → violation
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 5, totalGoldEntries: 4 }, true);
    expect(report.perKind['console_error']?.status).toBe('below_threshold');
    expect(report.thresholdViolations).toContain('console_error');
  });

  it('lowConfidence kind below threshold with enforceThresholds → ok (not violation)', () => {
    const registry = [makeEntry('console_error', 'wired')];
    // Only 1 gold entry (< 3), so lowConfidence = true → no violation
    const outcomes: MatchOutcome[] = [
      { kind: 'false_negative', goldId: 'app-001', bugKind: 'console_error', reason: 'no_cluster_with_matching_identity' },
    ];
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS }, true);
    expect(report.perKind['console_error']?.lowConfidence).toBe(true);
    expect(report.thresholdViolations).not.toContain('console_error');
  });

  it('per-kind threshold override is used', () => {
    const registry = [makeEntry('visual_anomaly', 'wired')];
    // visual_anomaly threshold is 0.70. With precision 0.75 → passes.
    const outcomes: MatchOutcome[] = [
      { kind: 'true_positive', goldId: 'app-001', clusterId: 'ck_1', matchVia: 'bugIdentity', bugKind: 'visual_anomaly' },
      { kind: 'true_positive', goldId: 'app-002', clusterId: 'ck_2', matchVia: 'bugIdentity', bugKind: 'visual_anomaly' },
      { kind: 'true_positive', goldId: 'app-003', clusterId: 'ck_3', matchVia: 'bugIdentity', bugKind: 'visual_anomaly' },
      { kind: 'false_positive', clusterId: 'ck_fp', bugKind: 'visual_anomaly', rootCause: 'noisy diff' },
    ];
    // precision = 3/4 = 0.75 ≥ 0.70 → no violation
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 4, totalGoldEntries: 3 }, true);
    expect(report.thresholdViolations).not.toContain('visual_anomaly');
    expect(report.perKind['visual_anomaly']?.thresholdPrecision).toBe(0.70);
  });

  it('overall aggregates are correct', () => {
    const registry = [makeEntry('console_error', 'wired'), makeEntry('network_5xx', 'wired')];
    const outcomes: MatchOutcome[] = [
      { kind: 'true_positive', goldId: 'a1', clusterId: 'ck_1', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'false_positive', clusterId: 'ck_2', bugKind: 'network_5xx', rootCause: 'spurious' },
      { kind: 'false_negative', goldId: 'a2', bugKind: 'network_5xx', reason: 'no_cluster_with_matching_identity' },
    ];
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 2, totalGoldEntries: 2 }, false);
    expect(report.overall.tp).toBe(1);
    expect(report.overall.fp).toBe(1);
    expect(report.overall.fn).toBe(1);
    expect(report.overall.tn).toBe(0);
  });

  it('report has correct schemaVersion and version', () => {
    const report = aggregateReport({ ...BASE_INPUT, outcomes: [], registry: [], thresholds: THRESHOLDS }, false);
    expect(report.version).toBe(1);
    expect(report.schemaVersion).toBe('v0.44.0');
  });
});

describe('formatSummaryLine', () => {
  it('shows OK when no violations', () => {
    const report = aggregateReport({ ...BASE_INPUT, outcomes: [], registry: [], thresholds: THRESHOLDS }, false);
    const line = formatSummaryLine(report);
    expect(line).toContain('OK');
    expect(line).toContain('test-app');
  });

  it('shows VIOLATIONS when thresholds not met', () => {
    const registry = [makeEntry('console_error', 'wired')];
    const outcomes: MatchOutcome[] = [
      { kind: 'true_positive', goldId: 'app-001', clusterId: 'ck_1', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-002', clusterId: 'ck_2', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'true_positive', goldId: 'app-003', clusterId: 'ck_3', matchVia: 'bugIdentity', bugKind: 'console_error' },
      { kind: 'false_positive', clusterId: 'ck_fp', bugKind: 'console_error', rootCause: 'r' },
      { kind: 'false_positive', clusterId: 'ck_fp2', bugKind: 'console_error', rootCause: 'r2' },
    ];
    const report = aggregateReport({ ...BASE_INPUT, outcomes, registry, thresholds: THRESHOLDS, totalClusters: 5, totalGoldEntries: 3 }, true);
    const line = formatSummaryLine(report);
    expect(line).toContain('VIOLATIONS');
    expect(line).toContain('console_error');
  });
});
