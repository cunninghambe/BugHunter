import { describe, it, expect } from 'vitest';
import { runCluster } from '../src/phases/cluster.js';
import type { BugDetection, TestCase } from '../src/types.js';
import { createId } from '@paralleldrive/cuid2';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTmpDir(): string {
  return os.tmpdir();
}

function makeOpts(detections: Array<{ testId: string; detection: BugDetection }>, testCases: TestCase[]) {
  const tmpDir = makeTmpDir();
  const runId = 'test-run';
  return {
    detections,
    testCases,
    runId,
    projectDir: tmpDir,
    actionLogsDir: path.join(tmpDir, 'action-logs'),
    screenshotsDir: path.join(tmpDir, 'screenshots'),
    domDir: path.join(tmpDir, 'dom'),
    consoleDir: path.join(tmpDir, 'console'),
    networkDir: path.join(tmpDir, 'network'),
    maxClusters: 200,
  };
}

function makeTestCase(runId: string, toolId: string): TestCase {
  return {
    id: createId(),
    runId,
    role: 'owner',
    page: '/test',
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'success',
      palette: 'happy',
      toolId,
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

describe('runCluster — annotateRelatedClusters (§7)', () => {
  it('links 404_for_linked_route and surface_call_failed sharing a normalized route', () => {
    const runId = 'test-run';
    const tc = makeTestCase(runId, 'tool-xyz');
    tc.id = 'tc-1';

    const det404: BugDetection = {
      kind: '404_for_linked_route',
      rootCause: 'Page links to /api/x/123/y which returned 404',
      targetPath: '/api/x/123/y',
    };
    const detFailed: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 400 for tool tool-xyz',
      // endpoint uses method + normalized path (set by execute.ts §7.5)
      endpoint: 'POST /api/x/:id/y',
      status: 400,
    };

    const { clusters } = runCluster(makeOpts(
      [
        { testId: 'tc-1', detection: det404 },
        { testId: 'tc-1', detection: detFailed },
      ],
      [tc]
    ));

    expect(clusters.length).toBe(2);
    const cluster404 = clusters.find(c => c.kind === '404_for_linked_route');
    const clusterFailed = clusters.find(c => c.kind === 'surface_call_failed');

    expect(cluster404?.relatedClusterIds).toContain(clusterFailed?.id);
    expect(clusterFailed?.relatedClusterIds).toContain(cluster404?.id);
  });

  it('isolated 404_for_linked_route has relatedClusterIds undefined', () => {
    const runId = 'test-run';
    const tc = makeTestCase(runId, 'tool-xyz');

    const det404: BugDetection = {
      kind: '404_for_linked_route',
      rootCause: 'Page links to /api/no-match which returned 404',
      targetPath: '/api/no-match',
    };

    const { clusters } = runCluster(makeOpts(
      [{ testId: tc.id, detection: det404 }],
      [tc]
    ));

    expect(clusters.length).toBe(1);
    expect(clusters[0]?.relatedClusterIds).toBeUndefined();
  });

  it('two surface_call_failed clusters with different paths do NOT link', () => {
    const runId = 'test-run';
    const tc = makeTestCase(runId, 'tool-a');

    const det1: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 400 for tool tool-a',
      endpoint: 'POST /api/x/:id',
      status: 400,
    };
    const det2: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 400 for tool tool-a',
      endpoint: 'POST /api/y/:id',
      status: 400,
    };

    const { clusters } = runCluster(makeOpts(
      [
        { testId: tc.id, detection: det1 },
        { testId: tc.id, detection: det2 },
      ],
      [tc]
    ));

    expect(clusters.length).toBe(2);
    for (const c of clusters) {
      expect(c.relatedClusterIds).toBeUndefined();
    }
  });

  it('multiple clusters sharing a path get mutual links across all of them', () => {
    const runId = 'test-run';
    const tc = makeTestCase(runId, 'tool-z');

    const det404: BugDetection = {
      kind: '404_for_linked_route',
      rootCause: 'Page links to /api/z/99 which returned 404',
      targetPath: '/api/z/99',
    };
    const detFailed1: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 400 for tool tool-z',
      endpoint: 'POST /api/z/:id',
      status: 400,
    };
    const detFailed2: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 422 for tool tool-z',
      endpoint: 'PUT /api/z/:id',
      status: 422,
    };

    const { clusters } = runCluster(makeOpts(
      [
        { testId: tc.id, detection: det404 },
        { testId: tc.id, detection: detFailed1 },
        { testId: tc.id, detection: detFailed2 },
      ],
      [tc]
    ));

    const cluster404 = clusters.find(c => c.kind === '404_for_linked_route');
    const failedClusters = clusters.filter(c => c.kind === 'surface_call_failed');

    expect(failedClusters.length).toBe(2);

    // 404 should link to both surface_call_failed clusters
    for (const failed of failedClusters) {
      expect(cluster404?.relatedClusterIds).toContain(failed.id);
      expect(failed.relatedClusterIds).toContain(cluster404?.id);
    }
  });
});
