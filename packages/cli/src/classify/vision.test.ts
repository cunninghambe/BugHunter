// Unit tests for v0.15 vision consistency aggregation.
// Covers anomalyMatches (§6.1), aggregateConsistencyResults (§6.2),
// and classifyVisualAnomaliesConsistent (§6.3).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  anomalyMatches,
  aggregateConsistencyResults,
  classifyVisualAnomaliesConsistent,
} from './vision.js';
import type { BugDetection } from '../types.js';
import type { ClassifyVisualInput } from './vision.js';

// ---- helpers ----

function makeAnomaly(
  category: BugDetection['visualCategory'],
  severity: BugDetection['visualSeverity'],
  element: string,
): BugDetection {
  return {
    kind: 'visual_anomaly',
    rootCause: element !== '' ? `${element}: some description` : 'some description',
    visualCategory: category,
    visualSeverity: severity,
  };
}

// ---- anomalyMatches ----

describe('anomalyMatches', () => {
  it('same category, same severity, identical element → match (strict)', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const b = makeAnomaly('state', 'major', 'the trades table');
    expect(anomalyMatches(a, b, 'strict')).toBe(true);
  });

  it('same category, same severity, identical element → match (majority)', () => {
    const a = makeAnomaly('layout', 'critical', 'main content area');
    const b = makeAnomaly('layout', 'critical', 'main content area');
    expect(anomalyMatches(a, b, 'majority')).toBe(true);
  });

  it('same category, different severity → match (majority), no match (strict)', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const b = makeAnomaly('state', 'critical', 'the trades table');
    expect(anomalyMatches(a, b, 'majority')).toBe(true);
    expect(anomalyMatches(a, b, 'strict')).toBe(false);
  });

  it('different category, identical element → no match', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const b = makeAnomaly('layout', 'major', 'the trades table');
    expect(anomalyMatches(a, b, 'strict')).toBe(false);
    expect(anomalyMatches(a, b, 'majority')).toBe(false);
  });

  it('same category, severity, element overlap Jaccard=0.6 → match', () => {
    // tokens a: {trades, table, left} = 3
    // tokens b: {trades, table, left, sidebar} = 4
    // intersection: {trades, table, left} = 3
    // union = 4
    // jaccard = 3/4 = 0.75 >= 0.5 → match
    const a = makeAnomaly('state', 'major', 'trades table left');
    const b = makeAnomaly('state', 'major', 'trades table left sidebar');
    expect(anomalyMatches(a, b, 'strict')).toBe(true);
  });

  it('same category, severity, element overlap Jaccard=0.4 → no match (EC-5)', () => {
    // Spec EC-5: element "trades table" vs "trades table on the right"
    // tokens a: {trades, table} = 2
    // tokens b: {trades, table, on, the, right} = 5
    // intersection = {trades, table} = 2
    // union = 5
    // jaccard = 2/5 = 0.4 < 0.5 → no match
    const a = makeAnomaly('state', 'major', 'trades table');
    const b = makeAnomaly('state', 'major', 'trades table on the right');
    expect(anomalyMatches(a, b, 'strict')).toBe(false);
    expect(anomalyMatches(a, b, 'majority')).toBe(false);
  });

  it('empty element strings → no match (avoids false-positive on empty tokens)', () => {
    const a: BugDetection = { kind: 'visual_anomaly', rootCause: 'some description', visualCategory: 'error', visualSeverity: 'major' };
    const b: BugDetection = { kind: 'visual_anomaly', rootCause: 'other description', visualCategory: 'error', visualSeverity: 'major' };
    expect(anomalyMatches(a, b, 'strict')).toBe(false);
  });
});

// ---- aggregateConsistencyResults ----

