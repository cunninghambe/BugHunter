// v0.44: Unit tests for matchClustersToGold.

import { describe, it, expect } from 'vitest';
import { matchClustersToGold, MissingBugIdentityError, DuplicateBugIdentityError, extractIdentityUpdates } from './match.js';
import type { BugCluster } from '../types.js';
import type { GoldEntry } from './gold.js';

function makeCluster(overrides: Partial<BugCluster>): BugCluster {
  return {
    id: 'ck_test',
    runId: 'run_001',
    kind: 'console_error',
    rootCause: 'test root cause',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    bugIdentity: 'abcdef1234567890',
    signatureKey: '/dashboard:console_error:test-message',
    ...overrides,
  };
}

function makeGold(overrides: Partial<GoldEntry>): GoldEntry {
  return {
    goldId: 'vibe-todo-001',
    kind: 'console_error',
    expected: 'detector_fires',
    bugIdentity: 'abcdef1234567890',
    rationale: 'Test gold entry',
    humanRepro: ['Step 1'],
    addedInBenchVersion: '0.1.0',
    ...overrides,
  };
}

describe('matchClustersToGold — bugIdentity matching', () => {
  it('matches via bugIdentity → true_positive', () => {
    const cluster = makeCluster({ id: 'ck_1', bugIdentity: 'abcdef1234567890' });
    const gold = makeGold({ goldId: 'app-001', bugIdentity: 'abcdef1234567890' });
    const { outcomes, ambiguities } = matchClustersToGold([cluster], [gold]);

    expect(ambiguities).toHaveLength(0);
    expect(outcomes).toHaveLength(1);
    const tp = outcomes[0];
    expect(tp.kind).toBe('true_positive');
    if (tp.kind === 'true_positive') {
      expect(tp.clusterId).toBe('ck_1');
      expect(tp.matchVia).toBe('bugIdentity');
      expect(tp.goldId).toBe('app-001');
    }
  });

  it('no cluster with matching bugIdentity and expected fires → false_negative', () => {
    const gold = makeGold({ bugIdentity: 'ffffffffffffffff', expected: 'detector_fires' });
    const { outcomes } = matchClustersToGold([], [gold]);
    expect(outcomes[0]?.kind).toBe('false_negative');
    expect((outcomes[0] as { kind: 'false_negative'; reason: string }).reason).toBe('no_cluster_with_matching_identity');
  });

  it('no cluster with matching bugIdentity and expected silent → true_negative', () => {
    const gold = makeGold({ bugIdentity: 'ffffffffffffffff', expected: 'detector_silent' });
    const { outcomes } = matchClustersToGold([], [gold]);
    expect(outcomes[0]?.kind).toBe('true_negative');
  });

  it('unmatched cluster → false_positive', () => {
    const cluster = makeCluster({ id: 'ck_fp', bugIdentity: 'deadbeef00001234' });
    const gold = makeGold({ bugIdentity: 'abcdef1234567890' });
    const { outcomes } = matchClustersToGold([cluster], [gold]);
    const fp = outcomes.find(o => o.kind === 'false_positive');
    expect(fp).toBeDefined();
    if (fp?.kind === 'false_positive') expect(fp.clusterId).toBe('ck_fp');
  });

  it('cluster without bugIdentity throws MissingBugIdentityError', () => {
    const cluster = makeCluster({ bugIdentity: undefined });
    expect(() => matchClustersToGold([cluster], [])).toThrow(MissingBugIdentityError);
  });

  it('duplicate bugIdentity throws DuplicateBugIdentityError', () => {
    const a = makeCluster({ id: 'ck_a', bugIdentity: 'aaaa000011112222' });
    const b = makeCluster({ id: 'ck_b', bugIdentity: 'aaaa000011112222' });
    expect(() => matchClustersToGold([a, b], [])).toThrow(DuplicateBugIdentityError);
  });

  it('correct cluster consumed so second gold sees a false_negative', () => {
    const cluster = makeCluster({ id: 'ck_1', bugIdentity: 'abcdef1234567890' });
    const gold1 = makeGold({ goldId: 'app-001', bugIdentity: 'abcdef1234567890' });
    const gold2 = makeGold({ goldId: 'app-002', bugIdentity: 'abcdef1234567890', expected: 'detector_fires' });
    // Same cluster cannot match two gold entries
    const { outcomes } = matchClustersToGold([cluster], [gold1, gold2]);
    const tp = outcomes.filter(o => o.kind === 'true_positive');
    const fn = outcomes.filter(o => o.kind === 'false_negative');
    // gold1 → TP, gold2 → FN (bugIdentity consumed)
    expect(tp).toHaveLength(1);
    expect(fn).toHaveLength(1);
  });
});

