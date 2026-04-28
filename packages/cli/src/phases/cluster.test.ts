// Tests for cluster phase (v0.5 Gap 3 — stateByTestId warning carve-out).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCluster } from './cluster.js';
import type { ClusterOptions } from './cluster.js';
import type { BugDetection, TestCase } from '../types.js';
import { log } from '../log.js';

function makeDetection(overrides: Partial<BugDetection> = {}): BugDetection {
  return {
    kind: 'missing_csp_header',
    rootCause: 'CSP absent',
    ...overrides,
  };
}

function makeTestCase(id: string, role: string, page = '/test'): TestCase {
  return {
    id,
    runId: 'run-1',
    role,
    page,
    action: { kind: 'render', via: 'api', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function makeClusterOpts(overrides: Partial<ClusterOptions> = {}): ClusterOptions {
  const testId = 'test-id-1';
  const occurrenceId = 'occ-id-1';

  const detection = makeDetection();
  const tc = makeTestCase(testId, 'system');

  return {
    detections: [{ testId, detection }],
    testCases: [tc],
    runId: 'run-1',
    projectDir: '/tmp',
    actionLogsDir: '/tmp/action-logs',
    screenshotsDir: '/tmp/screenshots',
    domDir: '/tmp/dom',
    consoleDir: '/tmp/console',
    networkDir: '/tmp/network',
    maxClusters: 50,
    occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
    stateByTestId: undefined,
    ...overrides,
  };
}

describe('runCluster — stateByTestId warning carve-out', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn');
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT warn when role=system and stateByTestId is undefined', () => {
    const opts = makeClusterOpts();
    // system role, no stateByTestId — synthetic occurrence, no warning expected
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeUndefined();
  });

  it('does NOT warn when role=anonymous and stateByTestId is undefined', () => {
    const testId = 'test-id-anon';
    const occurrenceId = 'occ-id-anon';
    const opts = makeClusterOpts({
      detections: [{ testId, detection: makeDetection({ kind: 'visual_anomaly', rootCause: 'visual issue' }) }],
      testCases: [makeTestCase(testId, 'anonymous')],
      occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
      stateByTestId: undefined,
    });
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeUndefined();
  });

  it('DOES warn when role=owner and stateByTestId lookup misses', () => {
    const testId = 'test-id-owner';
    const occurrenceId = 'occ-id-owner';
    const opts = makeClusterOpts({
      detections: [{ testId, detection: makeDetection({ kind: 'console_error', rootCause: 'err' }) }],
      testCases: [makeTestCase(testId, 'owner')],
      occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
      stateByTestId: new Map(), // empty — lookup will miss
    });
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeDefined();
  });
});
