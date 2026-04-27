import { describe, it, expect } from 'vitest';
import { runClassify } from '../src/phases/classify.js';
import type { TestResult, BugDetection } from '../src/types.js';

function makeTestResult(bugs: BugDetection[]): TestResult {
  return {
    testId: 'test-1',
    passed: false,
    bugs,
    durationMs: 100,
  };
}

function makeBug(kind: BugDetection['kind'], detail = ''): BugDetection {
  return {
    kind,
    rootCause: detail || kind,
  };
}

describe('classify — priority hierarchy (§ 3.5.1)', () => {
  it('single firing produces no secondaryObservations', () => {
    const result = makeTestResult([makeBug('network_5xx')]);
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('network_5xx');
    expect(bugs[0].detection.secondaryObservations).toBeUndefined();
  });

  it('surface_call_failed beats 404_for_linked_route and network_4xx_unexpected', () => {
    const detections: BugDetection[] = [
      makeBug('404_for_linked_route', 'linked route is 404'),
      makeBug('surface_call_failed', 'mutating call failed'),
      makeBug('network_4xx_unexpected', '4xx where success expected'),
    ];
    const result = makeTestResult(detections);
    const { bugs } = runClassify([result]);

    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('surface_call_failed');

    const secondary = bugs[0].detection.secondaryObservations;
    expect(secondary).toBeDefined();
    expect(secondary).toHaveLength(2);
    const secondaryKinds = secondary!.map(s => s.kind);
    expect(secondaryKinds).toContain('404_for_linked_route');
    expect(secondaryKinds).toContain('network_4xx_unexpected');
  });

  it('unhandled_exception beats everything', () => {
    const detections: BugDetection[] = [
      makeBug('console_error'),
      makeBug('network_5xx'),
      makeBug('react_error'),
      makeBug('unhandled_exception'),
    ];
    const { bugs } = runClassify([makeTestResult(detections)]);

    expect(bugs[0].detection.kind).toBe('unhandled_exception');
    expect(bugs[0].detection.secondaryObservations).toHaveLength(3);
  });

  it('infrastructure failures never become bug detections', () => {
    const result: TestResult = {
      testId: 'infra-test',
      passed: false,
      bugs: [makeBug('network_5xx')],
      infrastructureFailure: {
        id: 'infra-1',
        runId: 'run-1',
        timestamp: new Date().toISOString(),
        kind: 'timeout',
        detail: 'timed out',
      },
      durationMs: 30000,
    };
    const { bugs, infraFailures } = runClassify([result]);
    expect(bugs).toHaveLength(0);
    expect(infraFailures).toHaveLength(1);
  });

  it('result with zero bugs produces no entries', () => {
    const result = makeTestResult([]);
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(0);
  });

  it('case 10.4.1: visual_anomaly + missing_state_change → canonical is visual_anomaly; secondary contains missing_state_change', () => {
    const detections: BugDetection[] = [
      makeBug('missing_state_change', 'click did nothing'),
      makeBug('visual_anomaly', 'broken sidebar in main area'),
    ];
    const { bugs } = runClassify([makeTestResult(detections)]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.detection.kind).toBe('visual_anomaly');
    const secondary = bugs[0]!.detection.secondaryObservations ?? [];
    expect(secondary.map(s => s.kind)).toContain('missing_state_change');
  });

  it('case 10.4.2: dom_error_text + visual_anomaly → canonical is dom_error_text; secondary contains visual_anomaly', () => {
    const detections: BugDetection[] = [
      makeBug('visual_anomaly', 'blank container'),
      makeBug('dom_error_text', 'Error in DOM'),
    ];
    const { bugs } = runClassify([makeTestResult(detections)]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.detection.kind).toBe('dom_error_text');
    const secondary = bugs[0]!.detection.secondaryObservations ?? [];
    expect(secondary.map(s => s.kind)).toContain('visual_anomaly');
  });

  it('case 10.4.3: react_error + visual_anomaly → canonical is react_error; secondary contains visual_anomaly', () => {
    const detections: BugDetection[] = [
      makeBug('visual_anomaly', 'broken modal layout'),
      makeBug('react_error', 'Cannot read property of undefined'),
    ];
    const { bugs } = runClassify([makeTestResult(detections)]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.detection.kind).toBe('react_error');
    const secondary = bugs[0]!.detection.secondaryObservations ?? [];
    expect(secondary.map(s => s.kind)).toContain('visual_anomaly');
  });
});
