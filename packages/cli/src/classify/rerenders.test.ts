// Tests for excessive re-renders classifier (§4.10).

import { describe, it, expect } from 'vitest';
import { classifyExcessiveRerenders } from './rerenders.js';
import type { PerfArtifacts, RenderEvent } from '../types.js';

function makePerf(renderEvents: RenderEvent[]): PerfArtifacts {
  return {
    occurrenceId: 'occ-1',
    webVitals: [],
    longTasks: [],
    heapSamples: [],
    renderEvents,
  };
}

function makeEvents(component: string, capturedAtMs: number[]): RenderEvent[] {
  return capturedAtMs.map(t => ({ component, capturedAtMs: t }));
}

describe('classifyExcessiveRerenders', () => {
  it('T1: TradesTable rendered 25 times in 5s → emit count:25', () => {
    // 25 events in a 4000ms span — all within a 5000ms window
    const events = makeEvents('TradesTable', Array.from({ length: 25 }, (_, i) => i * 160));
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('excessive_re_renders');
    expect((result[0].evidence as { component: string }).component).toBe('TradesTable');
    expect((result[0].evidence as { count: number }).count).toBe(25);
  });

  it('T2: Component rendered 8 times in 5s → no emit (under threshold of 10)', () => {
    const events = makeEvents('SmallComponent', Array.from({ length: 8 }, (_, i) => i * 500));
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(0);
  });

  it('T3: Component rendered 25 times across 30 seconds → no emit (no 5s window has > 10)', () => {
    // 25 events spaced 1.2s apart = 28.8s total
    // No window of 5s contains > 10 (each 5s window = 4 events at most when spaced 1.2s apart)
    const events = makeEvents('SpreadOut', Array.from({ length: 25 }, (_, i) => i * 1200));
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(0);
  });

  it('T4: Anonymous components emit with component "Anonymous"', () => {
    const events = makeEvents('Anonymous', Array.from({ length: 25 }, (_, i) => i * 50));
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { component: string }).component).toBe('Anonymous');
  });

  it('empty render events → no emit', () => {
    const perf = makePerf([]);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(0);
  });

  it('multiple components — each classified independently', () => {
    const events = [
      ...makeEvents('A', Array.from({ length: 20 }, (_, i) => i * 100)),
      ...makeEvents('B', Array.from({ length: 5 }, (_, i) => i * 100)),
    ];
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { component: string }).component).toBe('A');
  });

  it('evidence includes firstCaptureAtMs', () => {
    const events = makeEvents('Widget', Array.from({ length: 15 }, (_, i) => 100 + i * 100));
    const perf = makePerf(events);
    const result = classifyExcessiveRerenders(perf);
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { firstCaptureAtMs: number }).firstCaptureAtMs).toBe(100);
  });

  it('respects custom thresholds', () => {
    // 6 renders in 5s — under default (10) but over custom (5)
    const events = makeEvents('Foo', [0, 500, 1000, 1500, 2000, 2500]);
    const perf = makePerf(events);
    const defaultResult = classifyExcessiveRerenders(perf);
    expect(defaultResult).toHaveLength(0);
    const customResult = classifyExcessiveRerenders(perf, { rerenderCountThreshold: 5 });
    expect(customResult).toHaveLength(1);
  });
});
