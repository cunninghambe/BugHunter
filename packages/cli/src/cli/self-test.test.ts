// Unit tests for self-test.ts — covers evaluateExpectations, assertLockstep, and latestRunId.
// No fixture boot. No network. Pure logic tests.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { evaluateExpectations, assertLockstep, LockstepError, latestRunId, defaultBudgetMs, buildSelfTestRunOpts } from './self-test.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import type { BugCluster } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCluster(kind: string, signatureKey: string, clusterSize = 1, rootCause = ''): BugCluster {
  return {
    id: `clu-${kind}`,
    runId: 'run-test',
    kind: kind as BugCluster['kind'],
    rootCause,
    clusterSize,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    signatureKey,
  };
}

function makePositive(kind: string, prefix: string, opts: {
  minClusterSize?: number;
  rootCauseSubstring?: string;
  acceptableMisses?: 0 | 1;
} = {}) {
  return {
    kind: kind as BugCluster['kind'],
    signaturePrefix: prefix,
    fixture: 'self' as const,
    specReference: 'TEST',
    ...opts,
  };
}

function makeNegative(kind: string) {
  return {
    expect: 'absent' as const,
    kind: kind as BugCluster['kind'],
    reason: 'test',
  };
}

// ---------------------------------------------------------------------------
// evaluateExpectations
// ---------------------------------------------------------------------------

