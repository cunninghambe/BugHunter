// V56.4.2+ per-kind classifier registry. Each classifier converts a per-route
// HarvestEnvelope into a list of (route, rootCause, severity) tuples that the
// caller wraps into BugCluster[] via buildBrowserHarnessCluster().
//
// New browser-routed BugKinds register a classifier here when their
// V56.4.x PR lands.

import type { BugKind } from '../types.js';
import type { HarvestEnvelope } from './browser-executor.js';
import { isReactError, isHydrationError } from '../classify/react.js';

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

  // ---- Bucket A: unhandled_exception ----
  unhandled_exception(envelope) {
    const total = envelope.uncaughtErrors.length + envelope.unhandledRejections.length;
    if (total === 0) return [];
    const sample = envelope.uncaughtErrors[0]?.message
      ?? envelope.unhandledRejections[0]?.reason
      ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${total} uncaught exception(s)/rejection(s) on ${envelope.pageRoute} — first: "${sample.slice(0, 120)}"`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: react_error (production isReactError pattern) ----
  // hydration errors are a more-specific subkind — when isHydrationError matches,
  // we DON'T fire react_error (production behaviour: hydration takes precedence).
  react_error(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    const reactish = errors.filter(e => !isHydrationError(e.message) && isReactError(e.message));
    if (reactish.length === 0) return [];
    const sample = reactish[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${reactish.length} React-pattern console.error(s) on ${envelope.pageRoute} — "${sample.slice(0, 120)}"`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: hydration_mismatch ----
  hydration_mismatch(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    const hits = errors.filter(e => isHydrationError(e.message));
    if (hits.length === 0) return [];
    const sample = hits[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} hydration-mismatch console.error(s) on ${envelope.pageRoute} — "${sample.slice(0, 120)}"`,
      severity: 'major',
    }];
  },
};

export function getBrowserHarnessClassifier(kind: BugKind): BrowserHarnessClassifier | undefined {
  return REGISTRY[kind];
}
