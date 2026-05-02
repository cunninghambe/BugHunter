// Phase 5: cluster — group by stable signature; cap full-artifact occurrences (§ 3.6, 3.7).

import type { BugDetection, BugCluster, BugKind, Occurrence, OccurrenceFull, OccurrenceSummary, ReplayKind, TestCase, PreState, PostState } from '../types.js';
import { suspectedFilePath } from '../types.js';
import { clusterSignature, extractNormalizedFields } from '../cluster/signature.js';
import { computeFullArtifactSet } from '../store/artifact-budget.js';
import { normalizePath } from '../classify/network.js';
import { createId } from '../lib/ids.js';
import { nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';
import { log } from '../log.js';
import { computeBugIdentity } from '../cluster/bug-identity.js';

/**
 * BugKinds that do not require a live browser/server session for retest.
 * These are re-validated by static tools or by re-navigating without an authenticated browser session.
 */
const STATIC_RERUN_KINDS = new Set<BugKind>([
  'axe_color_contrast_strong', 'image_missing_alt', 'form_input_unlabeled', 'keyboard_trap',
  'seo_title_missing', 'seo_title_duplicate_across_routes', 'seo_meta_description_missing',
  'seo_canonical_missing', 'seo_h1_missing_or_multiple', 'seo_robots_blocking_crawl',
  'visual_anomaly',
  'slow_lcp', 'slow_inp', 'high_cls', 'unbounded_list_render', 'n_plus_one_api_calls',
  'request_dedup_missing', 'request_cancellation_missing', 'main_thread_blocked',
  'oversized_bundle', 'excessive_re_renders', 'memory_leak_suspected', 'memory_leak_attributed',
  'vulnerable_dependency_high', 'hardcoded_credentials_in_source', 'swallowed_error_empty_catch',
  'missing_csp_header', 'permissive_cors', 'cookie_security_flags', 'open_redirect',
  'sensitive_data_in_url', 'stack_trace_leak_in_response', 'hallucinated_route',
]);

export function replayKindForBugKind(kind: BugKind): ReplayKind {
  if (STATIC_RERUN_KINDS.has(kind)) return 'static_rerun';
  return 'action_log';
}

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
  /** v0.27: project name from config; used to derive stable bugIdentity. Optional for backward compat with existing tests. */
  projectName?: string;
  /** v0.32: frozen clock for deterministic timestamps. Defaults to wall-clock when absent. */
  clock?: Clock;
};

export type ClusterResult = {
  clusters: BugCluster[];
  capped: boolean;
};

export function runCluster(opts: ClusterOptions): ClusterResult {
  const { detections, testCases, runId, maxClusters } = opts;
  const clock = opts.clock ?? { kind: 'wall' } as Clock;
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
      const now = nowIso(clock);
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
        replayKind: replayKindForBugKind(detection.kind),
        signatureKey: sig,
        bugIdentity: opts.projectName !== undefined && opts.projectName !== ''
          ? computeBugIdentity(opts.projectName, sig)
          : undefined,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set just above or on previous iteration; cannot be absent here
    const cluster = clusterMap.get(sig)!;
    const occId = opts.occurrenceIdByTestId.get(testId);
    if (occId === undefined || occId === '') {
      throw new Error(
        `cluster: missing occurrenceId for testId ${testId}; ` +
        `executor must populate occurrenceIdByTestId for every TestResult`,
      );
    }
    const now = nowIso(clock);

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
      if (fullSet.has(occ.occurrenceId) !== true) return occ;
      return upgradeToFull(occ, opts);
    });

    // Flag third-party clusters
    cluster.thirdPartyOrGenerated = cluster.suspectedFiles.some(
      f => /node_modules\/|\.next\/|dist\/|build\//.test(suspectedFilePath(f))
    );
  }

  // v0.32: when deterministic mode is active, sort occurrences within each cluster
  // by occurrenceId ASC so concurrent drains don't produce different orders (EC-8).
  // In wall-clock mode, preserve insertion order (backward compat with existing tests).
  if (opts.clock !== undefined && opts.clock.kind !== 'wall') {
    for (const cluster of clusterMap.values()) {
      cluster.occurrences.sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
    }
  }

  const clusters = Array.from(clusterMap.values());
  annotateRelatedClusters(clusters);

  // v0.32: sort clusters by signatureKey ASC so bugs.jsonl line order is deterministic (§ 2.1).
  clusters.sort((a, b) => (a.signatureKey ?? '').localeCompare(b.signatureKey ?? ''));

  return { clusters, capped };
}

function upgradeToFull(occ: Occurrence, opts: ClusterOptions): OccurrenceFull {
  const { actionLogsDir, screenshotsDir, domDir, consoleDir, networkDir, stateByTestId } = opts;
  // B-8: empty testId silently degrades — be explicit. occId throws on empty (cluster.ts:77);
  // testId should do the same. Log a warning for the inconsistency when testId is present but lookup misses.
  const captured = (occ.testId !== undefined && occ.testId !== '') ? stateByTestId?.get(occ.testId) : undefined;
  // Synthetic occurrences (header probe, static analysis, visual baseline, cross-user replay)
  // intentionally lack pre/post states — suppress the warning for system/anonymous roles.
  const isSyntheticOccurrence = occ.role === 'system' || occ.role === 'anonymous';
  if (occ.testId !== undefined && occ.testId !== '' && captured === undefined && !isSyntheticOccurrence) {
    log.warn('cluster: testId present but stateByTestId lookup missed', { testId: occ.testId, occurrenceId: occ.occurrenceId, role: occ.role });
  }

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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounds checked by loop condition
      const a = clusters[i]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounds checked by loop condition
      const b = clusters[j]!;

      const eligible =
        (a.kind === '404_for_linked_route' && b.kind === 'surface_call_failed') ||
        (a.kind === 'surface_call_failed' && b.kind === '404_for_linked_route');

      if (!eligible) continue;

      const keyA = routeKeyOf(a);
      const keyB = routeKeyOf(b);
      if (keyA === null || keyB === null || keyA !== keyB) continue;

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
  if (toolId !== undefined && toolId !== '') return `tool:${toolId}`;

  if (cluster.kind === '404_for_linked_route') {
    const match = /links to (\S+) which returned/.exec(cluster.rootCause);
    // Regex requires \S+ — match[1] is non-empty when it's defined (B-5: mechanical fix).
    if (match?.[1] !== undefined) return `path:${normalizePath(match[1])}`;
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
      if (detection.screenshotPath !== undefined) lines.push(`Screenshot: ${detection.screenshotPath}`);
      if (detection.visualSuggestedFix !== undefined) lines.push(`Suggested fix: ${detection.visualSuggestedFix}`);
      hints.push(lines.join('\n'));
      break;
    }
  }
  return hints;
}
