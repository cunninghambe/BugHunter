// v0.19 interleaving palette — variant construction + planner helpers.
// Pure module: no IO, no side effects.

import type { InterleavingVariant, RaceConditionsConfig, TestCase, ToolMeta } from '../types.js';

export const DEFAULT_VARIANTS: Array<InterleavingVariant['kind']> = [
  'double_submit',
  'click_then_navigate',
  'optimistic_revert',
  'interleaved_mutations',
];

// Sensitive toolId path prefixes that should not be race-tested without explicit opt-in.
const SENSITIVE_PREFIXES = ['/login', '/signup', '/payment'];

/**
 * Build a double_submit variant from config.
 */
export function makeDoubleSubmit(config: RaceConditionsConfig): InterleavingVariant & { kind: 'double_submit' } {
  return { kind: 'double_submit', gapMs: config.doubleSubmitGapMs ?? 50 };
}

/**
 * Build a click_then_navigate variant. targetRoute is the first available link on the page,
 * resolved by the planner.
 */
export function makeClickThenNavigate(targetRoute: string): InterleavingVariant & { kind: 'click_then_navigate' } {
  return { kind: 'click_then_navigate', targetRoute, preFireDelayMs: 0 };
}

/**
 * Build an optimistic_revert variant from config.
 */
export function makeOptimisticRevert(config: RaceConditionsConfig): InterleavingVariant & { kind: 'optimistic_revert' } {
  return {
    kind: 'optimistic_revert',
    forcedStatus: config.optimisticRevertForcedStatus ?? 500,
    forcedBody: '{"error":"forced"}',
  };
}

/**
 * Build an interleaved_mutations variant.
 */
export function makeInterleavedMutations(
  siblingActionId: string,
  config: RaceConditionsConfig,
): InterleavingVariant & { kind: 'interleaved_mutations' } {
  return {
    kind: 'interleaved_mutations',
    siblingActionId,
    gapMs: 0,
    // Conservative default: consensusRuns: 3 (open question 3 — 3 is the spec default,
    // enough for majority voting without excessive runtime cost).
    consensusRuns: config.consensusRuns ?? 3,
  };
}

/**
 * Build a cross_tab variant.
 */
export function makeCrossTab(_config: RaceConditionsConfig): InterleavingVariant & { kind: 'cross_tab' } {
  return { kind: 'cross_tab', settleMs: 5000 };
}

/**
 * Whether a toolId should be skipped for double_submit due to being a sensitive path.
 * Protected paths: login, signup, payment — user must opt in via aggressiveRaceTargets.
 */
export function isSensitiveToolPath(toolPath: string, aggressiveTargets: string[] = []): boolean {
  const normalized = toolPath.toLowerCase();
  for (const prefix of SENSITIVE_PREFIXES) {
    if (normalized.includes(prefix)) {
      // Allow if user explicitly opted in via aggressiveRaceTargets
      if (aggressiveTargets.some(t => normalized.includes(t.toLowerCase()))) return false;
      return true;
    }
  }
  return false;
}

/**
 * Whether a toolId is known-idempotent per config.
 * Conservative default: open question 6 — check toolId string equality only.
 */
export function isIdempotentTool(toolId: string, idempotentToolIds: string[] = []): boolean {
  return idempotentToolIds.includes(toolId);
}

/**
 * Normalise a tool path for same-resource pairing heuristic.
 * Replaces path segments that look like IDs (all digits, UUID-like) with ':id'.
 * Uses exact normalized path equality (no prefix match) per EC-13.
 */
export function normalizeToolPath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

type MutatingActionTuple = {
  role: string;
  toolId: string;
  toolPath: string;
  /** The representative TestCase with palette 'happy' that this tuple was derived from. */
  testCase: TestCase;
};

/**
 * From a set of happy-palette UI test cases, extract distinct (role, toolId) mutating-action tuples.
 * Filters to:
 *   - palette === 'happy'
 *   - action.via === 'ui'
 *   - action has a toolId (form-submit or API tool)
 * toolMeta is consulted for sideEffectClass = 'mutating'.
 */
export function extractMutatingActionTuples(
  testCases: TestCase[],
  toolMap: Map<string, ToolMeta>,
): MutatingActionTuple[] {
  const seen = new Set<string>();
  const result: MutatingActionTuple[] = [];

  for (const tc of testCases) {
    if (tc.action.via !== 'ui') continue;
    if (tc.action.palette !== 'happy') continue;
    const toolId = tc.action.toolId;
    if (toolId === undefined || toolId === '') continue;
    const meta = toolMap.get(toolId);
    if (meta === undefined) continue;
    if (meta.sideEffectClass !== 'mutating') continue;

    const key = `${tc.role}|${toolId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ role: tc.role, toolId, toolPath: meta.path, testCase: tc });
  }

  return result;
}

/**
 * Pair sibling actions for interleaved_mutations.
 * Pairing strategy (conservative default for open question 4 — auto-pair with explicit override):
 *   1. If config.pairedToolIds is set, use those explicit pairs.
 *   2. Otherwise, auto-pair within the same role where normalizeToolPath(pathA) === normalizeToolPath(pathB)
 *      and toolId differs. First pair wins per (role, normalizedPath).
 *
 * Returns a Map from toolId → siblingToolId for each role+toolId that has a sibling.
 */
export function pairSiblings(
  tuples: MutatingActionTuple[],
  config: RaceConditionsConfig,
): Map<string, string> {
  const pairs = new Map<string, string>();

  // Explicit pairs take priority
  if (config.pairedToolIds !== undefined && config.pairedToolIds.length > 0) {
    for (const [a, b] of config.pairedToolIds) {
      pairs.set(a, b);
      pairs.set(b, a);
    }
    return pairs;
  }

  // Auto-pair: group by (role, normalizedPath), take first two distinct toolIds
  const grouped = new Map<string, string[]>(); // key: role|normalizedPath → toolIds[]
  for (const t of tuples) {
    const normPath = normalizeToolPath(t.toolPath);
    const key = `${t.role}|${normPath}`;
    const group = grouped.get(key) ?? [];
    if (!group.includes(t.toolId)) group.push(t.toolId);
    grouped.set(key, group);
  }

  for (const toolIds of grouped.values()) {
    if (toolIds.length >= 2) {
      pairs.set(toolIds[0], toolIds[1]);
      pairs.set(toolIds[1], toolIds[0]);
    }
  }

  return pairs;
}
