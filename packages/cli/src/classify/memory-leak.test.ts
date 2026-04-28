// Tests for memory-leak classifier (§4.12).

import { describe, it, expect } from 'vitest';
import { classifyMemoryLeak } from './memory-leak.js';
import type { PerfArtifacts, HeapSample } from '../types.js';

function MB(n: number): number {
  return n * 1024 * 1024;
}

function makePerf(heapSamples: HeapSample[]): PerfArtifacts {
  return {
    occurrenceId: 'occ-1',
    webVitals: [],
    longTasks: [],
    heapSamples,
    renderEvents: [],
  };
}

function makeHeapSamples(bytesAtSeconds: Array<[number, number]>): HeapSample[] {
  return bytesAtSeconds.map(([seconds, bytes]) => ({
    capturedAtMs: seconds * 1000,
    jsHeapUsedSize: bytes,
    jsHeapTotalSize: bytes * 2,
  }));
}

describe('classifyMemoryLeak', () => {
  it('T1: 50MB→100MB over 60s → emit (slope > 100KB/s, end >= 2x start)', () => {
    // slope ≈ (100-50)MB / 60s = 50MB/60s ≈ 833KB/s > 100KB/s; end = 2x start
    const samples = makeHeapSamples([
      [0, MB(50)], [15, MB(60)], [30, MB(70)], [45, MB(80)], [60, MB(100)]
    ]);
    const result = classifyMemoryLeak([makePerf(samples)]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('memory_leak_suspected');
    expect((result[0].evidence as { startBytes: number }).startBytes).toBe(MB(50));
    expect((result[0].evidence as { endBytes: number }).endBytes).toBe(MB(100));
  });

  it('T2: Steady 50MB ± 1MB → no emit (slope ~0)', () => {
    const samples = makeHeapSamples([
      [0, MB(50)], [10, MB(51)], [20, MB(49)], [30, MB(50)], [40, MB(51)]
    ]);
    const result = classifyMemoryLeak([makePerf(samples)]);
    expect(result).toHaveLength(0);
  });

  it('T3: 50MB → 51MB over 10 minutes → no emit (slope tiny)', () => {
    // slope ≈ 1MB / 600s ≈ 1.7KB/s < 100KB/s
    const samples = makeHeapSamples([
      [0, MB(50)], [150, MB(50.2)], [300, MB(50.5)], [450, MB(50.8)], [600, MB(51)]
    ]);
    const result = classifyMemoryLeak([makePerf(samples)]);
    expect(result).toHaveLength(0);
  });

  it('returns empty for fewer than 2 samples', () => {
    const result = classifyMemoryLeak([makePerf([])]);
    expect(result).toHaveLength(0);
  });

  it('accepts multiple PerfArtifacts (concatenates across occurrences)', () => {
    const p1 = makePerf(makeHeapSamples([[0, MB(50)], [10, MB(60)]]));
    const p2 = makePerf(makeHeapSamples([[20, MB(80)], [30, MB(110)]]));
    const result = classifyMemoryLeak([p1, p2]);
    // slope is high enough; end (110MB) >= 2 * start (50MB)
    expect(result).toHaveLength(1);
  });

  it('evidence contains sampleCount', () => {
    const samples = makeHeapSamples([
      [0, MB(50)], [15, MB(65)], [30, MB(80)], [45, MB(95)], [60, MB(110)]
    ]);
    const result = classifyMemoryLeak([makePerf(samples)]);
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { sampleCount: number }).sampleCount).toBe(5);
  });

  it('boundary: end exactly 2x start is included (>= 2x)', () => {
    // 50MB → 100MB with high slope
    const samples = makeHeapSamples([
      [0, MB(50)], [30, MB(75)], [60, MB(100)]
    ]);
    const result = classifyMemoryLeak([makePerf(samples)]);
    expect(result).toHaveLength(1);
  });
});
