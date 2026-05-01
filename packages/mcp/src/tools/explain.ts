// bughunt_explain — LLM-summarized explanation of a cluster.
// CLI parity: bughunter explain <bug-id>
// Depends on V28 (explanations cache).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, readAllClusters, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { v28Available } from '../feature-detect.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id'),
  clusterId: z.string().min(1).describe('Cluster id to explain'),
  noCache: z.boolean().default(false)
    .describe('Force regeneration even if cached; default false'),
});

type ExplainFn = (opts: {
  projectDir: string;
  runId: string;
  clusterId: string;
  noCache: boolean;
}) => Promise<{ explanation: string; cached: boolean; costUsd?: number; generatedAt: string }>;

export function registerExplainTool(server: McpServer): void {
  server.tool(
    'bughunt_explain',
    'Get a human-readable LLM explanation of a cluster: what the bug is, why it matters, what code likely caused it, what fix is sketched. Cached per (runId, clusterId, file-content-hashes-of-suspectedFiles). Costs ~5¢/explain on cache miss. Depends on V28\'s explanations cache. Returns not_implemented if V28 has not landed.',
    InputSchema.shape,
    async (args) => {
      try {
        const { available, explain } = await v28Available();
        if (!available) {
          return toolErr('not_implemented', 'bughunt_explain requires V28 (explanations cache). Land V28 first.');
        }

        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);
        const clusters = await readAllClusters(paths.bugsFile);
        const cluster = clusters.find(c => c.id === args.clusterId);

        if (cluster === undefined) {
          return toolErr('not_found', `cluster ${args.clusterId} not found in run ${runId}`);
        }

        const explainMod = explain as { explainCluster?: ExplainFn };
        if (typeof explainMod.explainCluster !== 'function') {
          return toolErr('not_implemented', 'bughunt_explain requires V28 (explanations cache). Land V28 first.');
        }

        const result = await explainMod.explainCluster({
          projectDir,
          runId,
          clusterId: args.clusterId,
          noCache: args.noCache,
        });

        return toolOk(result);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
