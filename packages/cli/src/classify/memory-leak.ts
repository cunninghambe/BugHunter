// Memory-leak classifier — memory_leak_suspected (§4.12).
// Run-level classifier: accepts all PerfArtifacts from the run, sorts heap samples,
// runs linear regression, emits one finding if slope > 100KB/s and end >= 2x start.

import type { PerfArtifacts, HeapSample, BugDetection } from '../types.js';

const SLOPE_THRESHOLD_BYTES_PER_MS = 100; // 100KB/s = 100 bytes/ms

/** Compute linear regression slope (bytes/ms) via least-squares. */
function linearRegressionSlope(samples: HeapSample[]): number {
  const n = samples.length;
  if (n < 2) return 0;

  const xMean = samples.reduce((s, h) => s + h.capturedAtMs, 0) / n;
  const yMean = samples.reduce((s, h) => s + h.jsHeapUsedSize, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const h of samples) {
    const dx = h.capturedAtMs - xMean;
    numerator += dx * (h.jsHeapUsedSize - yMean);
    denominator += dx * dx;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

export function classifyMemoryLeak(
  perfArtifactsPerOccurrence: PerfArtifacts[],
): BugDetection[] {
  // Collect and sort all heap samples across the run
  const allSamples: HeapSample[] = [];
  for (const p of perfArtifactsPerOccurrence) {
    allSamples.push(...p.heapSamples);
  }

  if (allSamples.length < 2) return [];

  allSamples.sort((a, b) => a.capturedAtMs - b.capturedAtMs);

  const first = allSamples[0];
  const last = allSamples[allSamples.length - 1];

  const slope = linearRegressionSlope(allSamples);
  const durationMs = last.capturedAtMs - first.capturedAtMs;

  if (durationMs <= 0) return [];

  // slope > 100KB/s AND end >= 2x start
  if (slope <= SLOPE_THRESHOLD_BYTES_PER_MS) return [];
  if (last.jsHeapUsedSize < first.jsHeapUsedSize * 2) return [];

  return [{
    kind: 'memory_leak_suspected',
    rootCause: `JS heap grew from ${Math.round(first.jsHeapUsedSize / 1024)}KB to ${Math.round(last.jsHeapUsedSize / 1024)}KB over ${Math.round(durationMs / 1000)}s (slope: ${Math.round(slope * 1000 / 1024)}KB/s)`,
    evidence: {
      startBytes: first.jsHeapUsedSize,
      endBytes: last.jsHeapUsedSize,
      slopeBytesPerMs: slope,
      durationMs,
      sampleCount: allSamples.length,
    },
  }];
}
