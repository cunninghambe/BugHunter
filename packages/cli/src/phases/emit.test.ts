import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugCluster, RunState } from '../types.js';

// Mock out the history DB so emit tests don't need a real SQLite DB.
vi.mock('../store/history.js', () => ({
  openHistoryDb: () => ({ close: () => undefined }),
  previousRunForProject: () => undefined,
  clustersForRun: () => [],
  writeRunToHistory: () => undefined,
  historyDbPath: (dir: string) => `${dir}/.bughunter/history.db`,
}));

// Import after mocks are set up.
const { runEmit } = await import('./emit.js');

function makeRunState(tmpDir: string): RunState {
  return {
    runId: 'emit-test-run',
    projectDir: tmpDir,
    startedAt: '2026-04-30T00:00:00.000Z',
    phase: 'emit',
    config: {
      projectName: 'emit-test',
      surfaceMcpUrl: 'http://localhost:3000',
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  } as unknown as RunState;
}

function makeCluster(kind: BugCluster['kind']): BugCluster {
  return {
    id: `cluster-${kind}`,
    kind,
    clusterSize: 1,
    occurrences: [{ role: 'anon', page: '/', actionIndex: 0, detection: { kind, rootCause: 'test' }, id: `occ-${kind}` }],
    rootCause: `test root cause for ${kind}`,
    suspectedFiles: [],
    verdict: 'open',
    bugIdentity: undefined,
  } as unknown as BugCluster;
}

describe('runEmit — coverage.json', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-emit-test-'));
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run'), { recursive: true });
  });

  it('writes coverage.json alongside summary.json', () => {
    const runState = makeRunState(tmpDir);
    const clusters = [makeCluster('console_error'), makeCluster('react_error')];

    runEmit(clusters, [], runState, 1000, 800, undefined);

    const runDir = path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run');
    expect(fs.existsSync(path.join(runDir, 'summary.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'coverage.json'))).toBe(true);
  });

  it('coverage.json has fired entries for the two cluster kinds', () => {
    const runState = makeRunState(tmpDir);
    const clusters = [makeCluster('console_error'), makeCluster('react_error')];

    runEmit(clusters, [], runState, 1000, 800, undefined);

    const coveragePath = path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run', 'coverage.json');
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8')) as { byKind: Record<string, { status: string; clustersEmitted: number }> };

    expect(coverage.byKind['console_error'].status).toBe('fired');
    expect(coverage.byKind['console_error'].clustersEmitted).toBe(1);
    expect(coverage.byKind['react_error'].status).toBe('fired');
    expect(coverage.byKind['react_error'].clustersEmitted).toBe(1);
  });

  it('summary.json is unchanged from pre-V34 schema (no coverage data inside it)', () => {
    const runState = makeRunState(tmpDir);

    runEmit([], [], runState, 1000, 800, undefined);

    const summaryPath = path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run', 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;

    expect(summary).not.toHaveProperty('byKind_coverage');
    expect(summary).not.toHaveProperty('coverage');
    expect(summary).toHaveProperty('bugs_filed');
    expect(summary).toHaveProperty('runId', 'emit-test-run');
  });

  it('bucket counts in coverage.json sum to kindsTotal', () => {
    const runState = makeRunState(tmpDir);

    runEmit([], [], runState, 1000, 800, undefined);

    const coveragePath = path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run', 'coverage.json');
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8')) as {
      summary: { kindsTotal: number; kindsWiredAndFired: number; kindsWiredButInputAbsent: number; kindsDead: number; kindsDeferred: number };
    };
    const { kindsTotal, kindsWiredAndFired, kindsWiredButInputAbsent, kindsDead, kindsDeferred } = coverage.summary;
    expect(kindsWiredAndFired + kindsWiredButInputAbsent + kindsDead + kindsDeferred).toBe(kindsTotal);
  });
});

