// bughunt_cluster_detail — get the full BugCluster including all occurrences.
// CLI parity: bughunter inspect <runId> --cluster <clusterId>

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, readAllClusters, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { BugCluster, OccurrenceSummary } from 'bughunter/src/types.js';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id'),
  clusterId: z.string().min(1).describe('Cluster id to retrieve in full'),
});

function summarizeOccurrence(occ: BugCluster['occurrences'][number]): OccurrenceSummary {
  return {
    occurrenceId: occ.occurrenceId,
    testId: occ.testId,
    role: occ.role,
    page: occ.page,
    action: occ.action,
    fullArtifacts: false,
    timestamp: occ.fullArtifacts ? '' : (occ as OccurrenceSummary).timestamp,
    secondaryObservations: occ.secondaryObservations,
  };
}

export function registerClusterDetailTool(server: McpServer): void {
  server.tool(
    'bughunt_cluster_detail',
    'Get the full BugCluster including all occurrences (lightweight + full-artifact), suspected files, fix hints, and verdict. Use after bughunt_clusters to drill into one finding. Occurrences contain action logs, screenshots refs, console logs, network logs.',
    InputSchema.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);
        const clusters = await readAllClusters(paths.bugsFile);
        const cluster = clusters.find(c => c.id === args.clusterId);

        if (cluster === undefined) {
          return toolErr('not_found', `cluster ${args.clusterId} not found in run ${runId} (may not yet be emitted if run is active)`);
        }

        const serialized = JSON.stringify(cluster);
        if (serialized.length <= MAX_BYTES) {
          return toolOk(cluster);
        }

        // EC-4: truncate — convert occurrences to summary form, add truncated flag
        const summarized: BugCluster = {
          ...cluster,
          occurrences: cluster.occurrences.map(summarizeOccurrence),
        };
        return toolOk({
          ...summarized,
          truncated: true,
          originalOccurrenceCount: cluster.occurrences.length,
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
