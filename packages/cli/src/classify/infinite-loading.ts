// v0.20: detectInfiniteLoading — fires when a spinner/skeleton/aria-busy region
// appears after action fire and is still present past asyncMaxWaitMs.

import type { PreState, PostState, BugDetection, NetworkFaultSpec, NetworkFaultContext } from '../types.js';

/** CSS selectors that indicate a loading state. */
const LOADING_INDICATORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '.loading',
  '.spinner',
  '.skeleton',
];

/**
 * Script injected into the page to check for loading indicators.
 * Returns true when ANY loading indicator is visible.
 */
export const CHECK_LOADING_SCRIPT = `(function(){
  var selectors = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '.loading',
    '.spinner',
    '.skeleton'
  ];
  return selectors.some(function(sel) {
    var el = document.querySelector(sel);
    if (!el) return false;
    var style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  });
})()`;

/**
 * Detects an infinite loading state: a spinner appeared after the action
 * and is still present past asyncMaxWaitMs with no success or error state.
 */
export function detectInfiniteLoading(
  preState: PreState,
  postState: PostState,
  fault: NetworkFaultSpec,
  preHadSpinner: boolean,
  postHasSpinner: boolean,
): BugDetection | null {
  // Spinner must be NEW (appeared after action, not pre-existing)
  if (preHadSpinner) return null;

  // No spinner present post-action → no infinite loading
  if (!postHasSpinner) return null;

  // Error UI present → app showed an error state (handled, not infinite)
  if (postState.domErrorTextDetected) return null;

  // URL changed → app navigated (handled)
  if (postState.url !== preState.url) return null;

  const affectedEndpoints = [...new Set(postState.networkRequests.map(r => r.path))];

  const networkFaultContext: NetworkFaultContext = {
    faultVariant: fault.kind,
    faultSpec: fault,
    affectedEndpoints,
    retryStormDetected: false,
    observedRetryRateRps: 0,
    proof: 'spinner_persists',
  };

  return {
    kind: 'infinite_loading',
    rootCause: `Under ${fault.kind} fault, loading spinner present at action time and still present after ${postState.mutationObserverWindowMs}ms — no success or error state`,
    pageRoute: postState.url,
    networkFaultContext,
    networkRequests: postState.networkRequests,
    consoleErrors: postState.consoleErrors,
  };
}

export { LOADING_INDICATORS };
