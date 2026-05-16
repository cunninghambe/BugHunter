// v0.44: matchClustersToGold — pure matching function.
// Primary match: bugIdentity. Fallback: structural (kind + normalizedLocation + normalizedMessage).

import type { BugCluster } from '../types.js';
import type { GoldEntry } from './gold.js';
import type { MatchOutcome } from './types.js';

export type MatchResult = {
  outcomes: MatchOutcome[];
  /** Structural-match ambiguities: goldId → list of candidate clusterIds. Fatal if non-empty. */
  ambiguities: Array<{ goldId: string; candidates: string[] }>;
};

/**
 * Match clusters to gold entries. Pure function — no I/O.
 *
 * Returns discriminated MatchOutcomes for every gold entry and every unmatched cluster.
 * Fatal ambiguities (multiple structural candidates for one gold) are returned separately.
 */
export function matchClustersToGold(
  clusters: BugCluster[],
  gold: GoldEntry[],
): MatchResult {
  // Step 1: validate that all clusters have bugIdentity (V27 hard-requirement)
  const missingIdentity = clusters.filter(c => c.bugIdentity === undefined);
  if (missingIdentity.length > 0) {
    // We surface this as a special error outcome so the caller can fail with exit code 4
    throw new MissingBugIdentityError(
      `${missingIdentity.length} cluster(s) are missing bugIdentity — this requires V27 to be wired. ` +
      `Cluster ids: ${missingIdentity.slice(0, 5).map(c => c.id).join(', ')}`,
    );
  }

  // Step 2: build lookup indexes
  const byBugIdentity = new Map<string, BugCluster>();
  for (const c of clusters) {
    if (c.bugIdentity !== undefined) {
      if (byBugIdentity.has(c.bugIdentity)) {
        throw new DuplicateBugIdentityError(
          `Multiple clusters share bugIdentity "${c.bugIdentity}" — this indicates a V27 clustering bug.`,
        );
      }
      byBugIdentity.set(c.bugIdentity, c);
    }
  }

  const byStructural = new Map<string, BugCluster[]>();
  for (const c of clusters) {
    // Structural key uses cluster's own kind and rootCause as normalizedMessage proxy.
    // Gold structuralMatch.normalizedLocation and normalizedMessage are compared against
    // cluster.signatureKey (which encodes both location and message context).
    // We index by kind only and do per-entry comparison below.
    const key = c.kind;
    const existing = byStructural.get(key) ?? [];
    existing.push(c);
    byStructural.set(key, existing);
  }

  // Step 3: match each gold entry
  const outcomes: MatchOutcome[] = [];
  const ambiguities: Array<{ goldId: string; candidates: string[] }> = [];
  const consumedClusterIds = new Set<string>();
  const consumedBugIdentities = new Set<string>();

  for (const entry of gold) {
    if (entry.bugIdentity !== undefined) {
      // Primary: exact bugIdentity match — each bugIdentity may only be consumed once
      const cluster = byBugIdentity.get(entry.bugIdentity);
      if (cluster !== undefined && !consumedBugIdentities.has(entry.bugIdentity)) {
        outcomes.push({
          kind: 'true_positive',
          goldId: entry.goldId,
          clusterId: cluster.id,
          matchVia: 'bugIdentity',
          bugKind: entry.kind,
        });
        consumedClusterIds.add(cluster.id);
        consumedBugIdentities.add(entry.bugIdentity);
      } else if (entry.expected === 'detector_fires') {
        outcomes.push({
          kind: 'false_negative',
          goldId: entry.goldId,
          bugKind: entry.kind,
          reason: 'no_cluster_with_matching_identity',
        });
      } else {
        // expected === 'detector_silent'
        outcomes.push({
          kind: 'true_negative',
          goldId: entry.goldId,
          bugKind: entry.kind,
        });
      }
    } else {
      // Fallback: structural match
      const sm = entry.structuralMatch;
      if (sm === undefined) {
        // This should not happen due to Zod validation, but be safe
        outcomes.push({
          kind: 'false_negative',
          goldId: entry.goldId,
          bugKind: entry.kind,
          reason: 'no_bugIdentity_and_no_structuralMatch',
        });
        continue;
      }

      const candidates = (byStructural.get(entry.kind) ?? []).filter(c => {
        if (consumedClusterIds.has(c.id)) return false;
        // Match on normalizedLocation: compare against signatureKey
        const sig = c.signatureKey ?? '';
        return (
          sig.includes(sm.normalizedLocation) ||
          sm.normalizedLocation === '*'
        ) && (
          sig.includes(sm.normalizedMessage) ||
          c.rootCause.toLowerCase().includes(sm.normalizedMessage.toLowerCase()) ||
          sm.normalizedMessage === '*'
        );
      });

      if (candidates.length === 1) {
        const cluster = candidates[0];
        outcomes.push({
          kind: 'true_positive',
          goldId: entry.goldId,
          clusterId: cluster.id,
          matchVia: 'structural',
          bugKind: entry.kind,
        });
        consumedClusterIds.add(cluster.id);
      } else if (candidates.length > 1) {
        ambiguities.push({ goldId: entry.goldId, candidates: candidates.map(c => c.id) });
        // Don't emit an outcome for ambiguous matches — caller handles as fatal
      } else if (entry.expected === 'detector_fires') {
        outcomes.push({
          kind: 'false_negative',
          goldId: entry.goldId,
          bugKind: entry.kind,
          reason: 'no_structural_match',
        });
      } else {
        outcomes.push({
          kind: 'true_negative',
          goldId: entry.goldId,
          bugKind: entry.kind,
        });
      }
    }
  }

  // Step 4: any unmatched cluster → false_positive
  for (const cluster of clusters) {
    if (!consumedClusterIds.has(cluster.id)) {
      outcomes.push({
        kind: 'false_positive',
        clusterId: cluster.id,
        bugKind: cluster.kind,
        rootCause: cluster.rootCause,
      });
    }
  }

  return { outcomes, ambiguities };
}

/** Thrown when clusters lack bugIdentity (V27 not wired). */
export class MissingBugIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBugIdentityError';
  }
}

/** Thrown when two clusters share the same bugIdentity in one run. */
export class DuplicateBugIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateBugIdentityError';
  }
}

/**
 * Extract bugIdentity updates for --record-identities.
 * Returns identity update specs for all structural matches.
 */
export function extractIdentityUpdates(
  outcomes: MatchOutcome[],
  clusters: BugCluster[],
  goldEntries: GoldEntry[],
): Array<{ goldId: string; newIdentity: string; oldIdentity?: string }> {
  const clusterById = new Map(clusters.map(c => [c.id, c]));
  const goldByGoldId = new Map(goldEntries.map(e => [e.goldId, e]));
  const updates: Array<{ goldId: string; newIdentity: string; oldIdentity?: string }> = [];

  for (const outcome of outcomes) {
    if (outcome.kind !== 'true_positive' || outcome.matchVia !== 'structural') continue;
    const cluster = clusterById.get(outcome.clusterId);
    if (cluster?.bugIdentity === undefined) continue;
    const gold = goldByGoldId.get(outcome.goldId);
    updates.push({
      goldId: outcome.goldId,
      newIdentity: cluster.bugIdentity,
      oldIdentity: gold?.bugIdentity,
    });
  }

  return updates;
}
