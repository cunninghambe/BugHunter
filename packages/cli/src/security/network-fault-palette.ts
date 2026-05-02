// v0.20: eight-variant network-fault palette.
// Default subset excludes slow_3g and timeout_at_request (they overlap with
// high_latency and timeout_at_response; opt in via networkFaults.variants).

import type { NetworkFaultSpec } from '../types.js';

export type { NetworkFaultSpec };

/**
 * Default six-variant fault palette. slow_3g and timeout_at_request are NOT
 * included by default — they overlap with high_latency and timeout_at_response.
 */
export const DEFAULT_FAULT_PALETTE: readonly NetworkFaultSpec[] = [
  { kind: 'offline' },
  { kind: 'high_latency', latencyMs: 5000 },
  { kind: 'timeout_at_response' },
  { kind: 'server_5xx', status: 500 },
  { kind: 'intermittent', dropEveryN: 2 },
  { kind: 'malformed_response', mode: 'truncated_json' },
];

/** All eight variants for documentation / opt-in reference. */
export const ALL_FAULT_VARIANTS: readonly NetworkFaultSpec[] = [
  ...DEFAULT_FAULT_PALETTE,
  { kind: 'slow_3g' },
  { kind: 'timeout_at_request' },
];

/**
 * Resolve the active fault palette from config.
 * Returns the config-supplied variants when set; falls back to DEFAULT_FAULT_PALETTE.
 */
export function resolveFaultPalette(variants?: NetworkFaultSpec[]): readonly NetworkFaultSpec[] {
  if (variants !== undefined && variants.length > 0) return variants;
  return DEFAULT_FAULT_PALETTE;
}

/**
 * Filter a tool id against the denylist.
 * Returns true when the tool should be skipped (matched or external).
 */
export function isToolDenylisted(toolId: string, denylist: string[]): boolean {
  return denylist.some(pattern => matchesGlob(toolId, pattern));
}

/**
 * Minimal glob matcher supporting '*' wildcard (not '**').
 * Converts glob pattern to a RegExp with anchored start/end.
 */
function matchesGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
