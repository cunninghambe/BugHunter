import { describe, it, expect } from 'vitest';
import { applyFilters, EMPTY_FILTERS } from './filters.ts';
import type { BugCluster } from '../types.ts';

function makeOcc(role: string, page: string, occurrenceId = 'occ1') {
  return {
    occurrenceId,
    role,
    page,
    fullArtifacts: false as const,
    timestamp: '',
    action: { kind: 'click' as const, via: 'ui' as const, expectedOutcome: 'success' as const, palette: 'happy' as const },
  };
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'c1',
    runId: 'run1',
    kind: 'console_error',
    rootCause: 'TypeError: Cannot read properties of undefined',
    firstSeenAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    clusterSize: 1,
    occurrences: [makeOcc('admin', '/dashboard')],
    suspectedFiles: ['src/components/Dashboard.tsx'],
    fixHints: [],
    thirdPartyOrGenerated: false,
    severity: 'major',
    ...overrides,
  } as BugCluster;
}

describe('applyFilters', () => {
  it('returns all clusters when filters are empty and no search', () => {
    const clusters = [makeCluster(), makeCluster({ id: 'c2', kind: 'react_error' })];
    const result = applyFilters(clusters, EMPTY_FILTERS, '');
    expect(result).toHaveLength(2);
  });

  it('filters by kind', () => {
    const clusters = [
      makeCluster({ id: 'c1', kind: 'console_error' }),
      makeCluster({ id: 'c2', kind: 'react_error' }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, kinds: ['console_error'] }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('filters by role', () => {
    const clusters = [
      makeCluster({ id: 'c1', occurrences: [makeOcc('admin', '/', 'o1')] }),
      makeCluster({ id: 'c2', occurrences: [makeOcc('user', '/', 'o2')] }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, roles: ['admin'] }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('filters by severity', () => {
    const clusters = [
      makeCluster({ id: 'c1', severity: 'critical' }),
      makeCluster({ id: 'c2', severity: 'major' }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, severities: ['critical'] }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('hides clusters with absent severity when severity filter is active (EC-10)', () => {
    const clusterWithoutSeverity = makeCluster({ id: 'c1', severity: undefined });
    const result = applyFilters([clusterWithoutSeverity], { ...EMPTY_FILTERS, severities: ['major'] }, '');
    expect(result).toHaveLength(0);
  });

  it('shows clusters with absent severity when no severity filter (EC-10)', () => {
    const clusterWithoutSeverity = makeCluster({ id: 'c1', severity: undefined });
    const result = applyFilters([clusterWithoutSeverity], EMPTY_FILTERS, '');
    expect(result).toHaveLength(1);
  });

  it('filters by verdict', () => {
    const clusters = [
      makeCluster({ id: 'c1', verdict: 'verified_fixed' }),
      makeCluster({ id: 'c2', verdict: undefined }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, verdicts: ['verified_fixed'] }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('filters by pageRouteContains', () => {
    const clusters = [
      makeCluster({ id: 'c1', occurrences: [makeOcc('admin', '/dashboard', 'o1')] }),
      makeCluster({ id: 'c2', occurrences: [makeOcc('admin', '/settings', 'o2')] }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, pageRouteContains: 'dash' }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('excludes third-party clusters when thirdPartyOrGenerated=exclude', () => {
    const clusters = [
      makeCluster({ id: 'c1', thirdPartyOrGenerated: false }),
      makeCluster({ id: 'c2', thirdPartyOrGenerated: true }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, thirdPartyOrGenerated: 'exclude' }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('shows only third-party clusters when thirdPartyOrGenerated=only', () => {
    const clusters = [
      makeCluster({ id: 'c1', thirdPartyOrGenerated: false }),
      makeCluster({ id: 'c2', thirdPartyOrGenerated: true }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, thirdPartyOrGenerated: 'only' }, '');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c2');
  });

  it('searches rootCause (case-insensitive)', () => {
    const clusters = [
      makeCluster({ id: 'c1', rootCause: 'TypeError: Cannot read' }),
      makeCluster({ id: 'c2', rootCause: 'Network error 500' }),
    ];
    const result = applyFilters(clusters, EMPTY_FILTERS, 'TYPEERROR');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('searches kind', () => {
    const clusters = [
      makeCluster({ id: 'c1', kind: 'console_error' }),
      makeCluster({ id: 'c2', kind: 'react_error' }),
    ];
    const result = applyFilters(clusters, EMPTY_FILTERS, 'react');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c2');
  });

  it('searches suspectedFiles', () => {
    const clusters = [
      makeCluster({ id: 'c1', suspectedFiles: ['src/Login.tsx'] }),
      makeCluster({ id: 'c2', suspectedFiles: ['src/Dashboard.tsx'] }),
    ];
    const result = applyFilters(clusters, EMPTY_FILTERS, 'login');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('searches page routes', () => {
    const clusters = [
      makeCluster({ id: 'c1', occurrences: [makeOcc('admin', '/login', 'o1')] }),
      makeCluster({ id: 'c2', occurrences: [makeOcc('admin', '/home', 'o2')] }),
    ];
    const result = applyFilters(clusters, EMPTY_FILTERS, '/login');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('combines kind filter and search query (AND logic)', () => {
    const clusters = [
      makeCluster({ id: 'c1', kind: 'console_error', rootCause: 'TypeError in console' }),
      makeCluster({ id: 'c2', kind: 'react_error', rootCause: 'TypeError in react' }),
      makeCluster({ id: 'c3', kind: 'console_error', rootCause: 'Network failure' }),
    ];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, kinds: ['console_error'] }, 'TypeError');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
  });

  it('returns empty array when no clusters match', () => {
    const clusters = [makeCluster({ kind: 'react_error' })];
    const result = applyFilters(clusters, { ...EMPTY_FILTERS, kinds: ['console_error'] }, '');
    expect(result).toHaveLength(0);
  });
});
