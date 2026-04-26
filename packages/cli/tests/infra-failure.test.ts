import { describe, it, expect } from 'vitest';
import { runClassify } from '../src/phases/classify.js';
import type { TestResult, InfrastructureFailure } from '../src/types.js';

describe('infrastructure_failure does not enter bugs.jsonl', () => {
  it('infra failures are separated from bugs', () => {
    const infra: InfrastructureFailure = {
      id: 'infra-1',
      runId: 'run-1',
      timestamp: new Date().toISOString(),
      kind: 'browser_crash',
      detail: 'camofox crashed',
      role: 'owner',
      page: '/products',
    };

    const results: TestResult[] = [
      {
        testId: 'tc-1',
        passed: false,
        bugs: [],
        infrastructureFailure: infra,
        durationMs: 100,
      },
      {
        testId: 'tc-2',
        passed: false,
        bugs: [{ kind: 'network_5xx', rootCause: 'Server Error', status: 500 }],
        durationMs: 200,
      },
    ];

    const { bugs, infraFailures } = runClassify(results);

    expect(infraFailures).toHaveLength(1);
    expect(infraFailures[0].kind).toBe('browser_crash');
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('network_5xx');
  });

  it('test with infra failure contributes 0 bugs', () => {
    const results: TestResult[] = [
      {
        testId: 'tc-1',
        passed: false,
        bugs: [{ kind: 'console_error', rootCause: 'Error' }],
        infrastructureFailure: {
          id: 'infra-1',
          runId: 'run-1',
          timestamp: new Date().toISOString(),
          kind: 'generic',
          detail: 'timeout',
        },
        durationMs: 30_000,
      },
    ];

    const { bugs, infraFailures } = runClassify(results);

    // When infrastructureFailure is set, bugs array is ignored
    expect(bugs).toHaveLength(0);
    expect(infraFailures).toHaveLength(1);
  });
});
