// bughunt_minimize / bughunt_replay_minimized — action-log minimization via ddmin.
// Algorithm: Zeller delta-debugging (classical ddmin) with doubled-replay flake mitigation.

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { readActionLog } from 'bughunter/src/repro/action-log.js';
import { replayActionLog } from 'bughunter/src/repro/replay.js';
import { loadConfig } from 'bughunter/src/config.js';
import { HttpSurfaceMcpAdapter } from 'bughunter/src/adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from 'bughunter/src/adapters/browser-mcp.js';
import type { ActionLog, ActionLogEntry } from 'bughunter/src/repro/action-log.js';

const MinimizeInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
  maxBudgetMs: z.number().int().positive().max(1_800_000).optional(),
  maxIterations: z.number().int().positive().optional(),
});

const ReplayMinInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
});

/** Split an array into `n` roughly-equal chunks. */
function chunk<T>(arr: T[], n: number): T[][] {
  const size = Math.ceil(arr.length / n);
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

type ReproCheck = {
  reproduced: boolean;
};

/**
 * Bug "reproduces" if consoleErrors > 0 OR result.ok === false.
 * Coarse signal per spec §7.4 — V32 will refine via clusterSignature.
 * Runs replay twice (EC-M3) to defang flakes; requires both to reproduce.
 */
async function checkRepro(
  log: ActionLog,
  surface: InstanceType<typeof HttpSurfaceMcpAdapter>,
  browser: InstanceType<typeof CamofoxBrowserMcpAdapter> | undefined,
  runId: string,
  appBaseUrl: string | undefined,
): Promise<ReproCheck> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await replayActionLog(log, browser ?? ({} as InstanceType<typeof CamofoxBrowserMcpAdapter>), surface, runId, appBaseUrl);
    const reproduced = !result.ok || result.observation.consoleErrors.length > 0;
    if (!reproduced) return { reproduced: false };
  }
  return { reproduced: true };
}

/** Classical ddmin minimization (Zeller). */
async function ddmin(
  original: ActionLog,
  steps: ActionLogEntry[],
  surface: InstanceType<typeof HttpSurfaceMcpAdapter>,
  browser: InstanceType<typeof CamofoxBrowserMcpAdapter> | undefined,
  runId: string,
  appBaseUrl: string | undefined,
  maxBudgetMs: number,
  maxIterations: number,
  startMs: number,
): Promise<{ steps: ActionLogEntry[]; iterations: number }> {
  let n = 2;
  let iterations = 0;

  while (steps.length >= 2 && iterations < maxIterations && Date.now() - startMs < maxBudgetMs) {
    const partitions = chunk(steps, n);
    let foundSmaller = false;

    // Try each partition alone
    for (const c of partitions) {
      if (iterations >= maxIterations || Date.now() - startMs >= maxBudgetMs) break;
      iterations++;
      const candidate: ActionLog = { ...original, actions: c };
      const { reproduced } = await checkRepro(candidate, surface, browser, runId, appBaseUrl);
      if (reproduced) {
        steps = c;
        n = 2;
        foundSmaller = true;
        break;
      }
    }

    if (!foundSmaller) {
      // Try each complement
      for (const c of partitions) {
        if (iterations >= maxIterations || Date.now() - startMs >= maxBudgetMs) break;
        const complement = steps.filter(s => !c.includes(s));
        if (complement.length === 0) continue;
        iterations++;
        const candidate: ActionLog = { ...original, actions: complement };
        const { reproduced } = await checkRepro(candidate, surface, browser, runId, appBaseUrl);
        if (reproduced) {
          steps = complement;
          n = Math.max(n - 1, 2);
          foundSmaller = true;
          break;
        }
      }
    }

    if (!foundSmaller) {
      if (n >= steps.length) break; // converged
      n = Math.min(n * 2, steps.length);
    }
  }

  return { steps, iterations };
}