describe('matchClustersToGold — structural matching', () => {
  it('structural match → true_positive with matchVia structural', () => {
    const cluster = makeCluster({
      id: 'ck_struct',
      kind: 'console_error',
      signatureKey: '/dashboard:console_error:missing-handler',
      rootCause: 'missing-handler error in console',
      bugIdentity: 'aaaa111122223333',
    });
    const gold = makeGold({
      goldId: 'app-003',
      kind: 'console_error',
      bugIdentity: undefined,
      structuralMatch: {
        kind: 'console_error',
        normalizedLocation: '/dashboard',
        normalizedMessage: 'missing-handler',
      },
    });
    const { outcomes, ambiguities } = matchClustersToGold([cluster], [gold]);
    expect(ambiguities).toHaveLength(0);
    expect(outcomes[0]?.kind).toBe('true_positive');
    if (outcomes[0]?.kind === 'true_positive') {
      expect(outcomes[0].matchVia).toBe('structural');
    }
  });

  it('structural match with two candidates → ambiguity, not outcome', () => {
    const a = makeCluster({ id: 'ck_a', kind: 'console_error', signatureKey: '/page:console_error:err', rootCause: 'err', bugIdentity: 'aaaa000000000001' });
    const b = makeCluster({ id: 'ck_b', kind: 'console_error', signatureKey: '/page:console_error:err', rootCause: 'err', bugIdentity: 'aaaa000000000002' });
    const gold = makeGold({
      goldId: 'app-004',
      kind: 'console_error',
      bugIdentity: undefined,
      structuralMatch: { kind: 'console_error', normalizedLocation: '/page', normalizedMessage: 'err' },
    });
    const { outcomes, ambiguities } = matchClustersToGold([a, b], [gold]);
    expect(ambiguities).toHaveLength(1);
    expect(ambiguities[0]?.goldId).toBe('app-004');
    expect(ambiguities[0]?.candidates).toHaveLength(2);
    // No TP outcome emitted for ambiguous gold
    expect(outcomes.filter(o => o.kind === 'true_positive')).toHaveLength(0);
  });

  it('no structural match and expected silent → true_negative', () => {
    const gold = makeGold({
      goldId: 'app-005',
      kind: 'xss_stored',
      expected: 'detector_silent',
      bugIdentity: undefined,
      structuralMatch: { kind: 'xss_stored', normalizedLocation: '/checkout', normalizedMessage: 'stored-xss' },
    });
    const { outcomes } = matchClustersToGold([], [gold]);
    expect(outcomes[0]?.kind).toBe('true_negative');
  });

  it('no structural match and expected fires → false_negative', () => {
    const gold = makeGold({
      goldId: 'app-006',
      kind: 'console_error',
      expected: 'detector_fires',
      bugIdentity: undefined,
      structuralMatch: { kind: 'console_error', normalizedLocation: '/settings', normalizedMessage: 'unlabeled-form' },
    });
    const { outcomes } = matchClustersToGold([], [gold]);
    expect(outcomes[0]?.kind).toBe('false_negative');
  });
});

describe('extractIdentityUpdates', () => {
  it('returns updates for structural matches only', () => {
    const cluster = makeCluster({ id: 'ck_1', bugIdentity: 'aabbccdd11223344' });
    const goldEntry = makeGold({ goldId: 'app-007', bugIdentity: undefined, structuralMatch: { kind: 'console_error', normalizedLocation: '/x', normalizedMessage: 'y' } });
    const outcomes = [{
      kind: 'true_positive' as const,
      goldId: 'app-007',
      clusterId: 'ck_1',
      matchVia: 'structural' as const,
      bugKind: 'console_error' as const,
    }];
    const updates = extractIdentityUpdates(outcomes, [cluster], [goldEntry]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.goldId).toBe('app-007');
    expect(updates[0]?.newIdentity).toBe('aabbccdd11223344');
    expect(updates[0]?.oldIdentity).toBeUndefined();
  });

  it('skips bugIdentity matches', () => {
    const cluster = makeCluster({ id: 'ck_2', bugIdentity: 'aabbccdd11223344' });
    const gold = makeGold({ goldId: 'app-008', bugIdentity: 'aabbccdd11223344' });
    const outcomes = [{
      kind: 'true_positive' as const,
      goldId: 'app-008',
      clusterId: 'ck_2',
      matchVia: 'bugIdentity' as const,
      bugKind: 'console_error' as const,
    }];
    const updates = extractIdentityUpdates(outcomes, [cluster], [gold]);
    expect(updates).toHaveLength(0);
  });
});

describe('matchClustersToGold — edge cases', () => {
  it('empty clusters and empty gold → empty outcomes', () => {
    const { outcomes, ambiguities } = matchClustersToGold([], []);
    expect(outcomes).toHaveLength(0);
    expect(ambiguities).toHaveLength(0);
  });

  it('multiple kinds — only matching kind is consumed', () => {
    const c1 = makeCluster({ id: 'ck_1', kind: 'console_error', bugIdentity: 'aaaa000000000001' });
    const c2 = makeCluster({ id: 'ck_2', kind: 'network_5xx', bugIdentity: 'bbbb000000000002' });
    const g1 = makeGold({ goldId: 'app-001', kind: 'console_error', bugIdentity: 'aaaa000000000001' });
    const { outcomes } = matchClustersToGold([c1, c2], [g1]);
    // c1 matched (TP), c2 unmatched (FP)
    expect(outcomes.filter(o => o.kind === 'true_positive')).toHaveLength(1);
    expect(outcomes.filter(o => o.kind === 'false_positive')).toHaveLength(1);
  });
});
