// Phase 5: cluster — group by stable signature; cap full-artifact occurrences (§ 3.6, 3.7).

import type { BugDetection, BugCluster, Occurrence, OccurrenceFull, OccurrenceSummary, TestCase, PreState, PostState } from '../types.js';
import { clusterSignature, extractNormalizedFields } from '../cluster/signature.js';
import { computeFullArtifactSet } from '../store/artifact-budget.js';
import { normalizePath } from '../classify/network.js';
import { createId } from '@paralleldrive/cuid2';

export type ClusterOptions = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  runId: string;
  projectDir: string;
  actionLogsDir: string;
  screenshotsDir: string;
  domDir: string;
  consoleDir: string;
  networkDir: string;
  maxClusters: number;
  /**
   * Map from testId → occurrenceId minted by the executor. The cluster
   * phase reuses these ids when forming OccurrenceSummary so that
   * recorded artifact paths match the files written during execute.
   * Required: every detection's testId must be present.
   * All detections from the same testId share one occurrenceId — the
   * artifacts capture the test, not the individual bug.
   */
  occurrenceIdByTestId: Map<string, string>;
  /** Per-test pre/post observation captured by the executor. When absent, OccurrenceFull
   * falls back to an empty PostState (preserves backward-compat for unit tests). */
  stateByTestId?: Map<string, { preState: PreState; postState: PostState }>;
};

export type ClusterResult = {
  clusters: BugCluster[];
  capped: boolean;
};

