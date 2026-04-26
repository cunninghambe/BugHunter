// Phase 4: classify — heuristic bug classification (§ 3.5).
// Deduplicates bugs from test results and marks infrastructure failures.
// Applies priority hierarchy (§ 3.5.1) per test result before clustering.

import type { TestResult, BugDetection, InfrastructureFailure, BugKind } from '../types.js';

export type ClassifyResult = {
  bugs: Array<{ testId: string; detection: BugDetection }>;
  infraFailures: InfrastructureFailure[];
};

// Priority order: index 0 = highest priority (§ 3.5.1)
const KIND_PRIORITY: BugKind[] = [
  'unhandled_exception',
  'network_5xx',
  'react_error',
  'surface_call_failed',
  'network_4xx_unexpected',
  '404_for_linked_route',
  'dom_error_text',
  'missing_state_change',
  'console_error',
  'accessibility_critical',
];

function priorityOf(kind: BugKind): number {
  const idx = KIND_PRIORITY.indexOf(kind);
  return idx === -1 ? KIND_PRIORITY.length : idx;
}

// Given multiple detections for one test result, pick the canonical (highest-priority)
// one and attach the rest as secondaryObservations.
function applyPriorityFilter(detections: BugDetection[]): BugDetection | null {
  if (detections.length === 0) return null;
  if (detections.length === 1) return detections[0];

  const sorted = [...detections].sort((a, b) => priorityOf(a.kind) - priorityOf(b.kind));
  const [canonical, ...rest] = sorted;
  return {
    ...canonical,
    secondaryObservations: rest.map(d => ({ kind: d.kind, detail: d.rootCause })),
  };
}

export function runClassify(results: TestResult[]): ClassifyResult {
  const bugs: Array<{ testId: string; detection: BugDetection }> = [];
  const infraFailures: InfrastructureFailure[] = [];

  for (const result of results) {
    if (result.infrastructureFailure) {
      infraFailures.push(result.infrastructureFailure);
      // Infrastructure failures do NOT enter bugs
      continue;
    }
    const canonical = applyPriorityFilter(result.bugs);
    if (canonical) {
      bugs.push({ testId: result.testId, detection: canonical });
    }
  }

  return { bugs, infraFailures };
}
