// Phase 5: cluster — group by stable signature; cap full-artifact occurrences (§ 3.6, 3.7).

import type { BugDetection, BugCluster, Occurrence, OccurrenceFull, OccurrenceSummary, TestCase } from '../types.js';
import { clusterSignature, extractNormalizedFields } from '../cluster/signature.js';
import { computeFullArtifactSet } from '../store/artifact-budget.js';
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

    const cluster = clusterMap.get(sig)!;
    const occId = createId();
    const now = new Date().toISOString();

    cluster.lastSeenAt = now;
    cluster.clusterSize++;

    // Determine if this occurrence gets full artifacts (computed after all are added)
    const summaryOcc: OccurrenceSummary = {
      occurrenceId: occId,
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

  return {
    clusters: Array.from(clusterMap.values()),
    capped,
  };
}

function upgradeToFull(occ: Occurrence, opts: ClusterOptions): OccurrenceFull {
  const { runId, actionLogsDir, screenshotsDir, domDir, consoleDir, networkDir } = opts;
  return {
    occurrenceId: occ.occurrenceId,
    role: occ.role,
    page: occ.page,
    action: occ.action,
    preState: { url: occ.page, title: '', consoleErrorCount: 0 },
    postState: {
      url: occ.page,
      title: '',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 0,
    },
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
  }
  return hints;
}