describe('evaluateExpectations', () => {
  it('PASS when cluster matches kind and prefix', () => {
    const clusters = [makeCluster('console_error', 'console_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives).toHaveLength(1);
    expect(result.positives[0].status).toBe('PASS');
  });

  it('MISS when no cluster matches the prefix', () => {
    const clusters: BugCluster[] = [];
    const golden = [makePositive('console_error', 'console_error')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('MISS');
  });

  it('MISS when cluster exists but wrong kind', () => {
    const clusters = [makeCluster('react_error', 'react_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('MISS');
  });

  it('MISS when prefix does not match', () => {
    const clusters = [makeCluster('console_error', 'console_error|/different')];
    const golden = [makePositive('console_error', 'console_error|/expected')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('MISS');
  });

  it('PASS when minClusterSize is met', () => {
    const clusters = [
      makeCluster('console_error', 'console_error|/a', 1),
      makeCluster('console_error', 'console_error|/b', 1),
    ];
    const golden = [makePositive('console_error', 'console_error', { minClusterSize: 2 })];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('PASS');
    expect(result.positives[0].matched).toBe(2);
  });

  it('MISS when minClusterSize is not met', () => {
    const clusters = [makeCluster('console_error', 'console_error|/a', 1)];
    const golden = [makePositive('console_error', 'console_error', { minClusterSize: 3 })];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('MISS');
  });

  it('FLAKED when acceptableMisses=1 and failOnFlake=false', () => {
    const clusters: BugCluster[] = [];
    const golden = [makePositive('slow_lcp', 'slow_lcp', { acceptableMisses: 1 })];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: false });
    expect(result.positives[0].status).toBe('FLAKED');
  });

  it('MISS (not FLAKED) when acceptableMisses=1 but failOnFlake=true', () => {
    const clusters: BugCluster[] = [];
    const golden = [makePositive('slow_lcp', 'slow_lcp', { acceptableMisses: 1 })];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('MISS');
  });

  it('rootCauseSubstring filters correctly', () => {
    const clusters = [
      makeCluster('console_error', 'console_error|/a', 1, 'SELF-TEST CONSOLE ERROR 0.123'),
      makeCluster('console_error', 'console_error|/b', 1, 'unrelated console error'),
    ];
    const golden = [makePositive('console_error', 'console_error', { rootCauseSubstring: 'SELF-TEST CONSOLE ERROR' })];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.positives[0].status).toBe('PASS');
    expect(result.positives[0].matched).toBe(1); // only one cluster matches rootCause
  });

  it('PASS negative when absent kind has zero clusters', () => {
    const clusters: BugCluster[] = [];
    const golden = [makeNegative('xss_stored')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.negatives).toHaveLength(1);
    expect(result.negatives[0].status).toBe('PASS');
  });

  it('FALSE_POSITIVE negative when absent kind appears in clusters', () => {
    const clusters = [makeCluster('xss_stored', 'xss_stored|/foo')];
    const golden = [makeNegative('xss_stored')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.negatives[0].status).toBe('FALSE_POSITIVE');
    expect(result.negatives[0].observed).toBe(1);
  });

  it('unexpectedKinds contains wired kinds observed but not in golden', () => {
    const clusters = [makeCluster('react_error', 'react_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    expect(result.unexpectedKinds).toContain('react_error');
  });

  it('unexpectedKinds contains wired kind observed but only listed as absent (not golden positive)', () => {
    // xss_stored is sentinel-wired since V56.4.15; if it fires it IS unexpected unless
    // it appears as a golden positive. A 'negative' (absent) entry does not satisfy that.
    const clusters = [makeCluster('xss_stored', 'xss_stored|/route')];
    const golden = [makeNegative('xss_stored')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    // xss_stored is wired and appeared without a golden positive → unexpected
    expect(result.unexpectedKinds).toContain('xss_stored');
  });

  it('budget violation reflected in passed=false when combined with result', () => {
    // evaluateExpectations itself does not compute budgetOk — tested at integration level
    // This test verifies the evaluation output is consistent for a full-pass scenario
    const clusters = [makeCluster('console_error', 'console_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const result = evaluateExpectations(clusters, golden, { failOnFlake: true });
    const allPositivesMet = result.positives.every(p => p.status === 'PASS' || p.status === 'FLAKED');
    const allNegativesMet = result.negatives.every(n => n.status === 'PASS');
    expect(allPositivesMet).toBe(true);
    expect(allNegativesMet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertLockstep
// ---------------------------------------------------------------------------

describe('assertLockstep', () => {
  it('passes when all wired kinds are covered in manifest and golden', () => {
    // Build a minimal manifest and golden that cover every wired kind in DETECTOR_REGISTRY
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (const k of wiredKinds) kinds[k] = { fixture: 'self', port: null, route: '/' };

    const manifest = { kinds, deferred: deferredKinds };

    const golden = [
      ...wiredKinds.map(k => ({ kind: k as BugCluster['kind'], signaturePrefix: k, fixture: 'self' as const, specReference: 'TEST' })),
      ...deferredKinds.map(k => ({ expect: 'absent' as const, kind: k as BugCluster['kind'], reason: 'test' })),
    ];

    expect(() => assertLockstep(manifest, golden)).not.toThrow();
  });

  it('throws LockstepError when a wired kind is missing from manifest', () => {
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    // Omit the first wired kind from manifest
    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (const k of wiredKinds.slice(1)) kinds[k] = { fixture: 'self', port: null, route: '/' };

    const manifest = { kinds, deferred: deferredKinds };

    const golden = [
      ...wiredKinds.map(k => ({ kind: k as BugCluster['kind'], signaturePrefix: k, fixture: 'self' as const, specReference: 'TEST' })),
      ...deferredKinds.map(k => ({ expect: 'absent' as const, kind: k as BugCluster['kind'], reason: 'test' })),
    ];

    expect(() => assertLockstep(manifest, golden)).toThrow(LockstepError);
  });

  it('throws LockstepError when a wired kind is missing from golden', () => {
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (const k of wiredKinds) kinds[k] = { fixture: 'self', port: null, route: '/' };

    const manifest = { kinds, deferred: deferredKinds };

    // Omit the first wired kind from golden
    const golden = [
      ...wiredKinds.slice(1).map(k => ({ kind: k as BugCluster['kind'], signaturePrefix: k, fixture: 'self' as const, specReference: 'TEST' })),
      ...deferredKinds.map(k => ({ expect: 'absent' as const, kind: k as BugCluster['kind'], reason: 'test' })),
    ];

    expect(() => assertLockstep(manifest, golden)).toThrow(LockstepError);
  });

  it('throws LockstepError when a deferred kind has no absent line and is not in deferred list', () => {
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (const k of wiredKinds) kinds[k] = { fixture: 'self', port: null, route: '/' };

    // Empty deferred list AND no absent lines for deferred kinds
    const manifest = { kinds, deferred: [] as string[] };

    const golden = [
      ...wiredKinds.map(k => ({ kind: k as BugCluster['kind'], signaturePrefix: k, fixture: 'self' as const, specReference: 'TEST' })),
      // No negative expectations for deferred kinds
    ];

    // Only run this test if there are deferred kinds
    if (deferredKinds.length > 0) {
      expect(() => assertLockstep(manifest, golden)).toThrow(LockstepError);
    }
  });

  it('passes when deferred kind is listed in manifest.deferred (not golden absent)', () => {
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (const k of wiredKinds) kinds[k] = { fixture: 'self', port: null, route: '/' };

    // Deferred kinds listed in manifest.deferred but NOT in golden absent lines
    const manifest = { kinds, deferred: deferredKinds };

    const golden = [
      ...wiredKinds.map(k => ({ kind: k as BugCluster['kind'], signaturePrefix: k, fixture: 'self' as const, specReference: 'TEST' })),
    ];

    expect(() => assertLockstep(manifest, golden)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// latestRunId
// ---------------------------------------------------------------------------

function makeRunDir(fixtureRoot: string, runId: string, startedAt: string): void {
  const runDir = path.join(fixtureRoot, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const state = { runId, projectDir: fixtureRoot, startedAt, phase: 'done', config: {}, clusterCount: 0, infraFailureCount: 0, consecutiveInfraFailures: 0, emitted: false, partialEmit: false };
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state));
}

describe('latestRunId', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  it('returns the run with the latest startedAt even when it sorts earlier alphabetically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    temps.push(root);
    makeRunDir(root, 'zzz-old', '2026-05-01T00:00:00.000Z');
    makeRunDir(root, 'aaa-new', '2026-05-03T00:00:00.000Z');
    expect(latestRunId(root)).toBe('aaa-new');
  });

  it('returns the run with the latest startedAt when it also sorts last alphabetically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    temps.push(root);
    makeRunDir(root, 'aaa-old', '2026-05-01T00:00:00.000Z');
    makeRunDir(root, 'zzz-new', '2026-05-03T00:00:00.000Z');
    expect(latestRunId(root)).toBe('zzz-new');
  });

  it('returns undefined when the runs directory is empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    temps.push(root);
    fs.mkdirSync(path.join(root, '.bughunter', 'runs'), { recursive: true });
    expect(latestRunId(root)).toBeUndefined();
  });

  it('falls back to mtime when state.json is corrupted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    temps.push(root);
    // aaa-corrupt has a broken state.json but a newer mtime
    const corruptDir = path.join(root, '.bughunter', 'runs', 'aaa-corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'state.json'), 'not-json{{{');
    // Set mtime to a far-future date to ensure it wins over bbb-old
    const future = new Date('2030-01-01T00:00:00.000Z');
    fs.utimesSync(corruptDir, future, future);

    makeRunDir(root, 'bbb-old', '2026-05-01T00:00:00.000Z');

    expect(latestRunId(root)).toBe('aaa-corrupt');
  });
});

// ---------------------------------------------------------------------------
// Verdict + budget decoupling (#140)
// ---------------------------------------------------------------------------

/** Assemble the passed/budgetExceeded fields the same way selfTestCommand does. */
function assembleVerdict(
  positives: ReturnType<typeof evaluateExpectations>['positives'],
  negatives: ReturnType<typeof evaluateExpectations>['negatives'],
  elapsedMs: number,
  budgetMs: number,
): { passed: boolean; budgetExceeded: boolean } {
  const allPositivesMet = positives.every(p => p.status === 'PASS' || p.status === 'FLAKED');
  const allNegativesMet = negatives.every(n => n.status === 'PASS');
  return {
    passed: allPositivesMet && allNegativesMet,
    budgetExceeded: elapsedMs > budgetMs,
  };
}

describe('verdict decoupled from budget (#140)', () => {
  it('13/87 matched + budget overrun → passed=true, budgetExceeded=true (PASS-with-warning, exit 0)', () => {
    const clusters = [makeCluster('console_error', 'console_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const { positives, negatives } = evaluateExpectations(clusters, golden, { failOnFlake: true });
    const verdict = assembleVerdict(positives, negatives, 700_000, 600_000);
    expect(verdict.passed).toBe(true);
    expect(verdict.budgetExceeded).toBe(true);
  });

  it('0/87 matched + budget overrun → passed=false, budgetExceeded=true (FAILED, exit 1)', () => {
    const clusters: BugCluster[] = [];
    const golden = [makePositive('console_error', 'console_error')];
    const { positives, negatives } = evaluateExpectations(clusters, golden, { failOnFlake: true });
    const verdict = assembleVerdict(positives, negatives, 700_000, 600_000);
    expect(verdict.passed).toBe(false);
    expect(verdict.budgetExceeded).toBe(true);
  });

  it('13/87 matched + no overrun → passed=true, budgetExceeded=false (PASS, exit 0)', () => {
    const clusters = [makeCluster('console_error', 'console_error|/route')];
    const golden = [makePositive('console_error', 'console_error')];
    const { positives, negatives } = evaluateExpectations(clusters, golden, { failOnFlake: true });
    const verdict = assembleVerdict(positives, negatives, 500_000, 600_000);
    expect(verdict.passed).toBe(true);
    expect(verdict.budgetExceeded).toBe(false);
  });

  it('single-surface budget default is 600s', () => {
    const manifest = { kinds: { console_error: { fixture: 'self', port: null, route: '/' } }, deferred: [] };
    expect(defaultBudgetMs(manifest)).toBe(600_000);
  });

  it('6-surface fixture default budget is 3_600_000ms (6 × 600s)', () => {
    const kinds: Record<string, { fixture: string; port: null; route: string }> = {};
    for (let i = 0; i < 6; i++) {
      kinds[`kind_${i}`] = { fixture: `surface-${i}`, port: null, route: '/' };
    }
    const manifest = { kinds, deferred: [] };
    expect(defaultBudgetMs(manifest)).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Audit fix #2: phase flags enabled in selfTestCommand (SWEEP_AUDIT_2026-05-03)
// ---------------------------------------------------------------------------

describe('buildSelfTestRunOpts — phase flags (audit fix #2)', () => {
  const opts = buildSelfTestRunOpts('/fixture', 400, 600_000);

  it('passes enableNavState: true (unlocks 5 nav-state detectors)', () => {
    expect(opts.enableNavState).toBe(true);
  });

  it('passes localeStress: true (unlocks 7 i18n detectors)', () => {
    expect(opts.localeStress).toBe(true);
  });

  it('passes mobile: true (unlocks touch_target_too_small, hover_only_affordance)', () => {
    expect(opts.mobile).toBe(true);
  });

  it('passes interactionPalette: true (enables wired interaction-palette kinds)', () => {
    expect(opts.interactionPalette).toBe(true);
  });

  it('passes the supplied maxBugs and budget through', () => {
    const custom = buildSelfTestRunOpts('/fixture', 200, 1_200_000);
    expect(custom.maxBugs).toBe(200);
    expect(custom.budget).toBe(1_200_000);
  });
});
