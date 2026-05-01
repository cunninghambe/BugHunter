// Pure IDOR outcome classifier (v0.21 §3.3).
// No IO — unit-testable, re-entrant.

import type { BugKind, IdorConfig } from '../types.js';

const ADMIN_ROLE_HINTS = ['admin', 'owner', 'superuser'];

/**
 * Input to the classifier for a single cross-role replay.
 */
export type IdorClassifyInput = {
  sourceRole: string;
  targetRole: string;
  /** sideEffectClass from ToolMeta. */
  sideEffectClass: 'safe' | 'mutating' | 'external';
  status: number;
  body: unknown;
  resourceType: string;
  idorConfig: IdorConfig | undefined;
};

/**
 * Output from the classifier — null when no finding.
 */
export type IdorOutcome = {
  kind: BugKind;
  tier: 'peer' | 'cross';
  sourceTier: string;
  targetTier: string;
  requiresAdjudication: boolean;
};

/**
 * Classify the outcome of a cross-role IDOR replay.
 *
 * Returns null (no finding) when:
 * - Response is not 2xx
 * - Response body is empty / null
 * - sideEffectClass is 'external' (skipped per spec §2.3)
 * - Cross-tier pair is suppressed by legitimizedHierarchies
 *
 * Returns an IdorOutcome for the three new kinds.
 */
export function classifyIdorOutcome(input: IdorClassifyInput): IdorOutcome | null {
  const { sourceRole, targetRole, sideEffectClass, status, body, idorConfig } = input;

  // External tools are always skipped
  if (sideEffectClass === 'external') return null;

  // Only 2xx triggers a finding (EC-6, EC-8)
  if (status < 200 || status >= 300) return null;

  // Rate-limiting returns null (EC-4)
  if (status === 429) return null;

  // Empty body is not a finding (EC-7)
  if (isEmptyResult(body)) return null;

  const sourceTierNum = resolveTier(sourceRole, idorConfig);
  const targetTierNum = resolveTier(targetRole, idorConfig);

  const isPeer = isPeerPair(sourceRole, targetRole, sourceTierNum, targetTierNum, idorConfig);

  if (isPeer) {
    const kind: BugKind = sideEffectClass === 'mutating' ? 'idor_horizontal_mutate' : 'idor_horizontal_read';
    return {
      kind,
      tier: 'peer',
      sourceTier: String(sourceTierNum),
      targetTier: String(targetTierNum),
      requiresAdjudication: false,
    };
  }

  // Cross-tier
  // Check legitimizedHierarchies before emitting
  if (isSuppressedByHierarchy(sourceRole, targetRole, sourceTierNum, targetTierNum, idorConfig)) {
    return null;
  }

  return {
    kind: 'idor_vertical_suspicious',
    tier: 'cross',
    sourceTier: String(sourceTierNum),
    targetTier: String(targetTierNum),
    requiresAdjudication: true,
  };
}

/**
 * Resolve the tier number for a role.
 * Uses config.idor.tiers first, then falls back to admin-hint inference.
 * Admin-hinted roles are tier 1; everyone else is tier 0.
 */
export function resolveTier(role: string, idorConfig: IdorConfig | undefined): number {
  const explicit = idorConfig?.tiers?.[role];
  if (explicit !== undefined) return explicit;

  const lower = role.toLowerCase();
  return ADMIN_ROLE_HINTS.some(h => lower.includes(h)) ? 1 : 0;
}

/**
 * Determine whether (sourceRole, targetRole) is a peer pair.
 * Explicit peerRoles override auto-inference.
 */
function isPeerPair(
  sourceRole: string,
  targetRole: string,
  sourceTierNum: number,
  targetTierNum: number,
  idorConfig: IdorConfig | undefined,
): boolean {
  const explicit = idorConfig?.peerRoles;
  if (explicit !== undefined) {
    const matched = explicit.some(
      ([a, b]) => (a === sourceRole && b === targetRole) || (a === targetRole && b === sourceRole),
    );
    if (matched) return true;
    // When peerRoles is set, only these pairs are peer — all others are cross-tier
    // unless the tiers are equal (spec §7.4: explicit peerRoles wins)
    return false;
  }

  return sourceTierNum === targetTierNum;
}

/**
 * Returns true when the (source → target) cross-tier direction matches a legitimizedHierarchies entry.
 * Matching is by role name, not tier number.
 */
function isSuppressedByHierarchy(
  sourceRole: string,
  targetRole: string,
  sourceTierNum: number,
  targetTierNum: number,
  idorConfig: IdorConfig | undefined,
): boolean {
  const hierarchies = idorConfig?.legitimizedHierarchies;
  if (hierarchies === undefined || hierarchies.length === 0) return false;

  // Semantics per spec §7.3: legitimizedHierarchies[].from is the *accessing* role,
  // legitimizedHierarchies[].to is the *data-owner* role.
  // E.g. { from: 'admin', to: 'alice' } means "admin reading alice's data is legitimate".
  // In our parameter convention: sourceRole = data owner, targetRole = accessor.
  return hierarchies.some(h => {
    // Role-name match: from=accessor(targetRole), to=owner(sourceRole)
    if (h.from === targetRole && h.to === sourceRole) return true;
    // Tier-number match: same direction convention
    if (h.from === String(targetTierNum) && h.to === String(sourceTierNum)) return true;
    return false;
  });
}

function isEmptyResult(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (Array.isArray(body) && body.length === 0) return true;
  if (typeof body === 'object' && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if ('data' in rec) {
      if (Array.isArray(rec.data) && rec.data.length === 0) return true;
      if (rec.data === null) return true;
    }
  }
  return false;
}
