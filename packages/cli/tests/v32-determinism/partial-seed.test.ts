// §6.4 Partial-determinism: --seed without --frozen-clock.
//
// Acceptance: structural identity across two runs with the same seed —
// same cluster count, same set of signatureKeys, same set of kinds.
// Byte identity is NOT required in this mode (timestamps are wall-clock).
//
// This file tests the id + cluster-structure level, not timestamp bytes.

import { describe, it, expect, afterEach } from 'vitest';
import { setIdFactory, resetIdFactory, createId } from '../../src/lib/ids.js';
import { canonicalize, CANONICAL_STRIP_KEYS, canonicalStringify } from '../../src/lib/canonical.js';
import { runCluster } from '../../src/phases/cluster.js';
import type { BugDetection, TestCase } from '../../src/types.js';

const SEED = 1234;

afterEach(() => resetIdFactory());

const BASE_OPTS = {
  runId: 'test-partial-seed',
  projectDir: '/tmp/test-ps',
  actionLogsDir: '/tmp/test-ps/action-logs',
  screenshotsDir: '/tmp/test-ps/screenshots',
  domDir: '/tmp/test-ps/dom',
  consoleDir: '/tmp/test-ps/console',
  networkDir: '/tmp/test-ps/network',
  maxClusters: 200,
};

function det(kind: BugDetection['kind'], endpoint: string, testId: string): { testId: string; detection: BugDetection } {
  return { testId, detection: { kind, rootCause: `root cause for ${endpoint}`, endpoint, status: 500 } };
}

function tc(id: string): TestCase {
  return {
    id,
    runId: 'test-partial-seed',
    role: 'owner',
    page: '/test',
    action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'happy', toolId: 'tool-1' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

describe('partial-seed: seeded id sequences are structurally stable', () => {
  it('two seeded runs produce the same number of ids', () => {
    setIdFactory(SEED);
    const run1 = Array.from({ length: 50 }, () => createId());

    resetIdFactory();
    setIdFactory(SEED);
    const run2 = Array.from({ length: 50 }, () => createId());

    expect(run1.length).toBe(run2.length);
    expect(new Set(run1).size).toBe(50);
    expect(new Set(run2).size).toBe(50);
  });

  it('all ids conform to cuid2 format (start with lowercase letter, 24 chars)', () => {
    setIdFactory(SEED);
    const ids = Array.from({ length: 100 }, () => createId());
    for (const id of ids) {
      expect(id.length).toBe(24);
      expect(/^[a-z]/.test(id)).toBe(true);
    }
  });
});

describe('partial-seed: cluster structural identity', () => {
  const pairs = [
    det('network_5xx', 'POST /api/login', 'tc1'),
    det('network_5xx', 'POST /api/register', 'tc2'),
    det('image_missing_alt', 'GET /home', 'tc3'),
    det('xss_reflected', 'GET /search?q=<script>', 'tc4'),
  ];
  const testCases = ['tc1', 'tc2', 'tc3', 'tc4'].map(id => tc(id));
  const occurrenceIdByTestId = new Map(pairs.map(p => [p.testId, `occ-${p.testId}`]));

  it('same detections produce same cluster count and signature set', () => {
    const r1 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });
    const r2 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });

    expect(r1.clusters.length).toBe(r2.clusters.length);

    const sigs1 = new Set(r1.clusters.map(c => c.signatureKey));
    const sigs2 = new Set(r2.clusters.map(c => c.signatureKey));
    expect(sigs1).toEqual(sigs2);
  });

  it('same detections produce same set of bug kinds', () => {
    const r1 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });
    const r2 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });

    const kinds1 = new Set(r1.clusters.map(c => c.kind));
    const kinds2 = new Set(r2.clusters.map(c => c.kind));
    expect(kinds1).toEqual(kinds2);
  });

  it('summary.byKind matches across two runs', () => {
    const r1 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });
    const r2 = runCluster({ ...BASE_OPTS, detections: pairs, testCases, occurrenceIdByTestId });

    const byKind1: Record<string, number> = {};
    const byKind2: Record<string, number> = {};
    for (const c of r1.clusters) byKind1[c.kind] = (byKind1[c.kind] ?? 0) + 1;
    for (const c of r2.clusters) byKind2[c.kind] = (byKind2[c.kind] ?? 0) + 1;

    expect(canonicalStringify(byKind1)).toBe(canonicalStringify(byKind2));
  });
});

describe('partial-seed: canonicalize strips time-varying fields', () => {
  it('two summaries with different wall-clock timestamps are canonical-equal after strip', () => {
    const summary1 = {
      runId: 'run-1',
      bugs_filed: 3,
      actualRuntimeMs: 12345,
      projectedRuntimeMs: 10000,
      byKind: { xss_stored: 2, network_5xx: 1 },
      startedAt: '2026-05-01T10:00:00.000Z',
    };
    const summary2 = {
      ...summary1,
      actualRuntimeMs: 98765,
      projectedRuntimeMs: 11000,
      startedAt: '2026-05-01T11:00:00.000Z',
    };

    const c1 = canonicalize(summary1, [...CANONICAL_STRIP_KEYS, 'startedAt']);
    const c2 = canonicalize(summary2, [...CANONICAL_STRIP_KEYS, 'startedAt']);
    expect(canonicalStringify(c1)).toBe(canonicalStringify(c2));
  });
});

describe('partial-seed: EC-10 / EC-11 seed validation', () => {
  it('seed 0 produces valid ids', () => {
    setIdFactory(0);
    const id = createId();
    expect(id.length).toBe(24);
    expect(/^[a-z]/.test(id)).toBe(true);
  });

  it('different seeds produce structurally identical but content-different ids', () => {
    setIdFactory(1234);
    const seqA = Array.from({ length: 20 }, () => createId());

    resetIdFactory();
    setIdFactory(5678);
    const seqB = Array.from({ length: 20 }, () => createId());

    // All valid cuid2
    expect(seqA.every(id => id.length === 24)).toBe(true);
    expect(seqB.every(id => id.length === 24)).toBe(true);
    // Different entropy → different content
    expect(seqA).not.toEqual(seqB);
  });
});