export function registerMinimizeTools(server: McpServer): void {
  server.tool(
    'bughunt_minimize',
    'Minimize an action log via delta-debugging (ddmin). Returns the shortest log that still reproduces the bug.',
    MinimizeInput.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const paths = runPaths(projectDir, args.runId);

        let original: ActionLog;
        try {
          original = readActionLog(paths.actionLogsDir, args.occurrenceId);
        } catch {
          return toolErr('not_found', `Action log for occurrence ${args.occurrenceId} not found`);
        }

        const config = loadConfig(projectDir);
        const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
        const browser = config.browserMcpUrl !== undefined ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;

        const maxBudgetMs = args.maxBudgetMs ?? 600_000;
        const maxIterations = args.maxIterations ?? 200;
        const startMs = Date.now();

        // Precondition: original log must reproduce the bug
        const precondition = await checkRepro(original, surface, browser, args.runId, config.appBaseUrl);
        if (!precondition.reproduced) {
          return toolErr('cannot_repro', 'Original action log does not reproduce the bug on the current dev server. Run a fresh smoke first.');
        }

        // EC-M1: 1-step log — skip ddmin loop, return as-is
        const originalSteps = original.actions.length;
        if (originalSteps <= 1) {
          const outPath = path.join(paths.actionLogsDir, `${args.occurrenceId}.minimized.json`);
          fs.writeFileSync(outPath, `${JSON.stringify(original, null, 2)}\n`);
          return toolOk({
            ok: true,
            minimizedActionLogPath: outPath,
            originalSteps,
            minimizedSteps: originalSteps,
            iterations: 0,
            budgetMsUsed: Date.now() - startMs,
            reproduced: true,
          });
        }

        const { steps: minimizedSteps, iterations } = await ddmin(
          original,
          [...original.actions],
          surface,
          browser,
          args.runId,
          config.appBaseUrl,
          maxBudgetMs,
          maxIterations,
          startMs,
        );

        const budgetMsUsed = Date.now() - startMs;

        if (budgetMsUsed >= maxBudgetMs && minimizedSteps.length < originalSteps) {
          // Partial result on timeout — write what we have
          const minimized: ActionLog = { ...original, actions: minimizedSteps };
          const outPath = path.join(paths.actionLogsDir, `${args.occurrenceId}.minimized.json`);
          fs.writeFileSync(outPath, `${JSON.stringify(minimized, null, 2)}\n`);
          return toolErr('timeout', `Budget exhausted after ${iterations} iterations; partial result written`, {
            minimizedActionLogPath: outPath,
            originalSteps,
            minimizedSteps: minimizedSteps.length,
            iterations,
            budgetMsUsed,
          });
        }

        const minimized: ActionLog = { ...original, actions: minimizedSteps };
        const outPath = path.join(paths.actionLogsDir, `${args.occurrenceId}.minimized.json`);
        fs.writeFileSync(outPath, `${JSON.stringify(minimized, null, 2)}\n`);

        return toolOk({
          ok: true,
          minimizedActionLogPath: outPath,
          originalSteps,
          minimizedSteps: minimizedSteps.length,
          iterations,
          budgetMsUsed,
          reproduced: true,
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  server.tool(
    'bughunt_replay_minimized',
    'Replay the minimized action log produced by bughunt_minimize.',
    ReplayMinInput.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const paths = runPaths(projectDir, args.runId);
        const minimizedPath = path.join(paths.actionLogsDir, `${args.occurrenceId}.minimized.json`);

        if (!fs.existsSync(minimizedPath)) {
          return toolErr('not_found', `No minimized action log found for occurrence ${args.occurrenceId}. Run bughunt_minimize first.`);
        }

        const log: ActionLog = JSON.parse(fs.readFileSync(minimizedPath, 'utf-8')) as ActionLog;
        const config = loadConfig(projectDir);
        const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
        const browser = config.browserMcpUrl !== undefined ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;

        const result = await replayActionLog(
          log,
          browser ?? ({} as InstanceType<typeof CamofoxBrowserMcpAdapter>),
          surface,
          args.runId,
          config.appBaseUrl,
        );

        return toolOk(result);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
