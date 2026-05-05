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

  // ---- Bucket B: accessibility_critical ----
  // Production threshold: violation.impact === 'critical' || 'serious'.
  accessibility_critical(envelope) {
    const hits = envelope.axeViolations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (hits.length === 0) return [];
    const sample = hits[0];
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} critical/serious axe violation(s) on ${envelope.pageRoute} — first: ${sample?.id} (${sample?.impact})`,
      severity: 'critical',
    }];
  },

  // ---- Bucket B: axe_color_contrast_strong ----
  axe_color_contrast_strong(envelope) {
    const hits = envelope.axeViolations.filter(v => v.id === 'color-contrast');
    if (hits.length === 0) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Color contrast violation on ${envelope.pageRoute} — ${hits[0]?.nodes ?? 0} affected node(s) (WCAG AA 4.5:1 normal / 3:1 large)`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: dom_error_text ----
  // Production pattern: /(something went wrong|an error occurred|unable to|failed to)/i
  // applied to TreeWalker text nodes. Harness reads envelope.domState.bodyTextSample
  // (capped at 1000 chars) which is sufficient for short error messages typically
  // rendered by toast / error-boundary components.
  dom_error_text(envelope) {
    const text = envelope.domState.bodyTextSample;
    const re = /(something went wrong|an error occurred|unable to|failed to)/i;
    const match = re.exec(text);
    if (match === null) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Error text in DOM on ${envelope.pageRoute}: "${match[0]}" (sample: "${text.slice(0, 100)}")`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: slow_lcp ----
  slow_lcp(envelope) {
    const lcp = envelope.performanceEntries.filter(e => e.entryType === 'largest-contentful-paint');
    if (lcp.length === 0) return [];
    const worst = lcp.reduce((a, b) => ((a.value ?? 0) > (b.value ?? 0) ? a : b));
    const value = worst.value ?? 0;
    if (value <= 4000) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `LCP ${Math.round(value)}ms on ${envelope.pageRoute} (threshold: 4000ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: slow_inp ----
  // Calibration-shape: 'first-input' entry's `value` carries the input-delay/duration ms.
  slow_inp(envelope) {
    const fid = envelope.performanceEntries.filter(e => e.entryType === 'first-input');
    if (fid.length === 0) return [];
    const worst = fid.reduce((a, b) => ((a.value ?? a.duration ?? 0) > (b.value ?? b.duration ?? 0) ? a : b));
    const value = worst.value ?? worst.duration ?? 0;
    if (value <= 200) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `INP ${Math.round(value)}ms on ${envelope.pageRoute} (threshold: 200ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: high_cls ----
  // CLS is a session-cumulative value — sum the .value field across all layout-shift entries.
  high_cls(envelope) {
    const shifts = envelope.performanceEntries.filter(e => e.entryType === 'layout-shift');
    if (shifts.length === 0) return [];
    const cumulative = shifts.reduce((sum, s) => sum + (s.value ?? 0), 0);
    if (cumulative <= 0.25) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Cumulative Layout Shift ${cumulative.toFixed(3)} on ${envelope.pageRoute} (threshold: 0.25)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: main_thread_blocked ----
  // Fires on any longtask whose duration > 50ms (W3C Long Task minimum).
  main_thread_blocked(envelope) {
    const longTasks = envelope.performanceEntries.filter(e => e.entryType === 'longtask');
    if (longTasks.length === 0) return [];
    const worst = longTasks.reduce((a, b) => ((a.duration ?? 0) > (b.duration ?? 0) ? a : b));
    const duration = worst.duration ?? 0;
    if (duration <= 50) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Main thread blocked for ${Math.round(duration)}ms on ${envelope.pageRoute} (threshold: 50ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: n_plus_one_api_calls ----
  // Group by method + path with trailing /\\d+ segments collapsed to /:id.
  // Fire when any group has >= 5 same-shape calls.
  n_plus_one_api_calls(envelope) {
    if (envelope.resourceRequests.length === 0) return [];
    const groups = new Map<string, number>();
    for (const r of envelope.resourceRequests) {
      const method = r.method ?? 'GET';
      let path: string;
      try { path = new URL(r.url).pathname; }
      catch { path = r.url; }
      const family = path.replace(/\/\d+(?=\/|$)/g, '/:id');
      const key = `${method} ${family}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const hits: BrowserHarnessHit[] = [];
    for (const [key, count] of groups) {
      if (count >= 5) {
        hits.push({
          route: envelope.pageRoute,
          rootCause: `${key} called ${count} times on ${envelope.pageRoute} (N+1 threshold: 5)`,
          severity: 'minor',
        });
      }
    }
    return hits;
  },

  // ---- Bucket C: request_dedup_missing ----
  // Fire when >= 3 identical (method+url) calls are present.
  request_dedup_missing(envelope) {
    if (envelope.resourceRequests.length === 0) return [];
    const groups = new Map<string, number>();
    for (const r of envelope.resourceRequests) {
      const method = r.method ?? 'GET';
      const key = `${method} ${r.url}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const hits: BrowserHarnessHit[] = [];
    for (const [key, count] of groups) {
      if (count >= 3) {
        hits.push({
          route: envelope.pageRoute,
          rootCause: `${key} issued ${count} identical times on ${envelope.pageRoute} — request not deduplicated`,
          severity: 'minor',
        });
      }
    }
    return hits;
  },

  // ---- Bucket C: request_cancellation_missing ----
  // Calibration-shape: resource entries with inflightOnNav: true marker.
  // Production: harness observes navigation events and correlates with
  // in-flight resources; the marker stands in for that observation here.
  request_cancellation_missing(envelope) {
    const hits = envelope.resourceRequests.filter(r => r.inflightOnNav === true);
    if (hits.length === 0) return [];
    const sample = hits[0];
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} request(s) in-flight at navigation on ${envelope.pageRoute} — first: ${sample?.method ?? 'GET'} ${sample?.url ?? ''} (cancellation missing)`,
      severity: 'minor',
    }];
  },
};

export function getBrowserHarnessClassifier(kind: BugKind): BrowserHarnessClassifier | undefined {
  return REGISTRY[kind];
}