export function runCluster(opts: ClusterOptions): ClusterResult {
  const { detections, testCases, runId, maxClusters } = opts;
  const clusterMap = new Map<string, BugCluster>();
  const testCaseMap = new Map(testCases.map(t => [t.id, t]));
  let capped = false;

  for (const { testId, detection } of detections) {
    const sig = clusterSignature(detection);
    const tc = testCaseMap.get(testId);

    // After cap: append to existing clusters only, never create new
    if (!clusterMap.has(sig)) {
      if (clusterMap.size >= maxClusters) {
        capped = true;
        continue; // Skip creating 201st cluster
      }
      const { errorMessageNormalized, stackTraceFingerprint } = extractNormalizedFields(detection);
      const now = new Date().toISOString();
      clusterMap.set(sig, {
        id: createId(),
        runId,
        kind: detection.kind,
        rootCause: detection.rootCause,
        stackTraceFingerprint,
        errorMessageNormalized,
        firstSeenAt: now,
        lastSeenAt: now,
        clusterSize: 0,
        occurrences: [],
        suspectedFiles: [],
        fixHints: generateFixHints(detection),
        thirdPartyOrGenerated: false,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set just above or on previous iteration; cannot be absent here
    const cluster = clusterMap.get(sig)!;
    const occId = opts.occurrenceIdByTestId.get(testId);
    if (!occId) {
      throw new Error(
        `cluster: missing occurrenceId for testId ${testId}; ` +
        `executor must populate occurrenceIdByTestId for every TestResult`,
      );
    }
    const now = new Date().toISOString();

    cluster.lastSeenAt = now;
    cluster.clusterSize++;

    // Determine if this occurrence gets full artifacts (computed after all are added)
    const summaryOcc: OccurrenceSummary = {
      occurrenceId: occId,
      testId,
      role: tc?.role ?? 'unknown',
      page: tc?.page ?? detection.pageRoute ?? '',
      action: tc?.action ?? { kind: 'click', via: 'ui', expectedOutcome: 'unknown', palette: 'happy' },
      fullArtifacts: false,
      timestamp: now,
    };
    cluster.occurrences.push(summaryOcc);
  }

  // Apply full-artifact marking: first-3 + last-1 per cluster (when size > 50)
  for (const cluster of clusterMap.values()) {
    const fullSet = computeFullArtifactSet(cluster.occurrences);
    cluster.occurrences = cluster.occurrences.map((occ): Occurrence => {
      if (!fullSet.has(occ.occurrenceId)) return occ;
      return upgradeToFull(occ, opts);
    });

    // Flag third-party clusters
    cluster.thirdPartyOrGenerated = cluster.suspectedFiles.some(
      f => /node_modules\/|\.next\/|dist\/|build\//.test(f)
    );
  }

  const clusters = Array.from(clusterMap.values());
  annotateRelatedClusters(clusters);

  return { clusters, capped };
}

function upgradeToFull(occ: Occurrence, opts: ClusterOptions): OccurrenceFull {
  const { actionLogsDir, screenshotsDir, domDir, consoleDir, networkDir, stateByTestId } = opts;
  const captured = occ.testId ? stateByTestId?.get(occ.testId) : undefined;

  const preState: PreState = captured?.preState ?? { url: occ.page, title: '', consoleErrorCount: 0 };
  const postState: PostState = captured?.postState ?? {
    url: occ.page,
    title: '',
    consoleErrors: [],
    networkRequests: [],
    domErrorTextDetected: false,
    mutationObserverWindowMs: 0,
  };

  return {
    occurrenceId: occ.occurrenceId,
    testId: occ.testId,
    role: occ.role,
    page: occ.page,
    action: occ.action,
    preState,
    postState,
    fullArtifacts: true,
    screenshotPath: `${screenshotsDir}/${occ.occurrenceId}.png`,
    domSnapshotPath: `${domDir}/${occ.occurrenceId}.html`,
    consoleLogPath: `${consoleDir}/${occ.occurrenceId}.log`,
    networkLogPath: `${networkDir}/${occ.occurrenceId}.har`,
    actionLogPath: `${actionLogsDir}/${occ.occurrenceId}.json`,
    reproSteps: [
      `Login as ${occ.role}`,
      `Navigate to ${occ.page}`,
      `${occ.action.kind} on ${occ.action.selector ?? 'element'}`,
    ],
    replayCommand: `bughunter replay ${occ.occurrenceId}`,
  };
}

/**
 * Post-cluster annotation pass: link 404_for_linked_route ↔ surface_call_failed clusters
 * that share a normalized route. Mutual link via relatedClusterIds. In-place.
 */
function annotateRelatedClusters(clusters: BugCluster[]): void {
  const linked = new Set<string>(); // cluster pair keys already linked

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      if (!a || !b) continue;

      const eligible =
        (a.kind === '404_for_linked_route' && b.kind === 'surface_call_failed') ||
        (a.kind === 'surface_call_failed' && b.kind === '404_for_linked_route');

      if (!eligible) continue;

      const keyA = routeKeyOf(a);
      const keyB = routeKeyOf(b);
      if (!keyA || !keyB || keyA !== keyB) continue;

      const pairKey = [a.id, b.id].sort().join(':');
      if (linked.has(pairKey)) continue;
      linked.add(pairKey);

      a.relatedClusterIds = dedupe([...(a.relatedClusterIds ?? []), b.id]);
      b.relatedClusterIds = dedupe([...(b.relatedClusterIds ?? []), a.id]);
    }
  }
}

/**
 * Compute a route key for cluster linking. Option C: prefer `toolId` from the
 * first occurrence's action (present on both API-path 404s and surface_call_failed).
 * Falls back to path extraction from rootCause for UI-walker-only 404s that carry
 * no toolId (pure anchor-click navigation without an API call).
 */
function routeKeyOf(cluster: BugCluster): string | null {
  const toolId = cluster.occurrences[0]?.action.toolId;
  if (toolId) return `tool:${toolId}`;

  if (cluster.kind === '404_for_linked_route') {
    const match = /links to (\S+) which returned/.exec(cluster.rootCause);
    if (match?.[1]) return `path:${normalizePath(match[1])}`;
  }

  return null;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function generateFixHints(detection: BugDetection): string[] {
  const hints: string[] = [];
  switch (detection.kind) {
    case 'network_5xx':
      hints.push(`API returned ${detection.status}; check the underlying handler`);
      break;
    case 'console_error':
    case 'react_error':
    case 'unhandled_exception':
      hints.push(detection.rootCause.slice(0, 200));
      break;
    case 'missing_state_change':
      hints.push(`Action '${detection.triggeringAction?.kind}' produced no observable state change. Check event handler and state update logic.`);
      break;
    case 'surface_call_failed':
      hints.push(`surface_call failed for tool ${detection.endpoint}. Check API validation and response handling.`);
      break;
    case 'visual_anomaly': {
      const lines = [detection.rootCause];
      if (detection.screenshotPath) lines.push(`Screenshot: ${detection.screenshotPath}`);
      if (detection.visualSuggestedFix) lines.push(`Suggested fix: ${detection.visualSuggestedFix}`);
      hints.push(lines.join('\n'));
      break;
    }
  }
  return hints;
}
