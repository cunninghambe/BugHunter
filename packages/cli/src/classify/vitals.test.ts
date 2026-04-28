// Tests for Web Vitals classifier (§4.1–4.3).

import { describe, it, expect } from 'vitest';
import { classifyVitals } from './vitals.js';
import type { PerfArtifacts, WebVitalSample } from '../types.js';

function makePerf(vitals: WebVitalSample[]): PerfArtifacts {
  return {
    occurrenceId: 'occ-1',
    webVitals: vitals,
    longTasks: [],
    heapSamples: [],
    renderEvents: [],
  };
}

function makeVital(name: WebVitalSample['name'], value: number): WebVitalSample {
  const rating: WebVitalSample['rating'] =
    name === 'LCP' ? (value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good')
    : name === 'INP' ? (value > 500 ? 'poor' : value > 200 ? 'needs-improvement' : 'good')
    : name === 'CLS' ? (value > 0.25 ? 'poor' : value > 0.1 ? 'needs-improvement' : 'good')
    : 'good';
  return { name, value, rating, capturedAtMs: 500 };
}

// --- LCP tests (§4.1) ---

describe('slow_lcp', () => {
  it('T1: LCP 3500ms → emit slow_lcp with valueMs=3500', () => {
    const perf = makePerf([makeVital('LCP', 3500)]);
    const detections = classifyVitals(perf, '/dashboard', 'render');
    expect(detections.filter(d => d.kind === 'slow_lcp')).toHaveLength(1);
    const d = detections.find(d => d.kind === 'slow_lcp')!;
    expect((d.evidence as { valueMs: number }).valueMs).toBe(3500);
  });

  it('T2: LCP 2000ms → no emit (under threshold)', () => {
    const perf = makePerf([makeVital('LCP', 2000)]);
    const detections = classifyVitals(perf, '/dashboard', 'render');
    expect(detections.filter(d => d.kind === 'slow_lcp')).toHaveLength(0);
  });

  it('T3: Two LCP samples (3000ms, 2400ms) → one finding with worst value', () => {
    const perf = makePerf([makeVital('LCP', 3000), makeVital('LCP', 2400)]);
    const detections = classifyVitals(perf, '/page', 'render');
    const lcps = detections.filter(d => d.kind === 'slow_lcp');
    // Only 3000 > threshold (2500), 2400 < threshold
    expect(lcps).toHaveLength(1);
    expect((lcps[0].evidence as { valueMs: number }).valueMs).toBe(3000);
  });

  it('T4: No LCP samples → no emit, no throw', () => {
    const perf = makePerf([]);
    const detections = classifyVitals(perf, '/page', 'render');
    expect(detections.filter(d => d.kind === 'slow_lcp')).toHaveLength(0);
  });
});

// --- INP tests (§4.2) ---

describe('slow_inp', () => {
  it('emits slow_inp for INP > 200ms on a click action', () => {
    const perf = makePerf([makeVital('INP', 350)]);
    const detections = classifyVitals(perf, '/page', 'click');
    expect(detections.filter(d => d.kind === 'slow_inp')).toHaveLength(1);
    const d = detections.find(d => d.kind === 'slow_inp')!;
    expect((d.evidence as { valueMs: number }).valueMs).toBe(350);
  });

  it('does NOT emit slow_inp for render-only action', () => {
    const perf = makePerf([makeVital('INP', 500)]);
    const detections = classifyVitals(perf, '/page', 'render');
    expect(detections.filter(d => d.kind === 'slow_inp')).toHaveLength(0);
  });

  it('no INP samples → no emit', () => {
    const perf = makePerf([]);
    const detections = classifyVitals(perf, '/page', 'click');
    expect(detections.filter(d => d.kind === 'slow_inp')).toHaveLength(0);
  });

  it('INP 150ms (under threshold) → no emit', () => {
    const perf = makePerf([makeVital('INP', 150)]);
    const detections = classifyVitals(perf, '/page', 'fill');
    expect(detections.filter(d => d.kind === 'slow_inp')).toHaveLength(0);
  });
});

// --- CLS tests (§4.3) ---

describe('high_cls', () => {
  it('emits high_cls for CLS > 0.1', () => {
    const perf = makePerf([makeVital('CLS', 0.25)]);
    const detections = classifyVitals(perf, '/page', 'render');
    expect(detections.filter(d => d.kind === 'high_cls')).toHaveLength(1);
    const d = detections.find(d => d.kind === 'high_cls')!;
    expect((d.evidence as { value: number }).value).toBe(0.25);
  });

  it('CLS = 0.05 (under threshold) → no emit', () => {
    const perf = makePerf([makeVital('CLS', 0.05)]);
    const detections = classifyVitals(perf, '/page', 'render');
    expect(detections.filter(d => d.kind === 'high_cls')).toHaveLength(0);
  });

  it('no CLS samples → no emit', () => {
    const perf = makePerf([]);
    const detections = classifyVitals(perf, '/page', 'click');
    expect(detections.filter(d => d.kind === 'high_cls')).toHaveLength(0);
  });
});

// --- Custom thresholds ---

describe('custom thresholds', () => {
  it('respects custom lcpMs threshold', () => {
    const perf = makePerf([makeVital('LCP', 1800)]);
    // Under default (2500), but over custom (1500)
    const detections = classifyVitals(perf, '/page', 'render', { lcpMs: 1500 });
    expect(detections.filter(d => d.kind === 'slow_lcp')).toHaveLength(1);
  });

  it('no findings when all vitals under custom thresholds', () => {
    const perf = makePerf([
      makeVital('LCP', 500),
      makeVital('INP', 50),
      makeVital('CLS', 0.01),
    ]);
    const detections = classifyVitals(perf, '/page', 'click', { lcpMs: 1000, inpMs: 200, cls: 0.05 });
    expect(detections).toHaveLength(0);
  });
});
