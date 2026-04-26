// Phase 6: emit — write JSONL + summary (§ 3.7).

import type { BugCluster, InfrastructureFailure, RunState } from '../types.js';
import { runPaths, appendJsonl, writeJsonFile } from '../store/filesystem.js';
import { log } from '../log.js';

export function runEmit(
  clusters: BugCluster[],
  infraFailures: InfrastructureFailure[],
  runState: RunState,
  projectedRuntimeMs: number,
  actualRuntimeMs: number
): void {
  const paths = runPaths(runState.projectDir, runState.runId);

  // Write bugs.jsonl
  for (const cluster of clusters) {
    appendJsonl(paths.bugsFile, cluster);
  }

  // Write infrastructure.jsonl
  for (const failure of infraFailures) {
    appendJsonl(paths.infraFile, failure);
  }

  // Build summary
  const byKind: Record<string, number> = {};
  const byRole: Record<string, number> = {};

  for (const cluster of clusters) {
    byKind[cluster.kind] = (byKind[cluster.kind] ?? 0) + 1;
    for (const occ of cluster.occurrences) {
      byRole[occ.role] = (byRole[occ.role] ?? 0) + 1;
    }
  }

  const summary = {
    runId: runState.runId,
    bugs_filed: clusters.length,
    bugs_attempted_fix: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
    byKind,
    byRole,
    projectedRuntimeMs,
    actualRuntimeMs,
  };

  writeJsonFile(paths.summaryFile, summary);

  // Human-readable stdout summary
  const lines = [
    `\n=== BugHunter Run ${runState.runId} ===`,
    `Total clusters: ${clusters.length}`,
    `Infrastructure failures: ${infraFailures.length}`,
    `Actual runtime: ${Math.round(actualRuntimeMs / 1000)}s`,
    '',
    'By kind:',
    ...Object.entries(byKind).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'By role:',
    ...Object.entries(byRole).map(([r, v]) => `  ${r}: ${v}`),
    '',
    `Bugs: ${paths.bugsFile}`,
    `Summary: ${paths.summaryFile}`,
  ];

  process.stdout.write(lines.join('\n') + '\n');
  log.info('Emitted', { clusters: clusters.length, infraFailures: infraFailures.length });
}
