// DOM error-text detection (§ 3.5).
//
// v0.51: tightened to require an error-indicator container. Per the spoonworks
// benchmark (docs/benchmarks/BENCHMARK_SPOONWORKS.md), the unconditional pattern
// match produced 30/30 false positives — every match was policy/help/marketing
// body text. The container check ("role=alert", "role=status", "aria-live",
// classname matching /error|alert|danger|warning|toast/i, or <output>) brings
// the detector in line with how real UIs signal errors.

import type { BugDetection } from '../types.js';

const DOM_ERROR_PATTERN = /(?:something went wrong|an error occurred|unable to|failed to)/i;

// Routes where boilerplate text is expected and false-positives concentrate.
// Excluding them is a precision-vs-recall trade: an actual JS error on /privacy
// would be missed, but those routes are also rendered server-side and other
// detectors cover the failure modes.
const EXCLUDED_ROUTE_PATTERN = /\/(?:policies|legal|terms|privacy|tos|about|faq|contact|help)\b/i;

// Browser-side probe: walks text nodes for the pattern, then walks ancestor
// chain looking for an error-indicator container. Only returns `found: true`
// when both the text matches AND the container signals "this is an error UI".
export const CHECK_DOM_ERROR_SCRIPT = `
(function() {
  var PATTERN = /(?:something went wrong|an error occurred|unable to|failed to)/i;
  var ROLE_INDICATORS = { alert: true, status: true, alertdialog: true };
  var CLASS_PATTERN = /\\b(?:error|alert|danger|warning|toast|notice|notification)\\b/i;

  function getClassName(el) {
    if (!el || !el.className) return '';
    if (typeof el.className === 'string') return el.className;
    if (el.className.baseVal !== undefined) return el.className.baseVal;
    return '';
  }

  function indicatorFor(textNode) {
    var el = textNode.parentElement;
    while (el && el !== document.body && el.nodeType === 1) {
      var role = el.getAttribute ? el.getAttribute('role') : null;
      if (role && ROLE_INDICATORS[role.toLowerCase()] === true) {
        return { source: 'role', value: role };
      }
      var ariaLive = el.getAttribute ? el.getAttribute('aria-live') : null;
      if (ariaLive && ariaLive !== 'off') {
        return { source: 'aria-live', value: ariaLive };
      }
      var cn = getClassName(el);
      if (cn && CLASS_PATTERN.test(cn)) {
        var match = cn.match(CLASS_PATTERN);
        return { source: 'class', value: match ? match[0] : cn.slice(0, 40) };
      }
      if (el.tagName === 'OUTPUT') {
        return { source: 'tag', value: 'output' };
      }
      el = el.parentElement;
    }
    return null;
  }

  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    if (!PATTERN.test(node.textContent)) continue;
    var indicator = indicatorFor(node);
    if (!indicator) continue;
    return {
      found: true,
      text: node.textContent.trim().slice(0, 200),
      indicator: indicator,
    };
  }
  return { found: false };
})()
`;

/**
 * Indicator metadata returned by CHECK_DOM_ERROR_SCRIPT identifying *why* the
 * detector concluded the matched text belongs to error UI.
 */
export type ErrorIndicator = {
  source: 'role' | 'aria-live' | 'class' | 'tag';
  value: string;
};

export function classifyDomErrorText(
  domSnippet: string,
  pageRoute: string,
  selectorClass: string,
  indicator?: ErrorIndicator,
): BugDetection | null {
  if (!DOM_ERROR_PATTERN.test(domSnippet)) return null;
  if (EXCLUDED_ROUTE_PATTERN.test(pageRoute)) return null;

  const evidence = indicator !== undefined
    ? ` (container: ${indicator.source}="${indicator.value}")`
    : '';

  return {
    kind: 'dom_error_text',
    rootCause: `Error text in error-indicator container: "${domSnippet.slice(0, 80)}"${evidence}`,
    pageRoute,
    selectorClass,
  };
}
