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

  it('links via toolId regardless of rootCause/endpoint shape (smoke shapes verbatim)', () => {
    // Exact shapes from the qhh5qba24hjqgrtvay27hcdh smoke run:
    // cluster qb0cldg1... kind=404_for_linked_route, rootCause has bare toolId "0928801337a9"
    // cluster cw6rx3ri... kind=surface_call_failed, rootCause has bare toolId "0928801337a9"
    // Both occurrences carry action.toolId = '0928801337a9' → Option C links them.
    const runId = 'smoke-test-run';
    const toolId = '0928801337a9';
    const tc = makeTestCase(runId, toolId);

    const det404: BugDetection = {
      kind: '404_for_linked_route',
      rootCause: `Page links to ${toolId} which returned 404`,
      targetPath: toolId,
    };
    const detFailed: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: `surface_call failed with status 404 for tool ${toolId}`,
      endpoint: toolId, // bare toolId — no METHOD or path prefix
      status: 404,
    };

    const { clusters } = runCluster(makeOpts(
      [
        { testId: tc.id, detection: det404 },
        { testId: tc.id, detection: detFailed },
      ],
      [tc]
    ));

    expect(clusters.length).toBe(2);
    const cluster404 = clusters.find(c => c.kind === '404_for_linked_route');
    const clusterFailed = clusters.find(c => c.kind === 'surface_call_failed');

    expect(cluster404?.relatedClusterIds).toContain(clusterFailed?.id);
    expect(clusterFailed?.relatedClusterIds).toContain(cluster404?.id);
  });

  it('UI-only 404 without toolId on occurrence falls back to path extraction', () => {
    const runId = 'test-run';
    // This TC has a toolId 'tool-xyz' but the detection has no direct toolId
    // The 404 occurrence's action won't have toolId in the cluster (UI walker generates a synthetic toolId-less action)
    const tc: TestCase = {
      id: createId(),
      runId,
      role: 'anonymous',
      page: '/products',
      action: {
        kind: 'navigate',
        via: 'ui',
        expectedOutcome: 'unknown',
        palette: 'happy',
        // No toolId — UI walker path
      },
      expectedOutcome: 'unknown',
      palette: 'happy',
    };

    const det404: BugDetection = {
      kind: '404_for_linked_route',
      rootCause: 'Page links to /api/x/:id which returned 404',
      targetPath: '/api/x/123',
    };
    const detFailed: BugDetection = {
      kind: 'surface_call_failed',
      rootCause: 'surface_call failed with status 404 for tool tool-xyz',
      endpoint: 'POST /api/x/:id',
      status: 404,
    };

    // The 404 has no toolId on action (UI-walker) → falls back to path key
    // The surface_call_failed has NO occurrence toolId either (tc.action.toolId is undefined)
    // → also falls back — but extractEndpointFromFixHints is deleted so it returns null
    // Under Option C: surface_call_failed with no toolId returns null → no link
    const { clusters } = runCluster(makeOpts(
      [
        { testId: tc.id, detection: det404 },
        { testId: tc.id, detection: detFailed },
      ],
      [tc]
    ));

    expect(clusters.length).toBe(2);
    // No link: 404 has path key but surface_call_failed has null key (no toolId, extractEndpointFromFixHints deleted)
    const cluster404 = clusters.find(c => c.kind === '404_for_linked_route');
    expect(cluster404?.relatedClusterIds).toBeUndefined();
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
