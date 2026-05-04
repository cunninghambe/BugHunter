// bughunt_runs_list + bughunt_run_summary — run enumeration and status.
// CLI parity: bughunter list / bughunter status <runId>

import { z } from 'zod';
import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import {
  resolveProjectDir, resolveRun, readRunSummary,
  listRunIds, runPaths,
} from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { RunState } from 'bughunter/src/types.js';

const RunsListInputSchema = z.object({
  project: z.string().min(1).optional()
    .describe('Project directory. If omitted AND V27 history.db is available, returns runs across all known projects.'),
  limit: z.number().int().min(1).max(200).default(20)
    .describe('Max runs to return; default 20 most recent'),
  since: z.string().datetime().optional()
    .describe('ISO-8601 cutoff; only return runs started at or after this'),
  runMode: z.enum(['full-scan', 'detector-call']).optional()
    .describe('V56: filter by run mode. full-scan = standard bughunter run; detector-call = bughunt_run_detector invocations'),
});

const RunSummaryInputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id'),
});

type RunListItem = {
  runId: string;
  project: string;
  startedAt: string;
  phase: string;
  /** V56: 'full-scan' | 'detector-call'; undefined for pre-V56 runs (tolerate missing). */
  runMode?: 'full-scan' | 'detector-call';
  bugsFiled?: number;
  byKind?: Record<string, number>;
};

function readRunListItem(projectDir: string, runId: string): RunListItem | null {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.stateFile)) return null;

  try {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as RunState;
    let bugsFiled: number | undefined;
    let byKind: Record<string, number> | undefined;

    if (fs.existsSync(paths.summaryFile)) {
      try {
        const summary = JSON.parse(fs.readFileSync(paths.summaryFile, 'utf-8')) as { bugs_filed?: number; byKind?: Record<string, number> };
        bugsFiled = summary.bugs_filed;
        byKind = summary.byKind;
      } catch { /* ignore */ }
    } else {
      bugsFiled = state.clusterCount;
    }

    // V56: read runMode with back-compat default of 'full-scan' for pre-V56 records
    const runMode = state.runMode ?? 'full-scan';

    return {
      runId,
      project: projectDir,
      startedAt: state.startedAt,
      phase: state.phase,
      runMode,
      bugsFiled,
      byKind,
    };
  } catch {
    return null;
  }
}

export function registerRunsListTool(server: McpServer): void {
  server.tool(
    'bughunt_runs_list',
    'List runs for a project (or across all known projects if V27 history.db is available). Returns lightweight summaries: runId, startedAt, phase, cluster count, by-kind counts. Use this to find the run id to feed into other tools. Results are sorted descending by startedAt (most recent first).',
    RunsListInputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface; uses synchronous I/O
    async (args) => {
      try {
        if (args.project === undefined) {
          return toolErr('invalid_argument', 'project is required until V27 (history.db) lands. Supply a project directory.');
        }

        const projectDir = resolveProjectDir(args.project);
        const ids = listRunIds(projectDir).sort();

        const since = args.since !== undefined ? new Date(args.since).getTime() : undefined;

        let items: RunListItem[] = ids
          .map(id => readRunListItem(projectDir, id))
          .filter((item): item is RunListItem => item !== null);

        if (since !== undefined) {
          items = items.filter(item => new Date(item.startedAt).getTime() >= since);
        }

        // V56: filter by runMode (pre-V56 records without runMode default to 'full-scan')
        if (args.runMode !== undefined) {
          const modeFilter = args.runMode;
          items = items.filter(item => (item.runMode ?? 'full-scan') === modeFilter);
        }

        // Sort descending by startedAt
        items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        items = items.slice(0, args.limit);

        return toolOk(items);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}

export function registerRunSummaryTool(server: McpServer): void {
  server.tool(
    'bughunt_run_summary',
    'Read summary.json for one run: counts (filed / fixed / persistent / skipped), by-kind / by-role aggregations, vision telemetry, perf summary, bundle summary, seed-hook executions, pen-testing telemetry. The full RunSummary type. Returns not_found if the run is still in progress (summary.json is written at emit phase).',
    RunSummaryInputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface; uses synchronous I/O
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        resolveRun(projectDir, args.runId);
        const summary = readRunSummary(projectDir, args.runId);
        return toolOk(summary);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
