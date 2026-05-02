// v0.20: Network-fault runner helpers — cost capping, denylist filter, telemetry.
// The runner is not a standalone phase; it's a planner output + executor branch
// (per SPEC_V20_NETWORK_FAULTS.md § 3.1).

import type { NetworkFaultSpec, NetworkFaultsTelemetry } from '../types.js';
import { resolveFaultPalette, isToolDenylisted } from './network-fault-palette.js';

export type NetworkFaultRunnerConfig = {
  enabled: boolean;
  variants?: NetworkFaultSpec[];
  toolDenylist?: string[];
  maxFaultTests?: number;
  retryStormThresholdRps?: number;
  perTestMaxMs?: number;
  includeNavigation?: boolean;
  asyncMaxWaitMs?: number;
};

/** Resolve the per-test wall-clock cap for fault tests. */
export function resolveFaultPerTestMaxMs(config: NetworkFaultRunnerConfig): number {
  if (config.perTestMaxMs !== undefined) return config.perTestMaxMs;
  const asyncMax = config.asyncMaxWaitMs ?? 30_000;
  return Math.min(asyncMax * 1.5, 60_000);
}

/** Build initial empty telemetry for a fault-injection run. */
export function makeEmptyFaultTelemetry(): NetworkFaultsTelemetry {
  return {
    enabled: true,
    faultsAttempted: 0,
    faultsSucceeded: 0,
    faultsSkipped: [],
    detectionsByKind: {},
    retryStormsDetected: 0,
    durationMs: 0,
  };
}

/** Add a skip reason to telemetry (mutates in place). */
export function addFaultSkip(telemetry: NetworkFaultsTelemetry, reason: string): void {
  const entry = telemetry.faultsSkipped.find(s => s.reason === reason);
  if (entry !== undefined) {
    entry.count += 1;
  } else {
    telemetry.faultsSkipped.push({ reason, count: 1 });
  }
}

export { resolveFaultPalette, isToolDenylisted };
