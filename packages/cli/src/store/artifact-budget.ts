// Artifact budget management (§ 3.7).
// Full artifacts: first-3 + last-1 occurrences per cluster.
// Total budget capped at 4 GB; oldest full-artifact occurrences degrade to summaries.

import type { Occurrence, BugCluster } from '../types.js';
import { CLUSTER_FULL_ARTIFACT_CAP, CLUSTER_FULL_ARTIFACT_HEAD, CLUSTER_FULL_ARTIFACT_TAIL } from '../config.js';

// Determines which occurrences in a cluster get full artifacts.
// Full artifacts: first N + last M where cluster size <= CAP.
// For large clusters: first-3 + last-1 only.
export function computeFullArtifactSet(occurrences: Occurrence[]): Set<string> {
  const n = occurrences.length;
  const ids = occurrences.map(o => o.occurrenceId);
  const result = new Set<string>();

  if (n <= CLUSTER_FULL_ARTIFACT_CAP) {
    ids.forEach(id => result.add(id));
    return result;
  }

  // Large cluster: first-3 + last-1 only
  for (let i = 0; i < CLUSTER_FULL_ARTIFACT_HEAD && i < ids.length; i++) {
    result.add(ids[i]);
  }
  result.add(ids[ids.length - 1]);
  return result;
}

// Given total artifact size, degrade oldest full-artifact occurrences if over budget.
export function applyArtifactBudget(
  clusters: BugCluster[],
  budgetBytes: number,
  estimateArtifactSize: (occurrenceId: string) => number
): BugCluster[] {
  // Collect all full-artifact occurrences sorted by timestamp ascending (oldest first)
  const allFull: Array<{ clusterId: string; occurrenceId: string; timestamp: string; sizeBytes: number }> = [];

  for (const cluster of clusters) {
    for (const occ of cluster.occurrences) {
      if (!occ.fullArtifacts) continue;
      const ts = cluster.firstSeenAt;
      allFull.push({
        clusterId: cluster.id,
        occurrenceId: occ.occurrenceId,
        timestamp: ts,
        sizeBytes: estimateArtifactSize(occ.occurrenceId),
      });
    }
  }

  // Sort by timestamp ascending (oldest first)
  allFull.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let totalBytes = allFull.reduce((acc, x) => acc + x.sizeBytes, 0);
  const degraded = new Set<string>();

  for (const item of allFull) {
    if (totalBytes <= budgetBytes) break;
    degraded.add(item.occurrenceId);
    totalBytes -= item.sizeBytes;
  }

  if (degraded.size === 0) return clusters;

  return clusters.map(cluster => ({
    ...cluster,
    occurrences: cluster.occurrences.map(occ => {
      if (!degraded.has(occ.occurrenceId)) return occ;
      return {
        occurrenceId: occ.occurrenceId,
        role: occ.role,
        page: occ.page,
        action: occ.action,
        fullArtifacts: false as const,
        timestamp: new Date().toISOString(),
      };
    }),
  }));
}
