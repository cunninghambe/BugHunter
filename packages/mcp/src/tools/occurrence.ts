// bughunt_occurrence — get one occurrence by id.
// CLI parity: bughunter inspect <runId> --occurrence <occId>

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, readAllClusters, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id'),
  occurrenceId: z.string().min(1).describe('Occurrence id to retrieve'),
});

export function registerOccurrenceTool(server: McpServer): void {
  server.tool(
    'bughunt_occurrence',
    'Get one occurrence — the smallest unit of evidence. Returns either OccurrenceFull (with screenshot/dom/console/network/action-log path references) or OccurrenceSummary (lightweight; created when retention budget caps full-artifact storage). The fullArtifacts discriminator tells you which. Use bughunt_artifact to get the actual bytes.',
    InputSchema.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);
        const clusters = await readAllClusters(paths.bugsFile);

        for (const cluster of clusters) {
          const occ = cluster.occurrences.find(o => o.occurrenceId === args.occurrenceId);
          if (occ !== undefined) return toolOk(occ);
        }

        return toolErr('not_found', `occurrence ${args.occurrenceId} not found in any cluster of run ${runId}`);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
