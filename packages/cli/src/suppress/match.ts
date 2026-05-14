import micromatch from 'micromatch';
import type { BugCluster } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { SuppressionEntry } from './types.js';
import { log } from '../log.js';

const MICROMATCH_OPTS = { dot: false, contains: false } as const;

/** The five precedence tiers, ordered highest-to-lowest. */
const PRECEDENCE: ReadonlyArray<string> = ['bugIdentity', 'kind', 'endpoint', 'suspectedFile', 'severity'];

export type MatchResult = {
  matched: true;
  entry: SuppressionEntry;
} | {
  matched: false;
};

export function extractEndpoint(cluster: BugCluster): string | undefined {
  const toolId = cluster.occurrences[0]?.action.toolId;
  if (toolId !== undefined && toolId !== '') return toolId;

  const m1 = /tool (\S+) failed/.exec(cluster.rootCause);
  if (m1 !== null) return m1[1];

  const m2 = /links to (\S+) which returned/.exec(cluster.rootCause);
  if (m2 !== null) return m2[1];

  return undefined;
}

function matchesBugIdentity(cluster: BugCluster, value: string): boolean {
  // Prefer cluster.bugIdentity (16-char hex) when present; fall back to
  // cluster.signatureKey for pre-v0.27 clusters that lack a computed identity.
  const identity = cluster.bugIdentity ?? cluster.signatureKey ?? '';
  return identity !== '' && identity === value;
}

function matchesKind(cluster: BugCluster, value: string): boolean {
  return cluster.kind === value;
}

function matchesEndpoint(cluster: BugCluster, glob: string): boolean {
  const endpoint = extractEndpoint(cluster);
  if (endpoint === undefined || endpoint === '') return false;
  return micromatch.isMatch(endpoint, glob, MICROMATCH_OPTS);
}

function matchesSuspectedFile(cluster: BugCluster, glob: string): boolean {
  return cluster.suspectedFiles.some(f => micromatch.isMatch(suspectedFilePath(f), glob, MICROMATCH_OPTS));
}

function matchesSeverity(cluster: BugCluster, value: string): boolean {
  return cluster.severity !== undefined && cluster.severity === value;
}

function clusterMatchesEntry(cluster: BugCluster, entry: SuppressionEntry): boolean {
  const colonIdx = entry.pattern.indexOf(':');
  const prefix = entry.pattern.slice(0, colonIdx);
  const value = entry.pattern.slice(colonIdx + 1);

  switch (prefix) {
    case 'bugIdentity': return matchesBugIdentity(cluster, value);
    case 'kind': return matchesKind(cluster, value);
    case 'endpoint': return matchesEndpoint(cluster, value);
    case 'suspectedFile': return matchesSuspectedFile(cluster, value);
    case 'severity': return matchesSeverity(cluster, value);
    default: return false;
  }
}

/**
 * Find the first matching suppression entry for a cluster, respecting
 * precedence: bugIdentity > kind > endpoint > suspectedFile > severity.
 * Within the same precedence tier, first file-order entry wins.
 * `severityWarnedRef` is mutated to true on the first severity:* pattern seen,
 * so the caller can emit the warning only once per run.
 */
export function matchPattern(
  cluster: BugCluster,
  entries: SuppressionEntry[],
  severityWarnedRef: { value: boolean },
): MatchResult {
  for (const tier of PRECEDENCE) {
    for (const entry of entries) {
      if (!entry.pattern.startsWith(`${tier}:`)) continue;
      if (tier === 'severity') {
        if (!severityWarnedRef.value) {
          log.warn('bughunter: severity:* pattern present but cluster.severity unset; awaiting v0.29');
          severityWarnedRef.value = true;
        }
        continue;
      }
      if (clusterMatchesEntry(cluster, entry)) return { matched: true, entry };
    }
  }
  return { matched: false };
}
