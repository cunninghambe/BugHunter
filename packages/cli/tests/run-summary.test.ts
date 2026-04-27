import { describe, it, expect, vi } from 'vitest';
import type { RunState, TestCase, BugHunterConfig } from '../src/types.js';
import { runEmit } from '../src/phases/emit.js';
import { runPaths } from '../src/store/filesystem.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createId } from '@paralleldrive/cuid2';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bh-run-summary-'));
}

function makeRunState(projectDir: string, runId: string): RunState {
  const config: BugHunterConfig = {
    projectName: 'test',
    surfaceMcpUrl: 'http://127.0.0.1:3102',
  };
  return {
    runId,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'emit',
    config,
    testCases: [],
    testResults: [],
    clusters: [],
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeApiTestCase(runId: string): TestCase {
  return {
    id: createId(),
    runId,
    role: 'owner',
    page: '/api/test',
    action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'happy', toolId: 'test-tool' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function makeUiTestCase(runId: string): TestCase {
  return {
    id: createId(),
    runId,
    role: 'owner',
    page: '/products',
    action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

describe('runEmit — planned/ran/skipped counters (§9)', () => {
  it('summary.json contains testsPlanned, testsRan, testsSkipped, skippedReasons', () => {
    const tmpDir = makeTmpDir();
    const runId = createId();
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', runId), { recursive: true });

    const runState = makeRunState(tmpDir, runId);
    const apiCases = [makeApiTestCase(runId), makeApiTestCase(runId)];
    const uiCases = [makeUiTestCase(runId), makeUiTestCase(runId)];
    runState.testCases = [...apiCases, ...uiCases];

    const skipReasons = [{ reason: 'no browserMcpUrl configured', count: 2 }];

    runEmit([], [], runState, 10000, 5000, {
      testsPlanned: 4,
      testsRan: 2,
      testsSkipped: 2,
      skipReasons,
    });

    const paths = runPaths(tmpDir, runId);
    const summary = JSON.parse(fs.readFileSync(paths.summaryFile, 'utf-8')) as Record<string, unknown>;

    expect(summary['testsPlanned']).toBe(4);
    expect(summary['testsRan']).toBe(2);
    expect(summary['testsSkipped']).toBe(2);
    expect(Array.isArray(summary['skippedReasons'])).toBe(true);
    const reasons = summary['skippedReasons'] as Array<{ reason: string; count: number }>;
    expect(reasons[0]?.reason).toBe('no browserMcpUrl configured');
    expect(reasons[0]?.count).toBe(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stdout contains Tests: N planned, M ran, K skipped line', () => {
    const tmpDir = makeTmpDir();
    const runId = createId();
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', runId), { recursive: true });

    const runState = makeRunState(tmpDir, runId);
    runState.testCases = [makeApiTestCase(runId), makeUiTestCase(runId)];

    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      runEmit([], [], runState, 10000, 5000, {
        testsPlanned: 2,
        testsRan: 1,
        testsSkipped: 1,
        skipReasons: [{ reason: 'no browserMcpUrl configured', count: 1 }],
      });
    } finally {
      vi.restoreAllMocks();
    }

    const stdout = stdoutChunks.join('');
    expect(stdout).toMatch(/Tests: 2 planned, 1 ran, 1 skipped/);
    expect(stdout).toMatch(/Skipped: no browserMcpUrl configured \(1\)/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('summary.json has zero skipped when all tests ran', () => {
    const tmpDir = makeTmpDir();
    const runId = createId();
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', runId), { recursive: true });

    const runState = makeRunState(tmpDir, runId);
    runState.testCases = [makeApiTestCase(runId)];

    runEmit([], [], runState, 10000, 5000, {
      testsPlanned: 1,
      testsRan: 1,
      testsSkipped: 0,
      skipReasons: [],
    });

    const paths = runPaths(tmpDir, runId);
    const summary = JSON.parse(fs.readFileSync(paths.summaryFile, 'utf-8')) as Record<string, unknown>;
    expect(summary['testsSkipped']).toBe(0);
    expect(summary['skippedReasons']).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
