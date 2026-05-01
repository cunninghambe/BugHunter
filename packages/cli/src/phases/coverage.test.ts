import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deriveStatus, inputObservedByKind, buildCoverage } from './coverage.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import { writeJsonFile } from '../store/filesystem.js';
import type { RunState } from '../types.js';
import type { BugCluster } from '../types.js';

function minimalRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'test-run',
    projectDir: '/tmp/test',
    startedAt: '2026-04-30T00:00:00.000Z',
    phase: 'emit',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3000',
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
    ...overrides,
  } as RunState;
}

describe('deriveStatus', () => {
  it('returns detector-deferred when deferred=true regardless of other inputs', () => {
    expect(deriveStatus(true, true, true, 5)).toBe('detector-deferred');
    expect(deriveStatus(false, true, false, 0)).toBe('detector-deferred');
  });

  it('returns detector-dead when wired=false (and not deferred)', () => {
    expect(deriveStatus(false, false, false, 0)).toBe('detector-dead');
    expect(deriveStatus(false, false, true, 0)).toBe('detector-dead');
  });

  it('returns fired when wired && clustersEmitted > 0', () => {
    expect(deriveStatus(true, false, false, 1)).toBe('fired');
    expect(deriveStatus(true, false, true, 3)).toBe('fired');
  });

  it('returns fired when wired && inputObserved && clustersEmitted === 0 (clean bill)', () => {
    expect(deriveStatus(true, false, true, 0)).toBe('fired');
  });

  it('returns input-absent when wired && !inputObserved && clustersEmitted === 0', () => {
    expect(deriveStatus(true, false, false, 0)).toBe('input-absent');
  });
});

describe('inputObservedByKind', () => {
  it('maps perf-disabled config to false for all perf kinds', () => {
    const runState = minimalRunState({ config: { projectName: 'test', surfaceMcpUrl: 'http://localhost', perf: { enabled: false } } });
    const observed = inputObservedByKind(runState, undefined);
    expect(observed['slow_lcp']).toBe(false);
    expect(observed['excessive_re_renders']).toBe(false);
    expect(observed['memory_leak_attributed']).toBe(false);
    expect(observed['main_thread_blocked']).toBe(false);
  });

  it('maps perf-enabled config with perfSummary to true for perf kinds', () => {
    const runState = minimalRunState({ config: { projectName: 'test', surfaceMcpUrl: 'http://localhost', perf: { enabled: true } } });
    const counters = { perfSummary: { vitalsByPage: {}, longestTaskMs: 0, totalNetworkRequests: 0 } };
    const observed = inputObservedByKind(runState, counters);
    expect(observed['slow_lcp']).toBe(true);
    expect(observed['excessive_re_renders']).toBe(true);
  });

  it('maps vision called > 0 to true for visual_anomaly', () => {
    const runState = minimalRunState();
    const counters = { vision: { enabled: true, called: 3, succeeded: 3, anomaliesFound: 0 } };
    const observed = inputObservedByKind(runState, counters);
    expect(observed['visual_anomaly']).toBe(true);
  });

  it('maps vision called === 0 to false for visual_anomaly', () => {
    const runState = minimalRunState();
    const counters = { vision: { enabled: true, called: 0, succeeded: 0, anomaliesFound: 0 } };
    const observed = inputObservedByKind(runState, counters);
    expect(observed['visual_anomaly']).toBe(false);
  });

  it('maps raceConditions present to true for race kinds', () => {
    const runState = minimalRunState();
    const counters = { raceConditions: { testsRun: 5, detections: 0 } };
    const observed = inputObservedByKind(runState, counters);
    expect(observed['race_condition_double_submit']).toBe(true);
    expect(observed['race_condition_cross_tab']).toBe(true);
  });

  it('maps raceConditions absent to false for race kinds', () => {
    const runState = minimalRunState();
    const observed = inputObservedByKind(runState, undefined);
    expect(observed['race_condition_double_submit']).toBe(false);
  });

  it('maps seoEnabled to true for seo kinds', () => {
    const runState = minimalRunState({ config: { projectName: 'test', surfaceMcpUrl: 'http://localhost', seoEnabled: true } });
    const observed = inputObservedByKind(runState, undefined);
    expect(observed['seo_title_missing']).toBe(true);
    expect(observed['seo_robots_blocking_crawl']).toBe(true);
  });

  it('maps seoEnabled absent to false for seo kinds', () => {
    const runState = minimalRunState();
    const observed = inputObservedByKind(runState, undefined);
    expect(observed['seo_title_missing']).toBe(false);
  });

  it('covers every BugKind in the registry', () => {
    const runState = minimalRunState();
    const observed = inputObservedByKind(runState, undefined);
    for (const entry of DETECTOR_REGISTRY) {
      expect(observed).toHaveProperty(entry.kind);
    }
  });
});

