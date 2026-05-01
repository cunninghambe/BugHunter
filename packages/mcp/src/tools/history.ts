// bughunt_history — per-kind or per-bugIdentity timeline across runs.
// CLI parity: bughunter history --kind <kind>
// Depends on V27 (history.db).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { v27HistoryAvailable } from '../feature-detect.js';

const InputSchemaShape = {
  project: z.string().min(1).describe('Absolute project directory path'),
  kind: z.string().min(1).optional()
    .describe('Filter to one BugKind. Mutually exclusive with bugIdentity.'),
  bugIdentity: z.string().min(1).optional()
    .describe('Filter to one stable identity. Mutually exclusive with kind.'),
  limit: z.number().int().min(1).max(500).default(50)
    .describe('Maximum history entries to return; default 50'),
};

// Note: mutual exclusivity of kind/bugIdentity is enforced in the handler body.
// We can't use .refine() here because .refine() returns ZodEffects which has no .shape property.

type HistoryFn = (opts: { projectDir: string; kind?: string; bugIdentity?: string; limit: number }) => Promise<unknown[]>;

export function registerHistoryTool(server: McpServer): void {
  server.tool(
    'bughunt_history',
    'Per-kind or per-bugIdentity timeline across runs: when did this bug class first appear, when was it fixed, did it regress, what\'s the median time-to-fix. Read from V27 history.db. Use to answer "is bug X new or has it been around?" Depends on V27.',
    InputSchemaShape,
    async (args) => {
      // Mutual exclusivity check (mirrors the refine constraint)
      if (args.kind !== undefined && args.bugIdentity !== undefined) {
        return toolErr('invalid_argument', 'kind and bugIdentity are mutually exclusive');
      }
      try {
        const { available, history } = await v27HistoryAvailable();
        if (!available) {
          return toolErr('not_implemented', 'bughunt_history requires V27 (history.db). Land V27 first.');
        }

        const projectDir = resolveProjectDir(args.project);

        const histMod = history as { queryHistory?: HistoryFn };
        if (typeof histMod.queryHistory !== 'function') {
          return toolErr('not_implemented', 'bughunt_history requires V27 (history.db). Land V27 first.');
        }

        const entries = await histMod.queryHistory({
          projectDir,
          kind: args.kind,
          bugIdentity: args.bugIdentity,
          limit: args.limit,
        });

        return toolOk(entries);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
