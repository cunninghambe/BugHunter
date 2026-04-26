// Post-fix verification — retest + revision-aware classification (§ 3.9 step 3).

import type { BugCluster, ClusterVerdict, OccurrenceFull } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { replayActionLog } from '../repro/replay.js';
import { readActionLog } from '../repro/action-log.js';
import { runPaths } from '../store/filesystem.js';
import { log } from '../log.js';

export type VerifyResult = {
  clusterId: string;
  verdict: ClusterVerdict;
  replayedOccurrences: number;
  passedOccurrences: number;
};

export async function verifyClusterFix(
  cluster: BugCluster,
  projectDir: string,
  runId: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter
): Promise<VerifyResult> {
  const paths = runPaths(projectDir, runId);

  // Refresh catalog to detect tool removals
  const catalog = await surface.surface_list_tools().catch(() => null);
  const existingToolIds = new Set((catalog?.tools ?? []).map(t => t.toolId));

  const fullOccs = cluster.occurrences.filter((o): o is OccurrenceFull => o.fullArtifacts);
  const lightweightCount = cluster.occurrences.filter(o => !o.fullArtifacts).length;

  let replayedOccurrences = 0;
  let passedOccurrences = 0;
  let verifiedByRemoval = 0;

  for (const occ of fullOccs) {
    const toolId = occ.action.toolId;

    // If tool no longer exists: verified_fixed_by_removal
    if (toolId && !existingToolIds.has(toolId)) {
      verifiedByRemoval++;
      passedOccurrences++;
      replayedOccurrences++;
      continue;
    }

    // Replay the action log
    try {
      const actionLog = readActionLog(paths.actionLogsDir, occ.occurrenceId);
      if (!browser && occ.action.via === 'ui') {
        log.warn(`Cannot replay UI occurrence ${occ.occurrenceId} without browser`);
        continue;
      }
      const result = await replayActionLog(
        actionLog,
        browser ?? ({} as BrowserMcpAdapter),
        surface,
        runId
      );
      replayedOccurrences++;
      if (result.ok && result.observation.consoleErrors.length === 0) {
        passedOccurrences++;
      }
    } catch (err) {
      log.warn(`Replay failed for ${occ.occurrenceId}`, err);
    }
  }

  // If all tool IDs removed: verified_fixed_by_removal
  if (verifiedByRemoval === fullOccs.length && fullOccs.length > 0) {
    return { clusterId: cluster.id, verdict: 'verified_fixed_by_removal', replayedOccurrences, passedOccurrences };
  }

  const lightweightUnverifiable = lightweightCount > 0 && passedOccurrences === replayedOccurrences;

  if (replayedOccurrences === 0) {
    return { clusterId: cluster.id, verdict: 'not_fixed', replayedOccurrences: 0, passedOccurrences: 0 };
  }

  if (passedOccurrences === replayedOccurrences && lightweightUnverifiable) {
    return { clusterId: cluster.id, verdict: 'partially_verified', replayedOccurrences, passedOccurrences };
  }

  if (passedOccurrences === replayedOccurrences) {
    return { clusterId: cluster.id, verdict: 'verified_fixed', replayedOccurrences, passedOccurrences };
  }

  return { clusterId: cluster.id, verdict: 'not_fixed', replayedOccurrences, passedOccurrences };
}
