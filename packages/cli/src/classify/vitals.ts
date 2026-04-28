// Web Vitals classifier — slow_lcp, slow_inp, high_cls (§4.1–4.3).

import type { PerfArtifacts, WebVitalSample, BugDetection } from '../types.js';

export type VitalsThresholds = {
  lcpMs: number;
  inpMs: number;
  cls: number;
};

const DEFAULT_THRESHOLDS: VitalsThresholds = {
  lcpMs: 2500,
  inpMs: 200,
  cls: 0.1,
};

function worstSample(samples: WebVitalSample[]): WebVitalSample {
  return samples.reduce((a, b) => (b.value > a.value ? b : a));
}

function lcpDetection(samples: WebVitalSample[], pageRoute: string, threshold: number): BugDetection | null {
  const lcpSamples = samples.filter(s => s.name === 'LCP' && s.value > threshold);
  if (lcpSamples.length === 0) return null;
  const worst = worstSample(lcpSamples);
  return {
    kind: 'slow_lcp',
    rootCause: `LCP ${worst.value}ms exceeds threshold ${threshold}ms on ${pageRoute}`,
    pageRoute,
    evidence: {
      valueMs: worst.value,
      thresholdMs: threshold,
      pageRoute,
      sample: worst,
    },
  };
}

function inpDetection(samples: WebVitalSample[], pageRoute: string, threshold: number, actionKind: string): BugDetection | null {
  // INP only applicable for interactive actions (not render-only)
  if (actionKind === 'render') return null;
  const inpSamples = samples.filter(s => s.name === 'INP' && s.value > threshold);
  if (inpSamples.length === 0) return null;
  const worst = worstSample(inpSamples);
  return {
    kind: 'slow_inp',
    rootCause: `INP ${worst.value}ms exceeds threshold ${threshold}ms on ${pageRoute}`,
    pageRoute,
    evidence: {
      valueMs: worst.value,
      thresholdMs: threshold,
      pageRoute,
      sample: worst,
    },
  };
}

function clsDetection(samples: WebVitalSample[], pageRoute: string, threshold: number): BugDetection | null {
  // Filter: exclude samples where hadRecentInput (tracked via rating — the library does not
  // expose hadRecentInput via webVitals v4 UMD callback; we use the library's own
  // 'good'/'needs-improvement'/'poor' rating and value threshold).
  const clsSamples = samples.filter(s => s.name === 'CLS' && s.value > threshold);
  if (clsSamples.length === 0) return null;
  const worst = worstSample(clsSamples);
  return {
    kind: 'high_cls',
    rootCause: `CLS ${worst.value} exceeds threshold ${threshold} on ${pageRoute}`,
    pageRoute,
    evidence: {
      value: worst.value,
      threshold,
      pageRoute,
      sample: worst,
    },
  };
}

export function classifyVitals(
  perf: PerfArtifacts,
  pageRoute: string,
  actionKind: string,
  thresholds: Partial<VitalsThresholds> = {},
): BugDetection[] {
  const t: VitalsThresholds = {
    lcpMs: thresholds.lcpMs ?? DEFAULT_THRESHOLDS.lcpMs,
    inpMs: thresholds.inpMs ?? DEFAULT_THRESHOLDS.inpMs,
    cls: thresholds.cls ?? DEFAULT_THRESHOLDS.cls,
  };

  const detections: BugDetection[] = [];

  const lcp = lcpDetection(perf.webVitals, pageRoute, t.lcpMs);
  if (lcp !== null) detections.push(lcp);

  const inp = inpDetection(perf.webVitals, pageRoute, t.inpMs, actionKind);
  if (inp !== null) detections.push(inp);

  const cls = clsDetection(perf.webVitals, pageRoute, t.cls);
  if (cls !== null) detections.push(cls);

  return detections;
}
