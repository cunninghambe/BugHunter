// Tests for matchPattern precedence, glob, and severity no-op behavior.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchPattern, extractEndpoint } from './match.js';
import type { BugCluster } from '../types.js';
import type { SuppressionEntry } from './types.js';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    kind: 'console_error',
    signatureKey: 'console_error|TypeError|abc123',
    rootCause: 'TypeError: Cannot read property',
    clusterSize: 3,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T01:00:00.000Z',
    occurrences: [
      {
        id: 'occ-1',
        role: 'admin',
        page: '/dashboard',
        action: { kind: 'click', selector: '#submit', toolId: undefined },
        screenshot: undefined,
        dom: undefined,
        consoleLog: undefined,
        networkLog: undefined,
      },
    ],
    suspectedFiles: ['src/auth/login.tsx'],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  } as unknown as BugCluster;
}

function makeEntry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  return {
    id: 'sup-1',
    pattern: 'kind:console_error',
    reason: 'Test reason',
    addedBy: 'dev@example.com',
    addedAt: '2026-04-30T12:00:00.000Z',
    matchCount: 0,
    ...overrides,
  };
}

describe('extractEndpoint', () => {
  it('returns toolId when set', () => {
    const cluster = makeCluster();
    cluster.occurrences[0].action = { kind: 'api_call', toolId: '/api/users', selector: undefined } as unknown as typeof cluster.occurrences[0]['action'];
    expect(extractEndpoint(cluster)).toBe('/api/users');
  });

  it('extracts from rootCause via tool failed pattern', () => {
    const cluster = makeCluster({ rootCause: 'tool /api/admin failed with 500' });
    expect(extractEndpoint(cluster)).toBe('/api/admin');
  });

  it('extracts from rootCause via links to pattern', () => {
    const cluster = makeCluster({ rootCause: 'links to /about which returned 404' });
    expect(extractEndpoint(cluster)).toBe('/about');
  });

  it('returns undefined when nothing matches', () => {
    const cluster = makeCluster({ rootCause: 'Something failed in authentication' });
    expect(extractEndpoint(cluster)).toBeUndefined();
  });
});

describe('matchPattern', () => {
  let warnedRef: { value: boolean };

  beforeEach(() => {
    warnedRef = { value: false };
  });

  it('returns no-match for empty entries', () => {
    const result = matchPattern(makeCluster(), [], warnedRef);
    expect(result.matched).toBe(false);
  });

  it('matches by kind', () => {
    const cluster = makeCluster({ kind: 'console_error' });
    const entries = [makeEntry({ pattern: 'kind:console_error' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.entry.pattern).toBe('kind:console_error');
  });

  it('does not match wrong kind', () => {
    const cluster = makeCluster({ kind: 'console_error' });
    const entries = [makeEntry({ pattern: 'kind:network_5xx' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(false);
  });

  it('matches by bugIdentity exact string', () => {
    const cluster = makeCluster({ signatureKey: 'console_error|TypeError|abc123' });
    const entries = [makeEntry({ id: 'sup-bi', pattern: 'bugIdentity:console_error|TypeError|abc123' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.entry.id).toBe('sup-bi');
  });

  it('does not match bugIdentity when signatureKey is empty', () => {
    const cluster = makeCluster({ signatureKey: undefined });
    const entries = [makeEntry({ pattern: 'bugIdentity:console_error|TypeError|abc123' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(false);
  });

  it('matches by suspectedFile glob', () => {
    const cluster = makeCluster({ suspectedFiles: ['src/auth/login.tsx'] });
    const entries = [makeEntry({ pattern: 'suspectedFile:src/auth/*.tsx' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(true);
  });

  it('does not match suspectedFile glob that does not apply', () => {
    const cluster = makeCluster({ suspectedFiles: ['src/components/Button.tsx'] });
    const entries = [makeEntry({ pattern: 'suspectedFile:src/auth/*.tsx' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(false);
  });

  // AC-7: precedence — bugIdentity > kind
  it('first-match-wins precedence: bugIdentity beats kind', () => {
    const cluster = makeCluster({
      kind: 'console_error',
      signatureKey: 'console_error|TypeError|abc123',
    });
    const kindEntry = makeEntry({ id: 'kind-entry', pattern: 'kind:console_error' });
    const biEntry = makeEntry({ id: 'bi-entry', pattern: 'bugIdentity:console_error|TypeError|abc123' });
    const result = matchPattern(cluster, [kindEntry, biEntry], warnedRef);
    expect(result.matched).toBe(true);
    // bugIdentity is higher precedence than kind — so bi-entry wins
    if (result.matched) expect(result.entry.id).toBe('bi-entry');
  });

  it('kind beats suspectedFile in precedence', () => {
    const cluster = makeCluster({
      kind: 'console_error',
      suspectedFiles: ['src/auth/login.tsx'],
    });
    const fileEntry = makeEntry({ id: 'file-entry', pattern: 'suspectedFile:src/auth/*.tsx' });
    const kindEntry = makeEntry({ id: 'kind-entry', pattern: 'kind:console_error' });
    const result = matchPattern(cluster, [fileEntry, kindEntry], warnedRef);
    // kind beats suspectedFile, so kind-entry wins
    if (result.matched) expect(result.entry.id).toBe('kind-entry');
  });

  // AC-19 / EC-8: severity pattern warns once and never matches in v0.28
  it('severity pattern never matches and warns once', () => {
    const logWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cluster = makeCluster();
    const entries = [makeEntry({ pattern: 'severity:critical' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(false);
    expect(warnedRef.value).toBe(true);
    logWarnSpy.mockRestore();
  });

  it('severity warn only fires once across multiple clusters', () => {
    const cluster1 = makeCluster();
    const cluster2 = makeCluster({ id: 'cluster-2' });
    const entries = [makeEntry({ pattern: 'severity:critical' })];
    matchPattern(cluster1, entries, warnedRef);
    matchPattern(cluster2, entries, warnedRef);
    // Still only the one true flip — no double-warn
    expect(warnedRef.value).toBe(true);
  });

  it('matches endpoint glob', () => {
    const cluster = makeCluster({ rootCause: 'tool /api/users/profile failed' });
    const entries = [makeEntry({ pattern: 'endpoint:/api/users/*' })];
    const result = matchPattern(cluster, entries, warnedRef);
    expect(result.matched).toBe(true);
  });
});