describe('aggregateConsistencyResults', () => {
  it('2 runs, both contain 1 identical anomaly → kept×1, agreementRate=1', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const result = aggregateConsistencyResults([[a], [a]], 'strict');
    expect(result.kept).toHaveLength(1);
    expect(result.droppedByDisagreement).toBe(0);
    expect(result.agreementRate).toBe(1);
  });

  it('2 runs, run-0 has [A], run-1 has [] → strict drops A', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const result = aggregateConsistencyResults([[a], []], 'strict');
    expect(result.kept).toHaveLength(0);
    expect(result.droppedByDisagreement).toBeGreaterThan(0);
  });

  it('2 runs, run-0 has [A], run-1 has [] → majority keeps A (ceil(2/2)=1)', () => {
    const a = makeAnomaly('state', 'major', 'the trades table');
    const result = aggregateConsistencyResults([[a], []], 'majority');
    expect(result.kept).toHaveLength(1);
  });

  it('3 runs, [A,B], [A], [B] → strict drops both; majority keeps both', () => {
    const a = makeAnomaly('state', 'major', 'trades table');
    const b = makeAnomaly('layout', 'critical', 'main content');
    const strictResult = aggregateConsistencyResults([[a, b], [a], [b]], 'strict');
    expect(strictResult.kept).toHaveLength(0);
    const majorityResult = aggregateConsistencyResults([[a, b], [a], [b]], 'majority');
    expect(majorityResult.kept).toHaveLength(2);
  });

  it('3 runs, [A], [A], [B] → strict drops both; majority keeps A only', () => {
    const a = makeAnomaly('state', 'major', 'trades table');
    const b = makeAnomaly('layout', 'critical', 'main content');
    const strictResult = aggregateConsistencyResults([[a], [a], [b]], 'strict');
    expect(strictResult.kept).toHaveLength(0);
    const majorityResult = aggregateConsistencyResults([[a], [a], [b]], 'majority');
    expect(majorityResult.kept).toHaveLength(1);
    expect(majorityResult.kept[0]?.visualCategory).toBe('state');
  });

  it('5 runs, [A]×3 + []×2 → majority keeps A (3 >= ceil(5/2)=3); strict drops', () => {
    const a = makeAnomaly('error', 'critical', 'error banner');
    const strictResult = aggregateConsistencyResults([[a], [a], [a], [], []], 'strict');
    expect(strictResult.kept).toHaveLength(0);
    const majorityResult = aggregateConsistencyResults([[a], [a], [a], [], []], 'majority');
    expect(majorityResult.kept).toHaveLength(1);
  });

  it('empty runs (all []) → kept=[], droppedByDisagreement=0, agreementRate=1', () => {
    const result = aggregateConsistencyResults([[], [], []], 'strict');
    expect(result.kept).toHaveLength(0);
    expect(result.droppedByDisagreement).toBe(0);
    expect(result.agreementRate).toBe(1);
  });

  it('greedy match: [A1,A2] vs [A1] where A1≈A1 — greedy match A1-A1, A2 drops', () => {
    // A1: element "trades table overview" (tokens: trades, table, overview)
    // A2: element "trades table summary" (tokens: trades, table, summary)
    // Run-1 has only one A1 match → A1-A1 matched first (greedy), A2 has no remaining match
    const a1 = makeAnomaly('state', 'major', 'trades table overview');
    const a2 = makeAnomaly('state', 'major', 'trades table summary');
    // A2 matches A1 (2/4=0.5) — borderline. Let's check with 'majority' 2 runs: A2 needs 1 match
    // a2 Jaccard with a1: {trades,table,summary} ∩ {trades,table,overview} / {trades,table,summary,overview} = 2/4 = 0.5 ≥ 0.5 → matches
    // So greedy: A1 matches run1-A1, A2 tries run1 remaining (empty) → drops
    const run0 = [a1, a2];
    const run1 = [a1]; // only one match available
    const result = aggregateConsistencyResults([run0, run1], 'majority');
    // majority N=2: threshold=1, so each cluster needs size>=1
    // A1 cluster: size=2 (matched in both runs) → kept
    // A2 cluster: size=1 (only in run-0, no match in run-1 because greedy took A1-A1) → kept (majority threshold=1)
    // Wait — with N=2, majority = ceil(2/2) = 1. So size>=1 keeps it. A2 appears in run-0 only → size=1 → kept.
    // For strict N=2: threshold=2. A2 cluster size=1 → dropped.
    const strictResult = aggregateConsistencyResults([run0, run1], 'strict');
    // A1: size=2 → kept; A2: size=1 → dropped
    expect(strictResult.kept).toHaveLength(1);
    expect(strictResult.kept[0]?.visualCategory).toBe('state');
  });
});

