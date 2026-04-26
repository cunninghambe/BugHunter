// MutationObserver-based state-change detection (§ 3.5).
// Action-fire → (URL change OR network completion OR 30s ceiling).
// After window closes, check for change in target region.

import type { BugDetection, Action, PreState, PostState } from '../types.js';

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
// Returns a script that when evaluated starts observation.
export const MUTATION_OBSERVER_START_SCRIPT = `
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
window.__bhObserver.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
window.__bhObserverStart = Date.now();
true;
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
