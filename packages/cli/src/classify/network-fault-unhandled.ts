// v0.20: detectNetworkFaultUnhandled — fires when a fault-injected test shows
// no error UI, no console network errors, no URL change, and no rollback.

import type { PreState, PostState, BugDetection, NetworkFaultSpec, NetworkFaultContext, NetworkRequest } from '../types.js';
import { isDevServerPath } from './network.js';

const NETWORK_CONSOLE_KEYWORDS = /fetch|network|XMLHttpRequest|aborted|failed|offline|ERR_/i;
const ERROR_ELEMENT_SELECTORS = ['[role="alert"]', '[data-testid*="error"]', '.error'];

/**
 * Detects missing error handling under a network fault.
 * Returns null when the app handled the fault (showed error UI, navigated, etc.).
 */
export function detectNetworkFaultUnhandled(
  preState: PreState,
  postState: PostState,
  fault: NetworkFaultSpec,
  retryStormThresholdRps: number,
  asyncMaxWaitMs: number,
): BugDetection | null {
  // Only fires for fault kinds that should produce explicit error handling
  if (!isErrorHandlingFault(fault.kind)) return null;

  // Error UI present in post-state → app handled it
  if (postState.domErrorTextDetected) return null;

  // URL changed → app navigated to an error route (handled)
  if (postState.url !== preState.url) return null;

  // Network-specific console errors → app surfaced the problem
  const newErrors = postState.consoleErrors.slice(preState.consoleErrorCount);
  const hasNetworkConsoleError = newErrors.some(e => NETWORK_CONSOLE_KEYWORDS.test(e.text));
  if (hasNetworkConsoleError) return null;

  // Check post-state snapshot for error elements (best-effort via domErrorTextDetected)
  // domErrorTextDetected covers [role="alert"], .error, data-testid*=error per CHECK_DOM_ERROR_SCRIPT

  const appRequests = postState.networkRequests.filter(r => !isDevServerPath(r.path));

  const { retryStormDetected, observedRetryRateRps } = computeRetryStorm(
    appRequests,
    postState.mutationObserverWindowMs,
    retryStormThresholdRps,
  );

  const affectedEndpoints = uniqueEndpoints(appRequests);

  const networkFaultContext: NetworkFaultContext = {
    faultVariant: fault.kind,
    faultSpec: fault,
    affectedEndpoints,
    retryStormDetected,
    observedRetryRateRps,
    proof: 'no_error_ui_no_rollback',
  };

  return {
    kind: 'network_fault_unhandled',
    rootCause: `Under ${fault.kind} fault, UI showed no error state and no rollback after ${asyncMaxWaitMs}ms`,
    pageRoute: postState.url,
    networkFaultContext,
    networkRequests: postState.networkRequests,
    consoleErrors: postState.consoleErrors,
  };
}

/** Fault kinds that should produce explicit client-side error handling. */
function isErrorHandlingFault(kind: NetworkFaultSpec['kind']): boolean {
  return kind === 'offline'
    || kind === 'timeout_at_request'
    || kind === 'timeout_at_response'
    || kind === 'server_5xx'
    || kind === 'malformed_response'
    || kind === 'intermittent';
}

function computeRetryStorm(
  requests: NetworkRequest[],
  windowMs: number,
  thresholdRps: number,
): { retryStormDetected: boolean; observedRetryRateRps: number } {
  if (requests.length === 0 || windowMs <= 0) {
    return { retryStormDetected: false, observedRetryRateRps: 0 };
  }

  // Group by normalized path and count
  const byPath = new Map<string, number>();
  for (const req of requests) {
    const count = byPath.get(req.path) ?? 0;
    byPath.set(req.path, count + 1);
  }

  const windowSec = windowMs / 1000;
  let maxRps = 0;
  for (const count of byPath.values()) {
    const rps = count / windowSec;
    if (rps > maxRps) maxRps = rps;
  }

  return {
    retryStormDetected: maxRps > thresholdRps,
    observedRetryRateRps: Math.round(maxRps * 100) / 100,
  };
}

function uniqueEndpoints(requests: NetworkRequest[]): string[] {
  const seen = new Set<string>();
  for (const req of requests) seen.add(req.path);
  return [...seen];
}

export { ERROR_ELEMENT_SELECTORS };
