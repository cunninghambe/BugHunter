// bughunt_triage — mark a cluster's triage verdict.
// CLI parity: bughunter triage (V28 interactive TUI; this is the headless write).

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createId } from '@paralleldrive/cuid2';
import { toolOk, toolErr } from '../envelope.js';
import { appendJsonl } from 'bughunter/src/store/filesystem.js';
import { resolveProjectDir, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { BugCluster } from 'bughunter/src/types.js';

const TriageInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  clusterId: z.string().min(1),
  mark: z.enum(['bug', 'fix-priority', 'false-positive', 'known']),
  note: z.string().optional(),
});

function resolveAuthor(projectDir: string): string {
  try {
    return execSync('git config user.email', { cwd: projectDir, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown@mcp';
  }
}

function findCluster(projectDir: string, runId: string, clusterId: string): BugCluster {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.bugsFile)) {
    throw new NotFoundError(`No bugs.jsonl found for run ${runId}`);
  }
  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
  const cluster = lines.map(l => JSON.parse(l) as BugCluster).find(c => c.id === clusterId);
  if (cluster === undefined) {
    throw new NotFoundError(`Cluster ${clusterId} not found in run ${runId}`);
  }
  return cluster;
}

export function registerTriageTool(server: McpServer): void {
  server.tool(
    'bughunt_triage',
    'Mark a cluster\'s triage verdict. Subsequent bughunter run consults this for stop-and-emit decisions.',
    TriageInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface contract; all I/O is synchronous
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        // Validate cluster exists
        findCluster(projectDir, args.runId, args.clusterId);

        const triagedBy = resolveAuthor(projectDir);
        const triageEntryId = createId();
        const triagedAt = new Date().toISOString();

        const triagePath = path.join(projectDir, '.bughunter', 'triage.jsonl');
        const record = {
          triageEntryId,
          runId: args.runId,
          clusterId: args.clusterId,
          mark: args.mark,
          note: args.note,
          triagedBy,
          triagedAt,
        };

        // O_APPEND atomicity holds for records < 4 KiB (PIPE_BUF); triage records ~200 B
        appendJsonl(triagePath, record);

        // V27 history.db integration — append to history.db when V27 lands.
        // Until then: no-op (V27 not yet merged).

        return toolOk({ ok: true, triageEntryId });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
