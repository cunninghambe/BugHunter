import { describe, it, expect } from 'vitest';
import { clusterSignature, normalizeVisualDescription } from '../src/cluster/signature.js';
import { normalizeErrorMessage, fingerprintStackTrace } from '../src/cluster/normalize.js';
import { runCluster } from '../src/phases/cluster.js';
import type { BugDetection, TestCase, PreState, PostState } from '../src/types.js';
import stackFixture from '../../../fixtures/stack-trace-clustering/stacks.json' with { type: 'json' };
import { createId } from '@paralleldrive/cuid2';
import * as os from 'node:os';
import * as path from 'node:path';

describe('normalizeErrorMessage', () => {
  it('lowercases and strips numeric ids (4+ digits)', () => {
    const result = normalizeErrorMessage('Error: Failed to fetch from /api/orders/12345');
    expect(result).toBe('error: failed to fetch from /api/orders/<num>');
  });

  it('strips UUIDs', () => {
    const result = normalizeErrorMessage('Missing resource: 550e8400-e29b-41d4-a716-446655440000');
    expect(result).toContain('<id>');
    expect(result).not.toContain('550e8400');
  });

  it('strips hex SHA1 (40 chars)', () => {
    const sha = 'a'.repeat(40);
    const result = normalizeErrorMessage(`Commit ${sha} not found`);
    expect(result).toContain('<id>');
  });

  it('strips double-quoted strings', () => {
    const result = normalizeErrorMessage('Cannot read "productName" property');
    expect(result).toContain('<str>');
    expect(result).not.toContain('productName');
  });

  it('strips single-quoted strings', () => {
    const result = normalizeErrorMessage("Cannot read 'map' property");
    expect(result).toContain('<str>');
  });

  it('truncates to 80 chars', () => {
    const result = normalizeErrorMessage('a'.repeat(200));
    expect(result).toHaveLength(80);
  });
});

