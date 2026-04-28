// Tests for long-tasks classifier (§4.8).

import { describe, it, expect } from 'vitest';
import { classifyLongTasks } from './long-tasks.js';
import type { PerfArtifacts, LongTaskSample } from '../types.js';

function makePerf(longTasks: LongTaskSample[]): PerfArtifacts {
  return {
    occurrenceId: 'occ-1',
    webVitals: [],
    longTasks,
    heapSamples: [],
    renderEvents: [],
  };
}

describe('classifyLongTasks', () => {
  it('emits main_thread_blocked for a task >= 50ms', () => {
    const perf = makePerf([{ duration: 250, startTime: 100 }]);
    const result = classifyLongTasks(perf, '/dashboard');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('main_thread_blocked');
    expect((result[0].evidence as { durationMs: number }).durationMs).toBe(250);
  });

  it('does not emit for tasks under threshold', () => {
    const perf = makePerf([{ duration: 30, startTime: 0 }]);
    const result = classifyLongTasks(perf, '/page');
    expect(result).toHaveLength(0);
  });

  it('emits one finding (worst task) even when multiple long tasks present', () => {
    const perf = makePerf([
      { duration: 100, startTime: 0 },
      { duration: 300, startTime: 200 },
      { duration: 80, startTime: 400 },
    ]);
    const result = classifyLongTasks(perf, '/page');
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { durationMs: number }).durationMs).toBe(300);
  });

  it('no long tasks → no emit', () => {
    const perf = makePerf([]);
    const result = classifyLongTasks(perf, '/page');
    expect(result).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    // 250ms task, custom threshold 300ms → no emit
    const perf = makePerf([{ duration: 250, startTime: 0 }]);
    const result = classifyLongTasks(perf, '/page', 300);
    expect(result).toHaveLength(0);
  });

  it('task exactly at threshold is included', () => {
    const perf = makePerf([{ duration: 50, startTime: 0 }]);
    const result = classifyLongTasks(perf, '/page', 50);
    expect(result).toHaveLength(1);
  });

  it('evidence contains pageRoute', () => {
    const perf = makePerf([{ duration: 100, startTime: 0 }]);
    const result = classifyLongTasks(perf, '/trades');
    expect((result[0].evidence as { pageRoute: string }).pageRoute).toBe('/trades');
    expect(result[0].pageRoute).toBe('/trades');
  });
});