describe('buildCoverage', () => {
  it('summary bucket counts add up to kindsTotal (sum invariant)', () => {
    const runState = minimalRunState();
    const coverage = buildCoverage('run1', '2026-04-30T00:00:00.000Z', runState, [], undefined);
    const { kindsWiredAndFired, kindsWiredButInputAbsent, kindsDead, kindsDeferred, kindsTotal } = coverage.summary;
    expect(kindsWiredAndFired + kindsWiredButInputAbsent + kindsDead + kindsDeferred).toBe(kindsTotal);
    expect(kindsTotal).toBe(DETECTOR_REGISTRY.length);
  });

  it('byKind has exactly one entry per registered kind', () => {
    const runState = minimalRunState();
    const coverage = buildCoverage('run1', '2026-04-30T00:00:00.000Z', runState, [], undefined);
    expect(Object.keys(coverage.byKind).length).toBe(DETECTOR_REGISTRY.length);
    for (const entry of DETECTOR_REGISTRY) {
      expect(coverage.byKind).toHaveProperty(entry.kind);
    }
  });

  it('cluster kinds appear as fired in byKind', () => {
    const runState = minimalRunState({ testResults: [{ preState: {} } as never] });
    const clusters: BugCluster[] = [
      { id: 'c1', kind: 'console_error', clusterSize: 1, occurrences: [], rootCause: 'test', suspectedFiles: [], verdict: 'open', bugIdentity: undefined } as unknown as BugCluster,
    ];
    const coverage = buildCoverage('run1', '2026-04-30T00:00:00.000Z', runState, clusters, undefined);
    expect(coverage.byKind['console_error'].status).toBe('fired');
    expect(coverage.byKind['console_error'].clustersEmitted).toBe(1);
  });

  it('deferred kinds have status detector-deferred', () => {
    const runState = minimalRunState();
    const coverage = buildCoverage('run1', '2026-04-30T00:00:00.000Z', runState, [], undefined);
    const deferredEntry = DETECTOR_REGISTRY.find(e => e.status === 'deferred');
    if (deferredEntry !== undefined) {
      expect(coverage.byKind[deferredEntry.kind].status).toBe('detector-deferred');
    }
  });

  it('version is 1 and runId matches', () => {
    const runState = minimalRunState();
    const coverage = buildCoverage('my-run-id', '2026-04-30T00:00:00.000Z', runState, [], undefined);
    expect(coverage.version).toBe(1);
    expect(coverage.runId).toBe('my-run-id');
  });

  it('round-trip: write to disk, read back, assert equality', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cov-test-'));
    const filePath = path.join(tmpDir, 'coverage.json');
    try {
      const runState = minimalRunState();
      const coverage = buildCoverage('rt-run', '2026-04-30T00:00:00.000Z', runState, [], undefined);
      writeJsonFile(filePath, coverage);
      const loaded = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as typeof coverage;
      expect(loaded.version).toBe(1);
      expect(loaded.runId).toBe(coverage.runId);
      expect(loaded.summary.kindsTotal).toBe(coverage.summary.kindsTotal);
      expect(Object.keys(loaded.byKind).length).toBe(Object.keys(coverage.byKind).length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