describe('fingerprintStackTrace', () => {
  it('strips line and column numbers', () => {
    const stack = 'Error\n    at foo (src/foo.ts:42:5)\n    at bar (src/bar.ts:10:1)';
    const result = fingerprintStackTrace(stack);
    expect(result).not.toMatch(/:\d+/);
  });

  it('filters out node_modules frames', () => {
    const stack = [
      'Error',
      '    at myFunc (src/myFunc.ts:10:5)',
      '    at node_modules/react/index.js:42:3',
      '    at webpack-internal:///./src/index.ts:1:1',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    expect(result).toContain('myFunc');
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('webpack-internal');
  });

  it('takes at most 3 user-code frames', () => {
    const stack = [
      'Error',
      '    at func1 (src/a.ts:1:1)',
      '    at func2 (src/b.ts:2:2)',
      '    at func3 (src/c.ts:3:3)',
      '    at func4 (src/d.ts:4:4)',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    const frames = result.split('|').filter(Boolean);
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it('uses | separator', () => {
    const stack = [
      'Error',
      '    at func1 (src/a.ts:1:1)',
      '    at func2 (src/b.ts:2:2)',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    expect(result).toContain('|');
  });
});

describe('cluster signature — 10 known stacks → 3 clusters', () => {
  it('groups correctly per fixture', () => {
    const signatures = new Map<string, string>();

    for (const stack of stackFixture.stacks) {
      const detection: BugDetection = {
        kind: 'console_error',
        rootCause: stack.message,
        stackTrace: stack.stack,
      };
      const sig = clusterSignature(detection);
      signatures.set(stack.id, sig);
    }

    // Group by signature
    const groups = new Map<string, string[]>();
    for (const [id, sig] of signatures) {
      const stackData = stackFixture.stacks.find((s: { id: string; expectedCluster: string }) => s.id === id)!;
      const cluster = stackData.expectedCluster;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig)!.push(cluster);
    }

    // All items in the same signature group should have the same expectedCluster
    for (const [sig, clusters] of groups) {
      const first = clusters[0];
      expect(clusters.every(c => c === first)).toBe(true);
    }

    // Should produce exactly 3 distinct signatures
    expect(groups.size).toBe(stackFixture.expectedClusterCount);
  });
});

describe('postState plumbing — mutationObserverWindowMs flows into OccurrenceFull', () => {
  it('uses stateByTestId to populate postState on upgraded occurrences', () => {
    const tmpDir = os.tmpdir();
    const runId = 'test-run';
    const testId = createId();

    const tc: TestCase = {
      id: testId,
      runId,
      role: 'owner',
      page: '/dom-test',
      action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: '[data-testid="toggle"]' },
      expectedOutcome: 'success',
      palette: 'happy',
    };

    const detection: BugDetection = {
      kind: 'missing_state_change',
      rootCause: "Action 'click' on '[data-testid=\"toggle\"]' produced no observable state change",
      pageRoute: '/dom-test',
    };

    const preState: PreState = { url: '/dom-test', title: 'DOM Test', consoleErrorCount: 0 };
    const postState: PostState = {
      url: '/dom-test',
      title: 'DOM Test',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 1234,
    };

    const stateByTestId = new Map([[testId, { preState, postState }]]);

    const { clusters } = runCluster({
      detections: [{ testId, detection }],
      testCases: [tc],
      runId,
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'action-logs'),
      screenshotsDir: path.join(tmpDir, 'screenshots'),
      domDir: path.join(tmpDir, 'dom'),
      consoleDir: path.join(tmpDir, 'console'),
      networkDir: path.join(tmpDir, 'network'),
      maxClusters: 200,
      occurrenceIdByTestId: new Map([[testId, testId]]),
      stateByTestId,
    });

    expect(clusters.length).toBe(1);
    const occ = clusters[0]!.occurrences[0]!;
    // First occurrence always gets full artifacts
    expect(occ.fullArtifacts).toBe(true);
    if (occ.fullArtifacts) {
      expect(occ.postState.mutationObserverWindowMs).toBe(1234);
      expect(occ.testId).toBe(testId);
    }
  });

  it('falls back to empty PostState when stateByTestId is absent (backward-compat)', () => {
    const tmpDir = os.tmpdir();
    const runId = 'test-run';
    const testId = createId();

    const tc: TestCase = {
      id: testId,
      runId,
      role: 'owner',
      page: '/page',
      action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
      expectedOutcome: 'success',
      palette: 'happy',
    };

    const detection: BugDetection = {
      kind: 'console_error',
      rootCause: 'Something broke',
      pageRoute: '/page',
    };

    const { clusters } = runCluster({
      detections: [{ testId, detection }],
      testCases: [tc],
      runId,
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'action-logs'),
      screenshotsDir: path.join(tmpDir, 'screenshots'),
      domDir: path.join(tmpDir, 'dom'),
      consoleDir: path.join(tmpDir, 'console'),
      networkDir: path.join(tmpDir, 'network'),
      maxClusters: 200,
      occurrenceIdByTestId: new Map([[testId, testId]]),
      // stateByTestId intentionally omitted
    });

    expect(clusters.length).toBe(1);
    const occ = clusters[0]!.occurrences[0]!;
    expect(occ.fullArtifacts).toBe(true);
    if (occ.fullArtifacts) {
      expect(occ.postState.mutationObserverWindowMs).toBe(0);
    }
  });
});

describe('occurrenceIdByTestId plumbing', () => {
  const tmpDir = os.tmpdir();
  const runId = 'r1';

  const SOME_BUG: BugDetection = {
    kind: 'missing_state_change',
    rootCause: "Action 'click' produced no observable state change",
    pageRoute: '/test',
  };

  const TEST_CASE_T1: TestCase = {
    id: 't1',
    runId,
    role: 'owner',
    page: '/test',
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: 'button' },
    expectedOutcome: 'success',
    palette: 'happy',
  };

  it('reuses executor-minted occurrenceId from occurrenceIdByTestId', () => {
    const result = runCluster({
      detections: [{ testId: 't1', detection: SOME_BUG }],
      testCases: [TEST_CASE_T1],
      runId,
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'al'),
      screenshotsDir: path.join(tmpDir, 's'),
      domDir: path.join(tmpDir, 'd'),
      consoleDir: path.join(tmpDir, 'c'),
      networkDir: path.join(tmpDir, 'n'),
      maxClusters: 100,
      occurrenceIdByTestId: new Map([['t1', 'exec-occ-1']]),
    });
    expect(result.clusters[0]!.occurrences[0]!.occurrenceId).toBe('exec-occ-1');
  });

  it('throws when occurrenceIdByTestId is missing an entry', () => {
    expect(() => runCluster({
      detections: [{ testId: 't1', detection: SOME_BUG }],
      testCases: [TEST_CASE_T1],
      runId,
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'al'),
      screenshotsDir: path.join(tmpDir, 's'),
      domDir: path.join(tmpDir, 'd'),
      consoleDir: path.join(tmpDir, 'c'),
      networkDir: path.join(tmpDir, 'n'),
      maxClusters: 100,
      occurrenceIdByTestId: new Map(),
    })).toThrow(/missing occurrenceId for testId/);
  });
});

describe('cluster signature — different kinds produce different signatures', () => {
  it('network_5xx keyed by endpoint+status', () => {
    const d1: BugDetection = { kind: 'network_5xx', rootCause: 'x', endpoint: 'POST /api/foo', status: 500 };
    const d2: BugDetection = { kind: 'network_5xx', rootCause: 'y', endpoint: 'POST /api/foo', status: 500 };
    const d3: BugDetection = { kind: 'network_5xx', rootCause: 'z', endpoint: 'GET /api/bar', status: 503 };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d3));
  });

  it('404_for_linked_route keyed by targetPath', () => {
    const d1: BugDetection = { kind: '404_for_linked_route', rootCause: 'x', targetPath: '/missing' };
    const d2: BugDetection = { kind: '404_for_linked_route', rootCause: 'y', targetPath: '/missing' };
    const d3: BugDetection = { kind: '404_for_linked_route', rootCause: 'z', targetPath: '/other' };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d3));
  });
});

