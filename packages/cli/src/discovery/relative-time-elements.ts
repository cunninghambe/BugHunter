/**
 * v0.23 relative-time-element harvester.
 *
 * Harvests up to MAX_ELEMENTS per page from:
 *   1. <time> elements and any element with a [datetime] attribute.
 *   2. Any element whose innerText matches RELATIVE_TIME_PATTERN.
 *
 * Returns a list of { selector, text } pairs for inclusion in
 * DiscoveredPage.relativeTimeElements. The caller stores these; no CDP is needed —
 * this runs as a plain document.querySelectorAll expression via browser.evaluate.
 *
 * SSR blind spot: timestamps rendered by server components appear in initial HTML
 * (pre-hydration) and are detectable here, but the server's clock cannot be
 * injected via CDP. These are flagged as ssrTimestampsObserved in telemetry.
 */

export type RelativeTimeElement = {
  selector: string;
  text: string;
};

const MAX_ELEMENTS = 50;

/** Matches relative-time patterns like "just now", "5 minutes ago", "in 3 days". */
export const RELATIVE_TIME_PATTERN = /just now|\d+\s+(second|minute|hour|day)s?\s+ago|in\s+\d+\s+(second|minute|hour|day)s?/i;

/**
 * JS expression to run inside the page (via evaluate) that collects up to MAX_ELEMENTS
 * relative-time elements. Returns a JSON-serialisable array.
 */
export const RELATIVE_TIME_HARVEST_SCRIPT = `(function() {
  var MAX = ${MAX_ELEMENTS};
  var pattern = /just now|\\d+\\s+(second|minute|hour|day)s?\\s+ago|in\\s+\\d+\\s+(second|minute|hour|day)s?/i;
  var results = [];
  var seen = new Set();

  // <time> and [datetime] elements
  var timeEls = Array.from(document.querySelectorAll('time, [datetime]'));
  for (var i = 0; i < timeEls.length && results.length < MAX; i++) {
    var el = timeEls[i];
    var text = (el.textContent || '').trim().slice(0, 200);
    var sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    if (!seen.has(sel)) { seen.add(sel); results.push({ selector: sel, text: text }); }
  }

  // Elements matching the relative-time text pattern
  if (results.length < MAX) {
    var all = Array.from(document.querySelectorAll('span, p, div, td, li, time'));
    for (var j = 0; j < all.length && results.length < MAX; j++) {
      var node = all[j];
      var txt = (node.textContent || '').trim().slice(0, 200);
      if (pattern.test(txt)) {
        var s = node.tagName.toLowerCase() + (node.id ? '#' + node.id : '');
        if (!seen.has(s)) { seen.add(s); results.push({ selector: s, text: txt }); }
      }
    }
  }

  return results;
})()`;

/**
 * Parse the raw evaluate result into typed RelativeTimeElement[].
 * Handles the case where evaluate returns null / non-array gracefully.
 */
export function parseRelativeTimeElements(raw: unknown): RelativeTimeElement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is { selector: unknown; text: unknown } =>
      typeof item === 'object' && item !== null && 'selector' in item && 'text' in item,
    )
    .map(item => ({
      selector: String(item.selector),
      text: String(item.text),
    }))
    .slice(0, MAX_ELEMENTS);
}
