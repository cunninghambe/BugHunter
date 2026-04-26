// Phase 4: classify — heuristic bug classification (§ 3.5).
// Deduplicates bugs from test results and marks infrastructure failures.

import type { TestResult, BugDetection, InfrastructureFailure } from '../types.js';

export type ClassifyResult = {
  bugs: Array<{ testId: string; detection: BugDetection }>;
  infraFailures: InfrastructureFailure[];
};

export function runClassify(results: TestResult[]): ClassifyResult {
  const bugs: Array<{ testId: string; detection: BugDetection }> = [];
  const infraFailures: InfrastructureFailure[] = [];

  for (const result of results) {
    if (result.infrastructureFailure) {
      infraFailures.push(result.infrastructureFailure);
      // Infrastructure failures do NOT enter bugs
      continue;
    }
    for (const bug of result.bugs) {
      bugs.push({ testId: result.testId, detection: bug });
    }
  }

  return { bugs, infraFailures };
}
