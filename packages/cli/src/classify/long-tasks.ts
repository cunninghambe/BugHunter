// Long-tasks classifier — main_thread_blocked (§4.8).

import type { PerfArtifacts, BugDetection, LongTaskSample } from '../types.js';

const DEFAULT_LONG_TASK_MS = 50;

/** Emits one finding per unique page route for the worst long task exceeding the threshold. */
export function classifyLongTasks(
  perf: PerfArtifacts,
  pageRoute: string,
  longTaskMs = DEFAULT_LONG_TASK_MS,
): BugDetection[] {
  const exceeding = perf.longTasks.filter(t => t.duration >= longTaskMs);
  if (exceeding.length === 0) return [];

  const worst: LongTaskSample = exceeding.reduce((a, b) => (b.duration > a.duration ? b : a));

  return [{
    kind: 'main_thread_blocked',
    rootCause: `Main thread blocked for ${worst.duration}ms (threshold: ${longTaskMs}ms) on ${pageRoute}`,
    pageRoute,
    evidence: {
      durationMs: worst.duration,
      startTimeMs: worst.startTime,
      threshold: longTaskMs,
      pageRoute,
    },
  }];
}