describe('visual_anomaly cluster signature (§ 10.3)', () => {
  it('case 1: two visuals with same category and same first-8-words produce equal signature', () => {
    const d1: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'sidebar rendered on top of main content completely',
      visualCategory: 'layout',
    };
    const d2: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'sidebar rendered on top of main content completely',
      visualCategory: 'layout',
    };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
  });

  it('case 2: route path in description stripped → same signature across pages', () => {
    const d1: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'the trades table area on /dashboard is blank',
      visualCategory: 'state',
    };
    const d2: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'the trades table area on /trades is blank',
      visualCategory: 'state',
    };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
  });

  it('case 3: same description but different category → distinct signatures', () => {
    const d1: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'broken layout in sidebar',
      visualCategory: 'layout',
    };
    const d2: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'broken layout in sidebar',
      visualCategory: 'error',
    };
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d2));
  });

  it('case 4: runCluster clusters 5 visual detections with same root cause into one cluster of size 5', () => {
    const tmpDir = os.tmpdir();
    const runId = 'vis-run';

    const detections: Array<{ testId: string; detection: BugDetection }> = [];
    const testCases: TestCase[] = [];
    const occurrenceIdByTestId = new Map<string, string>();

    for (let i = 0; i < 5; i++) {
      const testId = createId();
      const occId = createId();
      testCases.push({
        id: testId,
        runId,
        role: 'owner',
        page: `/page-${i}`,
        action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
        expectedOutcome: 'success',
        palette: 'happy',
      });
      detections.push({
        testId,
        detection: {
          kind: 'visual_anomaly',
          rootCause: `the trades table: broken sidebar in main area`,
          visualCategory: 'layout',
          visualSeverity: 'critical',
        },
      });
      occurrenceIdByTestId.set(testId, occId);
    }

    const { clusters } = runCluster({
      detections,
      testCases,
      runId,
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'al'),
      screenshotsDir: path.join(tmpDir, 's'),
      domDir: path.join(tmpDir, 'd'),
      consoleDir: path.join(tmpDir, 'c'),
      networkDir: path.join(tmpDir, 'n'),
      maxClusters: 200,
      occurrenceIdByTestId,
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind).toBe('visual_anomaly');
    expect(clusters[0]!.clusterSize).toBe(5);
  });

  it('case 5: generateFixHints includes description, screenshot path, and suggestedFix', () => {
    const tmpDir = os.tmpdir();
    const testId = createId();
    const occId = createId();

    const detection: BugDetection = {
      kind: 'visual_anomaly',
      rootCause: 'Sidebar obscures content',
      visualCategory: 'layout',
      visualSeverity: 'critical',
      screenshotPath: '/tmp/screenshot.png',
      visualSuggestedFix: 'Check z-index.',
    };

    const { clusters } = runCluster({
      detections: [{ testId, detection }],
      testCases: [{
        id: testId,
        runId: 'r1',
        role: 'owner',
        page: '/dashboard',
        action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
        expectedOutcome: 'success',
        palette: 'happy',
      }],
      runId: 'r1',
      projectDir: tmpDir,
      actionLogsDir: path.join(tmpDir, 'al'),
      screenshotsDir: path.join(tmpDir, 's'),
      domDir: path.join(tmpDir, 'd'),
      consoleDir: path.join(tmpDir, 'c'),
      networkDir: path.join(tmpDir, 'n'),
      maxClusters: 200,
      occurrenceIdByTestId: new Map([[testId, occId]]),
    });

    expect(clusters).toHaveLength(1);
    const hint = clusters[0]!.fixHints[0]!;
    expect(hint).toContain('Sidebar obscures content');
    expect(hint).toContain('/tmp/screenshot.png');
    expect(hint).toContain('Check z-index.');
  });
});

describe('normalizeVisualDescription', () => {
  it('strips route paths from description', () => {
    const a = normalizeVisualDescription('blank area on /dashboard is empty');
    const b = normalizeVisualDescription('blank area on /trades is empty');
    expect(a).toBe(b);
  });

  it('takes first 8 words only', () => {
    const result = normalizeVisualDescription('one two three four five six seven eight nine ten');
    expect(result.split('-')).toHaveLength(8);
  });

  it('lowercases', () => {
    const result = normalizeVisualDescription('BROKEN SIDEBAR');
    expect(result).toBe('broken-sidebar');
  });
});
