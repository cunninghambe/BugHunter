// MutationObserver-based state-change detection (§ 3.5).
// Action-fire → (URL change OR network completion OR 30s ceiling).
// After window closes, check for change in target region.

import type { BugDetection, Action, PreState, PostState, AriaSnapshot } from '../types.js';

// Option B: ARIA-state signal — aria-expanded/aria-haspopup/aria-controls flipping
// means the click intentionally opened a popover/dropdown/dialog.
function ariaStateChanged(pre: AriaSnapshot | undefined, post: AriaSnapshot | undefined): boolean {
  if (pre === undefined || post === undefined) return false;
  return (
    pre.expanded !== post.expanded ||
    pre.haspopup !== post.haspopup ||
    pre.controls !== post.controls
  );
}

export function classifyMissingStateChange(
  preState: PreState,
  postState: PostState,
  action: Action,
  pageRoute: string
): BugDetection | null {
  // Only applies to mutating actions that should produce observable state change
  if (action.expectedOutcome !== 'success') return null;
  if (action.kind === 'render' || action.kind === 'navigate') return null;

  const urlChanged = preState.url !== postState.url;
  const hasToast = postState.domErrorTextDetected;
  const networkCompleted = postState.networkRequests.length > 0;
  const hasConsoleError = postState.consoleErrors.length > 0;

  // If URL changed, or network completed, or there was a toast/error — not a missing state change
  if (urlChanged || hasToast || networkCompleted || hasConsoleError) return null;

  // Option B (primary): ARIA signal — expanded/haspopup/controls changed → portal/popover opened
  if (ariaStateChanged(preState.ariaSnapshot, postState.ariaSnapshot)) return null;

  // Option A (fallback): a known portal element appeared in document.body post-click
  if ((postState.newPortalCount ?? 0) > 0) return null;

  // v0.53: MutationObserver signal — the action mutated DOM topology (added or
  // removed nodes) but in a way that doesn't show up via URL/network/aria/portal.
  // Real spoonworks case: "Remove row" click → setRows(p.filter(...)) → row
  // removed via React reconciliation. No URL change, no network, no aria.
  // Pre-v0.53 PostStates lack the field; treat undefined as "no information"
  // and fall through (legacy behavior, conservative).
  if ((postState.domMutationCount ?? 0) > 0) return null;

  // No observable change after the action window
  return {
    kind: 'missing_state_change',
    rootCause: `Action '${action.kind}' on '${action.selector ?? 'element'}' produced no observable state change`,
    pageRoute,
    selectorClass: action.selector ?? '',
    triggeringAction: action,
  };
}

// Script injected to set up a MutationObserver and capture state changes.
// Must be a single expression (IIFE) so Playwright's page.evaluate(string) accepts it
// unambiguously — multi-statement scripts can fail silently on the CDP evaluate path.
// Mirrors the STOP script pattern. Returns {ok, startedAt} (unused; side effects matter).
export const MUTATION_OBSERVER_START_SCRIPT = `
(function() {
  window.__bhMutations = [];
  window.__bhObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      window.__bhMutations.push({
        type: m.type,
        target: m.target ? m.target.nodeName : null,
        addedCount: m.addedNodes.length,
        removedCount: m.removedNodes.length,
      });
    });
  });
  window.__bhObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  window.__bhObserverStart = Date.now();
  return { ok: true, startedAt: window.__bhObserverStart };
})()
`;

export const MUTATION_OBSERVER_STOP_SCRIPT = `
(function() {
  if (window.__bhObserver) window.__bhObserver.disconnect();
  return {
    mutations: window.__bhMutations || [],
    durationMs: Date.now() - (window.__bhObserverStart || Date.now()),
  };
})()
`;

/**
 * v0.45: Capture ARIA state of the clicked element.
 * Requires window.__bhAriaSelector to be set to the element's CSS selector before calling.
 * Returns { expanded?, haspopup?, controls? }.
 */
export const ARIA_SNAPSHOT_SCRIPT = `
(function() {
  var sel = window.__bhAriaSelector;
  if (!sel) return {};
  var el = document.querySelector(sel);
  if (!el) return {};
  var result = {};
  var exp = el.getAttribute('aria-expanded');
  if (exp !== null) result.expanded = exp === 'true';
  var hpop = el.getAttribute('aria-haspopup');
  if (hpop !== null) result.haspopup = hpop !== 'false' && hpop !== '';
  var ctrl = el.getAttribute('aria-controls');
  if (ctrl !== null) result.controls = ctrl;
  return result;
})()
`;

/**
 * v0.45: Well-known portal/popover selectors from Radix UI and Headless UI.
 */
export const PORTAL_SELECTORS = [
  '[data-radix-portal]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-dropdown-menu-content]',
  '[data-radix-popover-content]',
  '[data-headlessui-portal]',
].join(',');

/**
 * v0.45: Count portal/popover elements in document.body matching well-known selectors.
 * Diff pre- vs post-action; positive delta means a portal was opened.
 */
export const PORTAL_COUNT_SCRIPT = `
(function() {
  var sel = ${JSON.stringify(PORTAL_SELECTORS)};
  return document.body.querySelectorAll(sel).length;
})()
`;
