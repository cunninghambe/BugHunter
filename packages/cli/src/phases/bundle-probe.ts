// Bundle-probe phase — wraps bundle-analyzer for the BugHunter phase pipeline (§3.2, §4.9).

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BugDetection, BundleProbeConfig } from '../types.js';
import { analyzeBundles } from '../static/bundle-analyzer.js';
import { log } from '../log.js';

export type BundleProbeOptions = {
  projectDir: string;
  config: BundleProbeConfig;
};

export type BundleProbeResult = {
  detections: BugDetection[];
  totalInitialJsGzip: number;
  totalInitialCssGzip: number;
  budgetExceeded: boolean;
};

const EMPTY: BundleProbeResult = {
  detections: [],
  totalInitialJsGzip: 0,
  totalInitialCssGzip: 0,
  budgetExceeded: false,
};

function resolveDistPath(projectDir: string, config: BundleProbeConfig): string | null {
  if (config.searchPaths !== undefined && config.searchPaths.length > 0) {
    for (const p of config.searchPaths) {
      const resolved = path.join(projectDir, p);
      if (fs.existsSync(resolved)) return resolved;
    }
  }

  // Auto-detect: try Vite's 'dist', Next.js's '.next/static', etc.
  const candidates = ['dist', '.next/static', 'build', 'out'];
  for (const candidate of candidates) {
    const resolved = path.join(projectDir, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

export function runBundleProbe(opts: BundleProbeOptions): BundleProbeResult {
  if (!opts.config.enabled) return EMPTY;

  const distPath = resolveDistPath(opts.projectDir, opts.config);
  if (distPath === null) {
    log.warn('bundle-probe: no dist/ directory found; skipping', { projectDir: opts.projectDir });
    return EMPTY;
  }

  log.info('bundle-probe: analyzing', { distPath });

  const result = analyzeBundles({
    distPath,
    jsThresholdGzipBytes: opts.config.jsThresholdGzipBytes,
    cssThresholdGzipBytes: opts.config.cssThresholdGzipBytes,
  });

  const detections: BugDetection[] = [];

  if (result.exceedsJsBudget) {
    detections.push({
      kind: 'oversized_bundle',
      rootCause: `Initial-route JS bundle is ${Math.round(result.totalInitialJsGzip / 1024)}KB gzipped (budget: ${Math.round(opts.config.jsThresholdGzipBytes / 1024)}KB)`,
      evidence: {
        kind: 'js',
        totalGzipBytes: result.totalInitialJsGzip,
        thresholdGzipBytes: opts.config.jsThresholdGzipBytes,
        files: result.artifacts.filter(a => a.kind === 'js' && a.initialRoute),
      },
    });
  }

  if (result.exceedsCssBudget) {
    detections.push({
      kind: 'oversized_bundle',
      rootCause: `Initial-route CSS bundle is ${Math.round(result.totalInitialCssGzip / 1024)}KB gzipped (budget: ${Math.round(opts.config.cssThresholdGzipBytes / 1024)}KB)`,
      evidence: {
        kind: 'css',
        totalGzipBytes: result.totalInitialCssGzip,
        thresholdGzipBytes: opts.config.cssThresholdGzipBytes,
        files: result.artifacts.filter(a => a.kind === 'css' && a.initialRoute),
      },
    });
  }

  return {
    detections,
    totalInitialJsGzip: result.totalInitialJsGzip,
    totalInitialCssGzip: result.totalInitialCssGzip,
    budgetExceeded: result.exceedsJsBudget || result.exceedsCssBudget,
  };
}