describe('runEmit — bugs.jsonl severity × confidence sort', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-emit-sort-'));
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run'), { recursive: true });
  });

  function makeClusterWithSeverity(
    kind: string,
    severity: 'critical' | 'major' | 'minor' | 'info' | undefined,
    confidence: 'high' | 'medium' | 'low' | undefined,
    sig: string,
  ): BugCluster {
    return {
      id: `c-${sig}`,
      kind,
      severity,
      confidence,
      signatureKey: sig,
      clusterSize: 1,
      occurrences: [{ role: 'anon', page: '/', actionIndex: 0, detection: { kind, rootCause: 'x' }, id: `o-${sig}` }],
      rootCause: 'x',
      suspectedFiles: [],
      verdict: 'open',
      bugIdentity: undefined,
    } as unknown as BugCluster;
  }

  function readBugsJsonl(): Array<{ kind: string; severity?: string; confidence?: string; signatureKey?: string }> {
    const file = path.join(tmpDir, '.bughunter', 'runs', 'emit-test-run', 'bugs.jsonl');
    return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; severity?: string; confidence?: string; signatureKey?: string });
  }

  it('orders critical > major > minor > info', () => {
    const runState = makeRunState(tmpDir);
    runEmit([
      makeClusterWithSeverity('a', 'info', 'high', 'a'),
      makeClusterWithSeverity('b', 'critical', 'high', 'b'),
      makeClusterWithSeverity('c', 'minor', 'high', 'c'),
      makeClusterWithSeverity('d', 'major', 'high', 'd'),
    ], [], runState, 0, 0, undefined);
    const out = readBugsJsonl();
    expect(out.map(c => c.severity)).toEqual(['critical', 'major', 'minor', 'info']);
  });

  it('breaks ties on confidence: high > medium > low', () => {
    const runState = makeRunState(tmpDir);
    runEmit([
      makeClusterWithSeverity('a', 'critical', 'low', 'a'),
      makeClusterWithSeverity('b', 'critical', 'high', 'b'),
      makeClusterWithSeverity('c', 'critical', 'medium', 'c'),
    ], [], runState, 0, 0, undefined);
    const out = readBugsJsonl();
    expect(out.map(c => c.confidence)).toEqual(['high', 'medium', 'low']);
  });

  it('breaks (severity, confidence) ties on signatureKey ASC for determinism', () => {
    const runState = makeRunState(tmpDir);
    runEmit([
      makeClusterWithSeverity('z', 'major', 'high', 'z-sig'),
      makeClusterWithSeverity('a', 'major', 'high', 'a-sig'),
      makeClusterWithSeverity('m', 'major', 'high', 'm-sig'),
    ], [], runState, 0, 0, undefined);
    const out = readBugsJsonl();
    expect(out.map(c => c.signatureKey)).toEqual(['a-sig', 'm-sig', 'z-sig']);
  });

  it('treats undefined severity as info (lowest) by registry default', () => {
    const runState = makeRunState(tmpDir);
    // missing_csp_header has registry defaultSeverity 'major'; xss_reflected 'critical'.
    runEmit([
      makeClusterWithSeverity('xss_reflected', undefined, 'high', 'b'),
      makeClusterWithSeverity('missing_csp_header', undefined, 'high', 'a'),
    ], [], runState, 0, 0, undefined);
    const out = readBugsJsonl();
    // xss_reflected (critical from registry) should come before missing_csp_header (major).
    expect(out[0]?.kind).toBe('xss_reflected');
    expect(out[1]?.kind).toBe('missing_csp_header');
  });

  it('orders by combined criteria across all three keys', () => {
    const runState = makeRunState(tmpDir);
    runEmit([
      makeClusterWithSeverity('a', 'info',    'high',   'a'),
      makeClusterWithSeverity('b', 'critical','low',    'b'),
      makeClusterWithSeverity('c', 'critical','high',   'c'),
      makeClusterWithSeverity('d', 'major',   'medium', 'd'),
      makeClusterWithSeverity('e', 'major',   'medium', 'a-z'),
    ], [], runState, 0, 0, undefined);
    const out = readBugsJsonl();
    // critical-high(c) > critical-low(b) > major-medium with a-z < d > info-high(a)
    expect(out.map(c => c.kind)).toEqual(['c', 'b', 'e', 'd', 'a']);
  });
});
