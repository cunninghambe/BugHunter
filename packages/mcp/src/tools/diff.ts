// bughunt_diff — cross-run diff comparing two runs by stable bugIdentity.
// CLI parity: bughunter diff <runId-old> <runId-new>
// Depends on V27 (history.db + bugIdentity + diff implementation).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { v27DiffAvailable } from '../feature-detect.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runIdOld: z.string().min(1).describe('The baseline run id'),
  runIdNew: z.string().min(1).describe('The new run id to compare against the baseline'),
  format: z.enum(['json', 'sarif']).default('json')
    .describe('Output format: json (default) or sarif (SARIF 2.1.0)'),
});

type DiffFn = (projectDir: string, runIdOld: string, runIdNew: string, format: 'json' | 'sarif') => Promise<unknown>;

export function registerDiffTool(server: McpServer): void {
  server.tool(
    'bughunt_diff',
    'Cross-run diff. Compares two runs by stable bugIdentity and returns four buckets: clusters new in runIdNew, clusters present in both (persistent), clusters fixed in runIdNew (gone), and clusters that were verified-fixed in runIdOld but reappear in runIdNew (regressed). Returns SARIF if requested. Depends on V27 (history.db + bugIdentity + diff implementation).',
    InputSchema.shape,
    async (args) => {
      try {
        const { available, diff } = await v27DiffAvailable();
        if (!available) {
          return toolErr('not_implemented', 'bughunt_diff requires V27 (history.db). Land V27 first.');
        }

        const projectDir = resolveProjectDir(args.project);
        resolveRun(projectDir, args.runIdOld);
        resolveRun(projectDir, args.runIdNew);

        if (args.format === 'sarif') {
          const diffMod = diff as { sarifDiff?: DiffFn };
          if (typeof diffMod.sarifDiff !== 'function') {
            return toolErr('not_implemented', 'SARIF output deferred to V27 phase 2');
          }
          const result = await diffMod.sarifDiff(projectDir, args.runIdOld, args.runIdNew, 'sarif');
          return toolOk(result);
        }

        const diffMod = diff as { diff?: DiffFn };
        if (typeof diffMod.diff !== 'function') {
          return toolErr('not_implemented', 'bughunt_diff requires V27 (history.db). Land V27 first.');
        }

        const result = await diffMod.diff(projectDir, args.runIdOld, args.runIdNew, 'json');
        return toolOk(result);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