// ---- classifyVisualAnomaliesConsistent ----

describe('classifyVisualAnomaliesConsistent', () => {
  const mockClient = {
    classify: vi.fn(),
  };

  const baseInput: Omit<ClassifyVisualInput, 'budget'> = {
    screenshotPath: '/tmp/fake-screenshot.png',
    url: 'http://localhost:3000/',
    action: { kind: 'render' },
    role: 'admin',
    config: { enabled: true, model: 'claude-sonnet-4-6', consistencyRuns: 2, agreementMode: 'strict' },
    client: mockClient,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('2 successful runs → callsSucceeded=2, callsAttempted=2', async () => {
    const anomalyResponse = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'state', element: 'the trades table', description: 'empty' }],
    });
    mockClient.classify.mockResolvedValue({ rawText: anomalyResponse, usage: { inputTokens: 100, outputTokens: 50 } });

    const result = await classifyVisualAnomaliesConsistent({
      ...baseInput,
      consistencyRuns: 2,
      agreementMode: 'strict',
    });

    expect(result.callsAttempted).toBe(2);
    expect(result.callsSucceeded).toBe(2);
    expect(result.perRunDetections).toHaveLength(2);
    // Both runs return same anomaly → strict passes → kept
    expect(result.detections).toHaveLength(1);
  });

  it('consistencyRuns=2 runs N times and aggregates — budget tryConsume managed by caller', async () => {
    // The wrapper runs exactly N times; caller is responsible for pre-consuming budget.
    // When both runs return the same anomaly, strict mode keeps it.
    const anomalyResponse = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'state', element: 'the trades table', description: 'empty' }],
    });
    // Run 1: has anomaly; Run 2: empty (simulates disagreement)
    mockClient.classify
      .mockResolvedValueOnce({ rawText: anomalyResponse, usage: { inputTokens: 100, outputTokens: 50 } })
      .mockResolvedValueOnce({ rawText: '{"anomalies":[]}', usage: { inputTokens: 10, outputTokens: 5 } });

    const mockBudget = {
      recordUsage: vi.fn(),
    };

    const result = await classifyVisualAnomaliesConsistent({
      ...baseInput,
      budget: mockBudget,
      consistencyRuns: 2,
      agreementMode: 'strict',
    });

    expect(result.callsAttempted).toBe(2);
    expect(result.callsSucceeded).toBe(2);
    expect(result.perRunDetections).toHaveLength(2);
    // Strict: run-0 has anomaly, run-1 empty → disagreement → dropped
    expect(result.detections).toHaveLength(0);
    expect(result.droppedByDisagreement).toBeGreaterThan(0);
  });

  it('all runs return no anomalies → empty detections, agreementRate=1', async () => {
    mockClient.classify.mockResolvedValue({ rawText: '{"anomalies":[]}', usage: { inputTokens: 10, outputTokens: 5 } });

    const result = await classifyVisualAnomaliesConsistent({
      ...baseInput,
      consistencyRuns: 2,
      agreementMode: 'strict',
    });

    expect(result.detections).toHaveLength(0);
    expect(result.agreementRate).toBe(1);
    expect(result.droppedByDisagreement).toBe(0);
  });

  it('consistencyRuns=1 → single-call result, every anomaly passes (EC-8)', async () => {
    const anomalyResponse = JSON.stringify({
      anomalies: [{ severity: 'critical', category: 'error', element: 'error banner', description: 'crash' }],
    });
    mockClient.classify.mockResolvedValue({ rawText: anomalyResponse, usage: { inputTokens: 100, outputTokens: 50 } });

    const result = await classifyVisualAnomaliesConsistent({
      ...baseInput,
      config: { ...baseInput.config, consistencyRuns: 1 },
      consistencyRuns: 1,
      agreementMode: 'strict',
    });

    expect(result.callsAttempted).toBe(1);
    expect(result.callsSucceeded).toBe(1);
    expect(result.detections).toHaveLength(1);
  });
});
