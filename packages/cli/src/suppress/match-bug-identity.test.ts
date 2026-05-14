// Regression test: bugIdentity:<hash> patterns must match cluster.bugIdentity,
// not cluster.signatureKey. Prior to fix, matchesBugIdentity compared against
// signatureKey so 16-char hex hashes from `bughunter suppress bugIdentity:<hash>`
// were never honoured at emit time.
import { describe, it, expect } from 'vitest';
import { matchPattern } from './match.js';
import type { BugCluster } from '../types.js';
import type { SuppressionEntry } from './types.js';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    kind: 'hardcoded_credentials_in_source',
    signatureKey: 'unknown|hardcoded_credentials_in_source|.next/server/app/api/auth/login/route.js|1',
    bugIdentity: 'd5b1b2fdbb15b924',
    rootCause: 'Hardcoded credential found',
    clusterSize: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  } as unknown as BugCluster;
}

function makeEntry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  return {
    id: 'sup-1',
    pattern: 'bugIdentity:d5b1b2fdbb15b924',
    reason: 'FP: bcrypt hash in build dir',
    addedBy: 'dev@example.com',
    addedAt: '2026-05-09T18:14:37.087Z',
    matchCount: 0,
    ...overrides,
  };
}

describe('matchPattern — bugIdentity field matching (regression)', () => {
  const warnedRef = { value: false };

  it('matches cluster.bugIdentity (16-char hex) against bugIdentity:<hash> pattern', () => {
    const cluster = makeCluster();
    const entry = makeEntry({ pattern: 'bugIdentity:d5b1b2fdbb15b924' });
    const result = matchPattern(cluster, [entry], warnedRef);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.entry.id).toBe('sup-1');
  });

  it('does not match when bugIdentity hash differs', () => {
    const cluster = makeCluster({ bugIdentity: 'd5b1b2fdbb15b924' });
    const entry = makeEntry({ pattern: 'bugIdentity:ffffffffffffffff' });
    const result = matchPattern(cluster, [entry], { value: false });
    expect(result.matched).toBe(false);
  });

  it('does not match when cluster has no bugIdentity and signatureKey also differs', () => {
    const cluster = makeCluster({ bugIdentity: undefined, signatureKey: 'some|other|key' });
    const entry = makeEntry({ pattern: 'bugIdentity:d5b1b2fdbb15b924' });
    const result = matchPattern(cluster, [entry], { value: false });
    expect(result.matched).toBe(false);
  });

  it('falls back to signatureKey when bugIdentity is absent (pre-v0.27 cluster backward compat)', () => {
    const cluster = makeCluster({ bugIdentity: undefined, signatureKey: 'd5b1b2fdbb15b924' });
    const entry = makeEntry({ pattern: 'bugIdentity:d5b1b2fdbb15b924' });
    const result = matchPattern(cluster, [entry], { value: false });
    expect(result.matched).toBe(true);
  });
});
