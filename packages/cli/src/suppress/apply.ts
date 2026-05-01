import type { BugCluster } from '../types.js';
import type { SuppressedSample } from './types.js';
import { loadSuppressions, saveSuppressions } from './io.js';
import { matchPattern } from './match.js';
import { log } from '../log.js';

export type ApplySuppressionsArgs = {
  clusters: BugCluster[];
  projectDir: string;
  runId: string;
};

export type ApplySuppressionsResult = {
  clusters: BugCluster[];
  suppressedSamples: SuppressedSample[];
  suppressedCount: number;
};

const MAX_SAMPLES = 20;

const DISABLE_ENV = 'BUGHUNTER_DISABLE_SUPPRESSIONS';

export function applySuppressions(args: ApplySuppressionsArgs): ApplySuppressionsResult {
  if (process.env[DISABLE_ENV] === '1') {
    return { clusters: args.clusters, suppressedSamples: [], suppressedCount: 0 };
  }

  const suppressions = loadSuppressions(args.projectDir);
  if (suppressions.length === 0) {
    return { clusters: args.clusters, suppressedSamples: [], suppressedCount: 0 };
  }

  warnExpired(suppressions);

  const kept: BugCluster[] = [];
  const suppressedSamples: SuppressedSample[] = [];
  const severityWarnedRef = { value: false };
  const matchCountDeltas = new Map<string, number>();

  for (const cluster of args.clusters) {
    const result = matchPattern(cluster, suppressions, severityWarnedRef);
    if (!result.matched) {
      kept.push(cluster);
      continue;
    }

    const entry = result.entry;
    matchCountDeltas.set(entry.id, (matchCountDeltas.get(entry.id) ?? 0) + 1);

    if (suppressedSamples.length < MAX_SAMPLES) {
      suppressedSamples.push({
        clusterId: cluster.id,
        kind: cluster.kind,
        bugIdentity: cluster.signatureKey,
        matchedPattern: entry.pattern,
        suppressionId: entry.id,
      });
    }
  }

  if (matchCountDeltas.size > 0) {
    const now = new Date().toISOString();
    const updated = suppressions.map(entry => {
      const delta = matchCountDeltas.get(entry.id);
      if (delta === undefined) return entry;
      return {
        ...entry,
        matchCount: (entry.matchCount ?? 0) + delta,
        lastMatchedAt: now,
      };
    });
    try {
      saveSuppressions(args.projectDir, updated);
    } catch (err) {
      log.warn('bughunter: failed to write suppressions.json match counters', { reason: String(err) });
    }
  }

  return {
    clusters: kept,
    suppressedSamples,
    suppressedCount: args.clusters.length - kept.length,
  };
}

function warnExpired(suppressions: ReturnType<typeof loadSuppressions>): void {
  const now = Date.now();
  for (const entry of suppressions) {
    if (entry.expiresAt !== undefined && new Date(entry.expiresAt).getTime() < now) {
      log.warn(
        `bughunter: suppression ${entry.id} for pattern ${entry.pattern} expired on ${entry.expiresAt}; still applied (auto-prune in v0.29)`,
      );
    }
  }
}
