import { describe, it, expect } from 'vitest';
import { runCluster } from '../src/phases/cluster.js';
import type { BugDetection, TestCase } from '../src/types.js';

const BASE_OPTS = {
  runId: 'test-run',
  projectDir: '/tmp/test',
  actionLogsDir: '/tmp/test/action-logs',
  screenshotsDir: '/tmp/test/screenshots',
  domDir: '/tmp/test/dom',
  consoleDir: '/tmp/test/console',
  networkDir: '/tmp/test/network',
};

function makeDet(overrides: Partial<BugDetection> = {}): BugDetection {
  return {
    kind: 'network_5xx',
    rootCause: 'Internal Server Error',
    endpoint: 'POST /api/foo',
    status: 500,
    ...overrides,
  };
}

function makeTC(id: string, role = 'owner', page = '/test'): TestCase {
  return {
    id,
    runId: 'test-run',
    role,
    page,
    action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'happy', toolId: 'tool-1' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

describe('runCluster — stop-and-emit at maxClusters', () => {
  it('does not create a 201st cluster; in-flight appends to existing clusters', () => {
    const detections: Array<{ testId: string; detection: BugDetection }> = [];
    const testCases: TestCase[] = [];

    // 200 distinct clusters (different endpoints)
    for (let i = 0; i < 200; i++) {
      const id = `tc-${i}`;
      testCases.push(makeTC(id));
      detections.push({
        testId: id,
        detection: makeDet({ endpoint: `POST /api/endpoint-${i}`, rootCause: `Error ${i}` }),
      });
    }

    // 5 more that would create new clusters — should be dropped
    for (let i = 200; i < 205; i++) {
      const id = `tc-${i}`;
      testCases.push(makeTC(id));
      detections.push({
        testId: id,
        detection: makeDet({ endpoint: `POST /api/endpoint-${i}`, rootCause: `Error ${i}` }),
      });
    }

    // 5 more that match existing cluster 0 (same signature)
    for (let i = 205; i < 210; i++) {
      const id = `tc-${i}`;
      testCases.push(makeTC(id));
      detections.push({
        testId: id,
        detection: makeDet({ endpoint: 'POST /api/endpoint-0', rootCause: 'Error 0' }),
      });
    }

    const { clusters, capped } = runCluster({
      ...BASE_OPTS,
      testCases,
      detections,
      maxClusters: 200,
    });

    expect(clusters.length).toBe(200);
    expect(capped).toBe(true);

    // Cluster 0 should have 6 occurrences (1 original + 5 appended in-flight)
    const cluster0 = clusters.find(c => c.occurrences.some(o => o.role === 'owner'));
    // Find by checking endpoint normalization — first cluster with 6 occurrences
    const bigCluster = clusters.find(c => c.clusterSize > 1);
    expect(bigCluster?.clusterSize).toBe(6);
  });
});

describe('runCluster — full-artifact cap at > 50 occurrences', () => {
  it('only first-3 + last-1 get full artifacts when cluster size > 50', () => {
    const detections: Array<{ testId: string; detection: BugDetection }> = [];
    const testCases: TestCase[] = [];
    const SAME_DETECTION: BugDetection = makeDet({ endpoint: 'POST /api/same', rootCause: 'Same Error' });

    for (let i = 0; i < 60; i++) {
      const id = `tc-${i}`;
      testCases.push(makeTC(id));
      detections.push({ testId: id, detection: { ...SAME_DETECTION } });
    }

    const { clusters } = runCluster({
      ...BASE_OPTS,
      testCases,
      detections,
      maxClusters: 200,
    });

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.clusterSize).toBe(60);

    const fullArtifactOccs = cluster.occurrences.filter(o => o.fullArtifacts);
    expect(fullArtifactOccs.length).toBe(4); // first 3 + last 1

    // First 3 have full artifacts
    expect(cluster.occurrences[0].fullArtifacts).toBe(true);
    expect(cluster.occurrences[1].fullArtifacts).toBe(true);
    expect(cluster.occurrences[2].fullArtifacts).toBe(true);
    // Middle ones do NOT
    expect(cluster.occurrences[3].fullArtifacts).toBe(false);
    // Last one has full artifacts
    expect(cluster.occurrences[59].fullArtifacts).toBe(true);
  });

  it('clusters <= 50 keep all occurrences as full artifacts', () => {
    const detections: Array<{ testId: string; detection: BugDetection }> = [];
    const testCases: TestCase[] = [];

    for (let i = 0; i < 50; i++) {
      const id = `tc-${i}`;
      testCases.push(makeTC(id));
      detections.push({ testId: id, detection: makeDet({ endpoint: 'POST /api/same', rootCause: 'Same Error' }) });
    }

    const { clusters } = runCluster({
      ...BASE_OPTS,
      testCases,
      detections,
      maxClusters: 200,
    });

    const cluster = clusters[0];
    expect(cluster.occurrences.every(o => o.fullArtifacts)).toBe(true);
  });
});
