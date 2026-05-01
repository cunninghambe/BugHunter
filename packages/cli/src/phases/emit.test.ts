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
