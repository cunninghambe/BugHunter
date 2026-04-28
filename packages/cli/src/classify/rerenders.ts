// Excessive re-renders classifier — excessive_re_renders (§4.10).

import type { PerfArtifacts, RenderEvent, BugDetection } from '../types.js';

const DEFAULT_COUNT_THRESHOLD = 10;
const DEFAULT_WINDOW_MS = 5000;

/** Sliding-window check: does any window of windowMs contain > countThreshold renders? */
function exceedsInWindow(events: RenderEvent[], windowMs: number, threshold: number): boolean {
  for (let i = 0; i < events.length; i++) {
    const windowEnd = events[i].capturedAtMs + windowMs;
    let count = 0;
    for (let j = i; j < events.length && events[j].capturedAtMs <= windowEnd; j++) {
      count++;
    }
    if (count > threshold) return true;
  }
  return false;
}

export function classifyExcessiveRerenders(
  perf: PerfArtifacts,
  config: { rerenderCountThreshold?: number; rerenderWindowMs?: number } = {},
): BugDetection[] {
  const countThreshold = config.rerenderCountThreshold ?? DEFAULT_COUNT_THRESHOLD;
  const windowMs = config.rerenderWindowMs ?? DEFAULT_WINDOW_MS;

  if (perf.renderEvents.length === 0) return [];

  // Group by component name
  const byComponent = new Map<string, RenderEvent[]>();
  for (const ev of perf.renderEvents) {
    const name = ev.component || 'Anonymous';
    const existing = byComponent.get(name);
    if (existing !== undefined) {
      existing.push(ev);
    } else {
      byComponent.set(name, [ev]);
    }
  }

  const detections: BugDetection[] = [];

  for (const [component, events] of byComponent) {
    // Sort events by capturedAtMs for the sliding window
    const sorted = [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs);

    if (!exceedsInWindow(sorted, windowMs, countThreshold)) continue;

    detections.push({
      kind: 'excessive_re_renders',
      rootCause: `Component "${component}" re-rendered ${events.length} times within a ${windowMs}ms window (threshold: ${countThreshold})`,
      evidence: {
        component,
        count: events.length,
        windowMs,
        threshold: countThreshold,
        firstCaptureAtMs: sorted[0].capturedAtMs,
      },
    });
  }

  return detections;
}
