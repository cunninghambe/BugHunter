// bughunt_progress — polling fallback for bughunter://progress/<runId> resource.
// Returns current run phase + counters from state.json.

import { z } from 'zod';
import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { RunState } from 'bughunter/src/types.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id to get progress for'),
});

export function registerProgressTool(server: McpServer): void {
  server.tool(
    'bughunt_progress',
    'Polling fallback for bughunter://progress/<runId>. Returns the current run phase (validate → discover → plan → execute → classify → cluster → emit → done), testsPlanned, testsRan, clusterCount, and consecutiveInfraFailures from state.json. Poll every ~2s to observe phase transitions.',
    InputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface; uses synchronous I/O
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);

        if (!fs.existsSync(paths.stateFile)) {
          return toolErr('not_found', `state.json not found for run ${runId}`);
        }

        const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as RunState;

        const testsPlanned = state.testCases?.length ?? 0;
        const testsRan = state.testResults?.length ?? 0;

        return toolOk({
          phase: state.phase,
          startedAt: state.startedAt,
          testsPlanned,
          testsRan,
          clusterCount: state.clusterCount,
          consecutiveInfraFailures: state.consecutiveInfraFailures,
          done: state.phase === 'done',
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  // Resource subscription: bughunter://progress/<runId>
  const progressTemplate = new ResourceTemplate('bughunter://progress/{runId}', { list: undefined });
  server.resource(
    'progress',
    progressTemplate,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP resource handler interface; returns static guidance text
    async (uri) => {
      const runId = uri.pathname.split('/').pop() ?? '';
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            message: 'Use resource subscription (resources/subscribe) for push-based phase change events, or poll bughunt_progress tool every ~2s.',
            runId,
          }),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
