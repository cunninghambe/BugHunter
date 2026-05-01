// BugHunter MCP tools (§ 4.3).
// These tools wrap the bughunter CLI engine.
// At runtime, the CLI package is expected to be in node_modules.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createId } from '@paralleldrive/cuid2';
import * as fs from 'node:fs';

import { toolOk, toolErr } from './envelope.js';
import { listRunIds, runPaths } from 'bughunter/src/store/filesystem.js';
import type { BugCluster } from 'bughunter/src/types.js';

export { toolOk, toolErr };

const jobs = new Map<string, {
  state: 'queued' | 'running' | 'done' | 'failed';
  runId?: string;
  bugCounts?: { filed: number; verified_fixed: number; persistent: number; skipped: number };
  error?: string;
}>();

type CliModule = {
  runCommand: (opts: {
    projectDir: string;
    route?: string;
    role?: string;
    maxBugs?: number;
    budget?: number;
  }) => Promise<void>;
  replayCommand: (projectDir: string, occurrenceId: string) => Promise<void>;
};

// Dynamic import of the bughunter CLI module at runtime only (not at type-check time).
function importCli(): Promise<CliModule> {
  // In production: bughunter is installed as a workspace package
  return import('bughunter/src/cli/run.js') as Promise<CliModule>;
}

export function registerTools(server: McpServer): void {
  server.tool(
    'bughunt_run',
    'Start a BugHunter run. Returns a jobId to poll for completion.',
    {
      project: z.string().min(1).describe('Path to the project directory'),
      routePattern: z.string().optional().describe('Limit to routes matching glob'),
      roles: z.array(z.string()).optional().describe('Limit to specific roles'),
      maxBugs: z.number().int().optional().describe('Stop-and-emit at N clusters'),
      budget: z.number().int().optional().describe('Budget in ms'),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface contract; work is deferred via setImmediate
    async (args) => {
      try {
        const jobId = createId();
        jobs.set(jobId, { state: 'queued' });

        const runJob = async (): Promise<void> => {
          jobs.set(jobId, { state: 'running' });
          try {
            const cli = await importCli();
            await cli.runCommand({
              projectDir: args.project,
              route: args.routePattern,
              role: args.roles?.[0],
              maxBugs: args.maxBugs,
              budget: args.budget,
            });
            const runIds = listRunIds(args.project).sort().reverse();
            const runId = runIds[0];
            jobs.set(jobId, { state: 'done', runId, bugCounts: { filed: 0, verified_fixed: 0, persistent: 0, skipped: 0 } });
          } catch (e) {
            jobs.set(jobId, { state: 'failed', error: String(e) });
          }
        };
        setImmediate(() => { void runJob(); });

        return toolOk({ jobId });
      } catch (e) {
        return toolErr('error', String(e));
      }
    }
  );

  server.tool(
    'bughunt_status',
    'Get status of a BugHunter job.',
    { jobId: z.string().min(1) },
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface contract; synchronous lookup
    async (args) => {
      const job = jobs.get(args.jobId);
      if (job === undefined) return toolErr('not_found', `Job ${args.jobId} not found`);
      return toolOk(job);
    }
  );

  server.tool(
    'bughunt_latest_bugs',
    'Get bugs from the latest run.',
    {
      project: z.string().min(1),
      // limit: must be >= 1; limit: 0 would return 0 results and is rejected at schema level.
      limit: z.number().int().positive().optional(),
      // kind: empty string would match no clusters — require non-empty when provided.
      kind: z.string().min(1).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface contract; uses synchronous file I/O
    async (args) => {
      try {
        const runIds = listRunIds(args.project).sort().reverse();
        if (runIds.length === 0) return toolOk([]);
        const paths = runPaths(args.project, runIds[0]);
        if (!fs.existsSync(paths.bugsFile)) return toolOk([]);

        const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
        let clusters = lines.map(l => JSON.parse(l) as BugCluster);

        if (args.kind !== undefined) clusters = clusters.filter(c => c.kind === args.kind);
        if (args.limit !== undefined) clusters = clusters.slice(0, args.limit);

        return toolOk(clusters.map(c => ({
          id: c.id,
          kind: c.kind,
          clusterSize: c.clusterSize,
          rootCause: c.rootCause,
          suspectedFiles: c.suspectedFiles,
          verdict: c.verdict,
        })));
      } catch (e) {
        return toolErr('error', String(e));
      }
    }
  );

  server.tool(
    'bughunt_coverage',
    'Get the per-detector coverage report for a BugHunter run. Returns the contents of coverage.json verbatim.',
    {
      project: z.string().min(1).describe('Path to the project directory'),
      runId: z.string().min(1).optional().describe('Specific runId; omit for the most recent run.'),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface contract; uses synchronous file I/O
    async (args) => {
      try {
        const runIds = listRunIds(args.project).sort().reverse();
        if (args.runId === undefined && runIds.length === 0) return toolErr('no_runs', 'No BugHunter runs found for project');
        const runId = args.runId ?? runIds[0];
        const filePath = `${args.project}/.bughunter/runs/${runId}/coverage.json`;
        if (!fs.existsSync(filePath)) {
          return toolErr('coverage_unavailable', `coverage.json missing for run ${runId} (run predates V34)`);
        }
        const coverage = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
        return toolOk(coverage);
      } catch (e) {
        return toolErr('error', String(e));
      }
    }
  );

  server.tool(
    'bughunt_replay',
    'Replay a captured occurrence against the current dev server.',
    {
      project: z.string().min(1),
      occurrenceId: z.string().min(1),
    },
    async (args) => {
      try {
        const cli = await importCli();
        await cli.replayCommand(args.project, args.occurrenceId);
        return toolOk({ ok: true });
      } catch (e) {
        return toolErr('error', String(e));
      }
    }
  );
}

// Re-export register functions for new tool families
export { registerClustersTool } from './tools/clusters.js';
export { registerClusterDetailTool } from './tools/cluster-detail.js';
export { registerOccurrenceTool } from './tools/occurrence.js';
export { registerArtifactTool } from './tools/artifact.js';
export { registerRunsListTool, registerRunSummaryTool } from './tools/runs.js';
export { registerDetectorsTool } from './tools/detectors.js';
export { registerDiffTool } from './tools/diff.js';
export { registerHistoryTool } from './tools/history.js';
export { registerExplainTool } from './tools/explain.js';
export { registerProjectDescribeTool } from './tools/project.js';
export { registerConfigGetTool } from './tools/config.js';
export { registerTailTool } from './tools/tail.js';
export { registerProgressTool } from './tools/progress.js';
