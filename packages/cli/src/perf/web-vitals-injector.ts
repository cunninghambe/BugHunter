// Web Vitals injector — produces a self-contained script string that,
// when evaluated in a page context, registers vitals callbacks and the
// React DevTools hook for render-event collection.
// This module is never executed in the BugHunter process itself.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UMD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'web-vitals-vendored',
  'web-vitals.umd.js',
);

const WEB_VITALS_UMD = readFileSync(UMD_PATH, 'utf-8');

const VITALS_ADAPTER = `
(function () {
  var vitals = window.__bughunter_vitals__ = window.__bughunter_vitals__ || [];
  var longTasks = window.__bughunter_long_tasks__ = window.__bughunter_long_tasks__ || [];
  var t0 = performance.now();

  function push(name, metric) {
    vitals.push({
      name: name,
      value: metric.value,
      rating: metric.rating,
      capturedAtMs: performance.now() - t0
    });
  }

  if (window.webVitals) {
    window.webVitals.onLCP(function(m) { push('LCP', m); }, { reportAllChanges: false });
    window.webVitals.onINP(function(m) { push('INP', m); }, { reportAllChanges: false });
    window.webVitals.onCLS(function(m) { push('CLS', m); }, { reportAllChanges: false });
    window.webVitals.onFCP(function(m) { push('FCP', m); }, { reportAllChanges: false });
    window.webVitals.onTTFB(function(m) { push('TTFB', m); }, { reportAllChanges: false });
  }

  // Long task observer
  try {
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver(function(list) {
        list.getEntries().forEach(function(entry) {
          longTasks.push({
            duration: entry.duration,
            startTime: entry.startTime - t0
          });
        });
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch (e) {}
})();
`;

const REACT_HOOK = `
(function () {
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;
  var events = window.__bughunter_render_events__ = window.__bughunter_render_events__ || [];
  var t0 = performance.now();
  var orig = hook.onCommitFiberRoot;

  function walkFiber(fiber, depth) {
    if (!fiber || depth > 50) return;
    if (fiber.actualDuration > 0) {
      events.push({
        component: fiber.type && (fiber.type.displayName || fiber.type.name) || 'Anonymous',
        capturedAtMs: performance.now() - t0
      });
    }
    walkFiber(fiber.child, depth + 1);
    walkFiber(fiber.sibling, depth + 1);
  }

  hook.onCommitFiberRoot = function(id, root) {
    walkFiber(root.current, 0);
    if (typeof orig === 'function') return orig.call(hook, id, root);
  };
})();
`;

let _cached: string | null = null;

/** Returns a self-contained script string for page injection. */
export function getInjectionScript(): string {
  if (_cached !== null) return _cached;
  _cached = `${WEB_VITALS_UMD}\n${VITALS_ADAPTER}\n${REACT_HOOK}`;
  return _cached;
}
