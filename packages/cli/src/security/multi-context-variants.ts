// v0.40 multi-context variant discriminated union + planner helpers.
// Produces test cases for the three multi-context patterns.

import type { MultiContextVariant, LifecycleEventKind, MultiContextConfig, ToolMeta } from '../types.js';

export type { MultiContextVariant };

export const ALL_LIFECYCLE_EVENTS: LifecycleEventKind[] = [
  'visibilitychange', 'pageshow', 'pagehide', 'freeze', 'resume',
];

const SENSITIVE_PREFIXES = [
  '/login', '/signup', '/payment', '/oauth', '/auth/',
  'login', 'signup', 'payment', 'oauth', 'auth',
];

/** True when the toolId matches a sensitive path that requires explicit opt-in. */
export function isSensitiveMultiContextTarget(toolId: string, aggressiveTargets: string[] = []): boolean {
  if (aggressiveTargets.some(pat => toolId.includes(pat))) return false;
  return SENSITIVE_PREFIXES.some(prefix => toolId.includes(prefix));
}

/** True when the tool's commutativityHint says it's commutative — skip state_divergence. */
export function isCommutativeHint(tool: ToolMeta): boolean {
  return tool.commutativityHint === 'commutative';
}

/** Resolve N from config, applying bounds (2 ≤ N ≤ 8). */
export function resolveN(config: MultiContextConfig): number {
  return Math.max(2, Math.min(8, config.n ?? 3));
}

/** Build all state_divergence variants for a (toolId, role) action tuple. */
export function plansForStateDivergence(
  toolId: string,
  nonCommutativeFields: string[] | undefined,
  config: MultiContextConfig,
): MultiContextVariant[] {
  const n = resolveN(config);
  return [{
    kind: 'state_divergence',
    n,
    gapMs: 0,
    settleMs: 5000,
    nonCommutativeFields: config.nonCommutativeFieldsByTool?.[toolId] ?? nonCommutativeFields,
  }];
}

/** Build all lifecycle_state_loss variants (one per lifecycle event) for a (toolId, role) tuple. */
export function plansForLifecycleStateLoss(config: MultiContextConfig): MultiContextVariant[] {
  const events = config.lifecycleEvents ?? ALL_LIFECYCLE_EVENTS;
  return events.map((lifecycleEvent): MultiContextVariant => ({
    kind: 'lifecycle_state_loss',
    lifecycleEvent,
    midActionDelayMs: 100,
    settleMs: 5000,
  }));
}

/** Build inconsistent_snapshot variants given a (writerToolId, readerEndpoint, resourceId) triple. */
export function plansForInconsistentSnapshot(
  readerEndpoint: string,
  resourceId: string,
  _config: MultiContextConfig,
): MultiContextVariant[] {
  return [{
    kind: 'inconsistent_snapshot',
    writerSettleMs: 5000,
    readerEndpoint,
    resourceId,
  }];
}

/**
 * Attempt to pair a mutating tool with a reader endpoint using a simple heuristic:
 * Given a writer like "PATCH /api/users/:id", look for a "GET /api/users/:id" reader
 * in the tool catalog. Returns null when no suitable reader is found.
 */
export function pairSnapshotReader(
  writerToolId: string,
  allToolIds: string[],
  snapshotPairs?: Array<{ writer: string; reader: string }>,
): string | null {
  const explicit = snapshotPairs?.find(p => p.writer === writerToolId);
  if (explicit !== undefined) return explicit.reader;

  const parts = writerToolId.split(' ');
  if (parts.length < 2) return null;
  const path = parts.slice(1).join(' ');
  const readerCandidate = `GET ${path}`;
  if (allToolIds.includes(readerCandidate)) return readerCandidate;

  const matchingGets = allToolIds.filter(tid => {
    if (!tid.startsWith('GET ')) return false;
    const getPath = tid.slice(4);
    return path.startsWith(getPath) || getPath.startsWith(path.split('/').slice(0, -1).join('/'));
  });
  return matchingGets[0] ?? null;
}
