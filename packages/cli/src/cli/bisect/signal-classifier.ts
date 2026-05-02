// v0.35: per-kind ReplayResult → BugSignal classifier.
// Determines if the bug is present, absent, or inconclusive at the current commit.

import type { ReplayResult } from '../../repro/replay.js';
import type { BugSignal, BisectClusterSnapshot } from '../../types.js';
import type { BugKind } from '../../types.js';

/** BugKinds supported by the bisect signal classifier (observable from ReplayResult). */
const SUPPORTED_KINDS = new Set<BugKind>([
  'dom_error_text',
  'unhandled_exception',
  'network_5xx',
  'network_4xx_unexpected',
  'xss_reflected',
  'xss_dom',
  'xss_stored',
  'console_error',
]);

/** BugKinds that are skipped because replay can't observe them deterministically. */
const NONDETERMINISTIC_KINDS = new Set<BugKind>([
  'race_condition_double_submit',
  'race_condition_click_navigate',
  'race_condition_optimistic_revert',
  'race_condition_interleaved_mutations',
  'race_condition_cross_tab',
]);

/** BugKinds that require the full detection sub-pipeline (not replay-observable). */
function isUnsupportedKind(kind: BugKind): boolean {
  return !SUPPORTED_KINDS.has(kind) && !NONDETERMINISTIC_KINDS.has(kind);
}

/**
 * Classify whether the bug is present at the current commit given the replay result.
 * Returns a BugSignal: present/absent with confidence, or a skip indication.
 */
export function classifySignal(
  result: ReplayResult,
  cluster: BisectClusterSnapshot,
): BugSignal | { skip: true; reason: 'bisect_unsupported_kind' | 'bisect_nondeterministic_kind' } {
  if (NONDETERMINISTIC_KINDS.has(cluster.kind)) {
    return { skip: true, reason: 'bisect_nondeterministic_kind' };
  }
  if (isUnsupportedKind(cluster.kind)) {
    return { skip: true, reason: 'bisect_unsupported_kind' };
  }

  if (!result.ok) {
    // Replay failed entirely — can't determine presence
    return { present: false, confidence: 'low', reason: `replay_failed: ${result.error ?? 'unknown'}` };
  }

  return classifyByKind(result, cluster);
}

function classifyByKind(result: ReplayResult, cluster: BisectClusterSnapshot): BugSignal {
  const { domSnapshot, consoleErrors, networkRequests } = result.observation;

  switch (cluster.kind) {
    case 'dom_error_text':
      return classifyDomErrorText(domSnapshot, cluster);

    case 'unhandled_exception':
    case 'console_error':
      return classifyConsoleError(consoleErrors, cluster);

    case 'network_5xx':
    case 'network_4xx_unexpected':
      return classifyNetworkStatus(networkRequests, cluster);

    case 'xss_reflected':
    case 'xss_dom':
    case 'xss_stored':
      return classifyXss(domSnapshot, cluster);

    default:
      return { present: false, confidence: 'low', reason: 'unsupported_kind_fallthrough' };
  }
}

function classifyDomErrorText(domSnapshot: string | undefined, cluster: BisectClusterSnapshot): BugSignal {
  if (domSnapshot === undefined || domSnapshot === '') {
    return { present: false, confidence: 'low', reason: 'no_dom_snapshot' };
  }
  const errorText = cluster.errorText ?? extractErrorText(cluster.rootCause);
  if (errorText === '') {
    return { present: false, confidence: 'low', reason: 'no_error_text_in_cluster' };
  }
  if (domSnapshot.includes(errorText)) {
    return { present: true, confidence: 'high', reason: `dom contains "${errorText.slice(0, 80)}"` };
  }
  return { present: false, confidence: 'high', reason: `dom does not contain "${errorText.slice(0, 80)}"` };
}

function extractErrorText(rootCause: string): string {
  // rootCause format examples:
  //   'dom_error_text: "Something went wrong"'
  //   'Error text "404 Not Found" found on /products'
  const quoted = rootCause.match(/"([^"]{3,}?)"/);
  if (quoted?.[1] !== undefined) return quoted[1];
  // Last resort: take content after first colon
  const colonPart = rootCause.indexOf(':');
  if (colonPart !== -1) return rootCause.slice(colonPart + 1).trim().slice(0, 120);
  return '';
}

function classifyConsoleError(consoleErrors: unknown[], cluster: BisectClusterSnapshot): BugSignal {
  if (consoleErrors.length === 0) {
    return { present: false, confidence: 'high', reason: 'no_console_errors' };
  }
  const key = cluster.signatureKey ?? extractSignatureFragment(cluster.rootCause);
  if (key === '') {
    // Can't match without a key — assume present if any console error exists
    return { present: true, confidence: 'low', reason: 'console_errors_present_no_key' };
  }
  const matched = consoleErrors.some(e => {
    const text = typeof e === 'object' && e !== null && 'text' in e
      ? String((e as { text: unknown }).text)
      : String(e);
    return text.includes(key);
  });
  if (matched) return { present: true, confidence: 'high', reason: `console error matches key "${key.slice(0, 60)}"` };
  return { present: false, confidence: 'high', reason: `no console error matches key "${key.slice(0, 60)}"` };
}

function extractSignatureFragment(rootCause: string): string {
  // Take up to 60 chars of the rootCause as a loose match key
  return rootCause.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function classifyNetworkStatus(networkRequests: unknown[], cluster: BisectClusterSnapshot): BugSignal {
  const endpoint = cluster.endpoint;
  const expected5xx = cluster.kind === 'network_5xx';
  const expected4xx = cluster.kind === 'network_4xx_unexpected';

  if (networkRequests.length === 0) {
    return { present: false, confidence: 'low', reason: 'no_network_requests_captured' };
  }

  for (const req of networkRequests) {
    if (typeof req !== 'object' || req === null) continue;
    const r = req as { path?: string; status?: number };
    if (endpoint !== undefined && r.path?.includes(endpoint) !== true) continue;
    const status = r.status ?? 0;
    if (expected5xx && status >= 500 && status < 600) {
      return { present: true, confidence: 'high', reason: `${r.path ?? '?'} returned ${status}` };
    }
    if (expected4xx && status >= 400 && status < 500) {
      return { present: true, confidence: 'high', reason: `${r.path ?? '?'} returned ${status}` };
    }
  }
  return { present: false, confidence: 'high', reason: `no matching ${expected5xx ? '5xx' : '4xx'} for ${endpoint ?? 'any endpoint'}` };
}

function classifyXss(domSnapshot: string | undefined, cluster: BisectClusterSnapshot): BugSignal {
  if (domSnapshot === undefined || domSnapshot === '') {
    return { present: false, confidence: 'low', reason: 'no_dom_snapshot' };
  }
  const canary = cluster.xssCanary ?? extractXssCanary(cluster.rootCause);
  if (canary === '') {
    return { present: false, confidence: 'low', reason: 'no_xss_canary_in_cluster' };
  }
  if (domSnapshot.includes(canary)) {
    return { present: true, confidence: 'high', reason: `canary "${canary.slice(0, 40)}" found in DOM` };
  }
  return { present: false, confidence: 'high', reason: `canary "${canary.slice(0, 40)}" not in DOM` };
}

function extractXssCanary(rootCause: string): string {
  const match = rootCause.match(/canary[:\s]+([a-z0-9_-]{8,})/i);
  return match?.[1] ?? '';
}
