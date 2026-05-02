// pull_to_refresh_conflict detector (v0.41).
// Inventory-based: monkey-patches addEventListener before page load via init-script;
// inspects captured non-passive touchstart/touchmove listeners near top of page.

import type { BugDetection } from '../types.js';
import { log } from '../log.js';

export const PULL_TO_REFRESH_INIT_SCRIPT = `
(function(){
  const orig = EventTarget.prototype.addEventListener;
  window.__bh_listeners__ = [];
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === 'touchstart' || type === 'touchmove') {
      const passive = typeof options === 'object' && options !== null
        ? options.passive === true
        : false;
      const sel = this.tagName
        ? this.tagName.toLowerCase() + (this.id ? '#' + this.id : '')
        : (this === window ? 'window' : this === document ? 'document' : 'unknown');
      window.__bh_listeners__.push({ type, passive, selector: sel });
    }
    return orig.apply(this, arguments);
  };
})();
`;

const DUMP_LISTENERS_SCRIPT = `window.__bh_listeners__ || []`;

const ELEMENT_Y_SCRIPT = `
(function() {
  const sel = __SEL__;
  if (!sel || sel === 'window' || sel === 'document' || sel === 'unknown') return 0;
  try {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().top : 999;
  } catch { return 999; }
})()
`;

type ListenerRecord = { type: string; passive: boolean; selector: string };

function isNearTop(selector: string): boolean {
  // window/document-level listeners are always considered for PTR conflicts if non-passive
  if (selector === 'window' || selector === 'document' || selector === 'unknown') return true;
  // Element-level: will be checked via evaluate; for now include all candidates
  return true;
}

export type PullToRefreshBrowserScope = {
  evaluate(script: string): Promise<{ value: unknown }>;
  addInitScript?(source: string): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export async function installPullToRefreshInitScript(browser: PullToRefreshBrowserScope): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (browser.addInitScript === undefined) {
    return { ok: false, reason: 'no_init_script_support' };
  }
  return browser.addInitScript(PULL_TO_REFRESH_INIT_SCRIPT);
}

export async function detectPullToRefreshConflict(
  browser: PullToRefreshBrowserScope,
  pageRoute: string,
): Promise<BugDetection[]> {
  const listenersResult = await browser.evaluate(DUMP_LISTENERS_SCRIPT);
  const listeners = Array.isArray(listenersResult.value) ? listenersResult.value as ListenerRecord[] : [];

  const conflicts: BugDetection[] = [];
  const seen = new Set<string>();

  for (const l of listeners) {
    if (l.passive) continue;
    if (!isNearTop(l.selector)) continue;

    const key = `${l.type}:${l.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Check element Y position (if possible)
    if (l.selector !== 'window' && l.selector !== 'document' && l.selector !== 'unknown') {
      const script = ELEMENT_Y_SCRIPT.replace('__SEL__', JSON.stringify(l.selector));
      try {
        const yResult = await browser.evaluate(script);
        const y = typeof yResult.value === 'number' ? yResult.value : 0;
        if (y > 100) continue; // not near top of page
      } catch (err) {
        log.warn(`pull-to-refresh-detector: y-check failed for "${l.selector}": ${String(err)}`);
      }
    }

    conflicts.push({
      kind: 'pull_to_refresh_conflict',
      rootCause: `Non-passive ${l.type} listener on "${l.selector}" conflicts with browser pull-to-refresh gesture. Add { passive: true } to the listener options.`,
      pageRoute,
      selectorClass: l.selector.slice(0, 80),
      evidence: { listenerType: l.type, passive: false, selector: l.selector },
    });
  }

  return conflicts;
}
