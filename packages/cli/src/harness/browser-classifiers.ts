// V56.4.2+ per-kind classifier registry. Each classifier converts a per-route
// HarvestEnvelope into a list of (route, rootCause, severity) tuples that the
// caller wraps into BugCluster[] via buildBrowserHarnessCluster().
//
// New browser-routed BugKinds register a classifier here when their
// V56.4.x PR lands.

import type { BugKind } from '../types.js';
import type { HarvestEnvelope } from './browser-executor.js';

export type BrowserHarnessHit = {
  route: string;
  rootCause: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
};

export type BrowserHarnessClassifier = (envelope: HarvestEnvelope) => BrowserHarnessHit[];

const REGISTRY: Partial<Record<BugKind, BrowserHarnessClassifier>> = {
  // ---- Bucket A: console_error ----
  console_error(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    if (errors.length === 0) return [];
    const sample = errors[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `console.error called ${errors.length} time(s) on ${envelope.pageRoute} — first message: "${sample.slice(0, 120)}"`,
      severity: 'major',
    }];
  },
};

export function getBrowserHarnessClassifier(kind: BugKind): BrowserHarnessClassifier | undefined {
  return REGISTRY[kind];
}
