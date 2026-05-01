import { describe, it, expect, vi } from 'vitest';
import { parseFailOn, evaluateFailOn, describeFailOn } from '../src/export/fail-on.js';
import type { BugCluster, OccurrenceSummary } from '../src/types.js';
import type { DiffSummary } from '../src/export/fail-on.js';

function makeSummaryOcc(): OccurrenceSummary {
  return {
    occurrenceId: 'occ-1',
    role: 'admin',
    page: '/dashboard',
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success' },
    fullArtifacts: false,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-001',
    kind: 'idor_horizontal',
    rootCause: 'TypeError',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T01:00:00Z',
    clusterSize: 1,
    occurrences: [makeSummaryOcc()],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  };
}

describe('parseFailOn', () => {
  it('returns never for undefined', () => {
    expect(parseFailOn(undefined)).toEqual({ kind: 'never' });
  });

  it('returns never for empty string', () => {
    expect(parseFailOn('')).toEqual({ kind: 'never' });
  });

  it('returns never for "never"', () => {
    expect(parseFailOn('never')).toEqual({ kind: 'never' });
  });

  it('parses "critical" alias', () => {
    expect(parseFailOn('critical')).toEqual({ kind: 'severity', min: 'critical' });
  });

  it('parses "major+" alias', () => {
    expect(parseFailOn('major+')).toEqual({ kind: 'severity', min: 'major' });
  });

  it('parses "major" alias', () => {
    expect(parseFailOn('major')).toEqual({ kind: 'severity', min: 'major' });
  });

  it('parses "high" alias as major', () => {
    expect(parseFailOn('high')).toEqual({ kind: 'severity', min: 'major' });
  });

  it('parses "high+" alias as major', () => {
    expect(parseFailOn('high+')).toEqual({ kind: 'severity', min: 'major' });
  });

  it('parses "minor+" alias', () => {
    expect(parseFailOn('minor+')).toEqual({ kind: 'severity', min: 'minor' });
  });

  it('parses "any" alias as info', () => {
    expect(parseFailOn('any')).toEqual({ kind: 'severity', min: 'info' });
  });

  it('parses "info+" alias', () => {
    expect(parseFailOn('info+')).toEqual({ kind: 'severity', min: 'info' });
  });

  it('parses count:N', () => {
    expect(parseFailOn('count:5')).toEqual({ kind: 'count', threshold: 5 });
  });

  it('parses count:0', () => {
    expect(parseFailOn('count:0')).toEqual({ kind: 'count', threshold: 0 });
  });

  it('parses regression:major', () => {
    expect(parseFailOn('regression:major')).toEqual({ kind: 'regression', min: 'major' });
  });

  it('parses kind:unhandled_exception', () => {
    expect(parseFailOn('kind:unhandled_exception')).toEqual({ kind: 'bugKind', bugKind: 'unhandled_exception' });
  });

  it('exits on invalid spec', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => parseFailOn('foobar')).toThrow('exit');
    exitSpy.mockRestore();
  });
});

describe('evaluateFailOn', () => {
  it('never rule always returns false', () => {
    const clusters = [makeCluster({ kind: 'unhandled_exception' })];
    expect(evaluateFailOn({ kind: 'never' }, clusters, null)).toBe(false);
  });

  it('severity rule: returns true when cluster meets threshold', () => {
    // auth_bypass is critical
    const clusters = [makeCluster({ kind: 'unhandled_exception' })];
    expect(evaluateFailOn({ kind: 'severity', min: 'critical' }, clusters, null)).toBe(true);
  });

  it('severity rule: returns false when no cluster meets threshold', () => {
    // idor_horizontal is major, threshold is critical
    const clusters = [makeCluster({ kind: 'idor_horizontal' })];
    expect(evaluateFailOn({ kind: 'severity', min: 'critical' }, clusters, null)).toBe(false);
  });

  it('count rule: returns true at exact threshold', () => {
    const clusters = [makeCluster(), makeCluster({ id: 'c2' }), makeCluster({ id: 'c3' })];
    expect(evaluateFailOn({ kind: 'count', threshold: 3 }, clusters, null)).toBe(true);
  });

  it('count rule: returns false below threshold', () => {
    const clusters = [makeCluster()];
    expect(evaluateFailOn({ kind: 'count', threshold: 5 }, clusters, null)).toBe(false);
  });

  it('bugKind rule: returns true when cluster has that kind', () => {
    const clusters = [makeCluster({ kind: 'unhandled_exception' })];
    expect(evaluateFailOn({ kind: 'bugKind', bugKind: 'unhandled_exception' }, clusters, null)).toBe(true);
  });

  it('bugKind rule: returns false when no cluster has that kind', () => {
    const clusters = [makeCluster({ kind: 'idor_horizontal' })];
    expect(evaluateFailOn({ kind: 'bugKind', bugKind: 'unhandled_exception' }, clusters, null)).toBe(false);
  });

  it('regression rule: fires on added clusters', () => {
    const diff: DiffSummary = {
      added: [makeCluster({ kind: 'unhandled_exception' })],
      regressed: [],
    };
    expect(evaluateFailOn({ kind: 'regression', min: 'critical' }, [], diff)).toBe(true);
  });

  it('regression rule: returns false when diff is clean', () => {
    const diff: DiffSummary = { added: [], regressed: [] };
    expect(evaluateFailOn({ kind: 'regression', min: 'critical' }, [], diff)).toBe(false);
  });

  it('regression rule: exits when diff is null', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => evaluateFailOn({ kind: 'regression', min: 'major' }, [], null)).toThrow('exit');
    exitSpy.mockRestore();
  });
});

describe('describeFailOn', () => {
  it('describes never rule', () => {
    expect(describeFailOn({ kind: 'never' })).toContain('always pass');
  });

  it('describes severity rule', () => {
    expect(describeFailOn({ kind: 'severity', min: 'major' })).toContain('major');
  });

  it('describes count rule', () => {
    expect(describeFailOn({ kind: 'count', threshold: 10 })).toContain('10');
  });
});
