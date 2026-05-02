// bughunt_tail — polling fallback for bughunter://tail/<runId> resource.
// Returns clusters appended since sinceClusterId; falls back to last-5s window.
// Rate-limited at 10 calls/sec/runId/apiKey.

import { z } from 'zod';
import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { BugCluster, RunState } from 'bughunter/src/types.js';

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_CALLS = 10;
const TAIL_LOOKBACK_MS = 5000;

// rate-limit tracker: key = `${project}:${runId}`, value = [timestamps]
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const calls = (rateLimitMap.get(key) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  calls.push(now);
  rateLimitMap.set(key, calls);
  return calls.length <= RATE_LIMIT_MAX_CALLS;
}

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id to tail'),
  sinceClusterId: z.string().min(1).optional()
    .describe('Return clusters appended after this id; if omitted, returns clusters appended in last 5s'),
});

// V29 adds severity to BugCluster; treat it as optional for forward-compatibility on pre-V29 data.
type BugClusterWithSeverity = BugCluster & { severity?: string };

type ClusterSummary = {
  id: string;
  kind: string;
  severity?: string;
  clusterSize: number;
  rootCause: string;
  suspectedFiles: string[];
  verdict?: string;
};

function suspectedFilePath(f: unknown): string {
  if (typeof f === 'string') return f;
  if (typeof f === 'object' && f !== null && 'path' in f && typeof (f as { path: unknown }).path === 'string') {
    return (f as { path: string }).path;
  }
  return '';
}

function toSummary(cluster: BugClusterWithSeverity): ClusterSummary {
  return {
    id: cluster.id,
    kind: cluster.kind,
    severity: cluster.severity,
    clusterSize: cluster.clusterSize,
    rootCause: cluster.rootCause,
    suspectedFiles: cluster.suspectedFiles.map(suspectedFilePath).filter(s => s !== ''),
    verdict: cluster.verdict,
  };
}

function readRunDone(projectDir: string, runId: string): boolean {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.stateFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as RunState;
    return state.phase === 'done';
  } catch {
    return false;
  }
}

function readClustersSync(bugsFile: string): BugCluster[] {
  if (!fs.existsSync(bugsFile)) return [];
  const lines = fs.readFileSync(bugsFile, 'utf-8').split('\n').filter(Boolean);
  const result: BugCluster[] = [];
  for (const line of lines) {
    try { result.push(JSON.parse(line) as BugCluster); } catch { /* skip malformed */ }
  }
  return result;
}

export function registerTailTool(server: McpServer): void {
  server.tool(
    'bughunt_tail',
    'Polling fallback for bughunter://tail/<runId>. Returns clusters appended since sinceClusterId. If sinceClusterId is omitted, returns clusters from the last 5 seconds. Poll every ~2s. Rate-limited at 10 calls/sec/runId. When run completes, returns runDone: true. Pass asOfClusterId from the response as sinceClusterId on the next call.',
    InputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface; uses synchronous I/O
    async (args) => {
      try {
        const rlKey = `${args.project}:${args.runId}`;
        if (!checkRateLimit(rlKey)) {
          return toolErr('rate_limited', 'Too many tail calls; poll at most 10 times/sec per runId');
        }

        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);

        const runDone = readRunDone(projectDir, runId);
        const allClusters = readClustersSync(paths.bugsFile);

        let clusters: BugCluster[];
        if (args.sinceClusterId !== undefined) {
          const idx = allClusters.findIndex(c => c.id === args.sinceClusterId);
          clusters = idx === -1 ? [] : allClusters.slice(idx + 1);
        } else {
          const cutoff = Date.now() - TAIL_LOOKBACK_MS;
          clusters = allClusters.filter(c => new Date(c.lastSeenAt).getTime() >= cutoff);
        }

        const asOfClusterId = allClusters.length > 0 ? allClusters[allClusters.length - 1].id : undefined;

        return toolOk({
          clusters: (clusters as BugClusterWithSeverity[]).map(toSummary),
          runDone,
          asOfClusterId,
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  // Resource subscription: bughunter://tail/<runId>
  const tailTemplate = new ResourceTemplate('bughunter://tail/{runId}', { list: undefined });
  server.resource(
    'tail',
    tailTemplate,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP resource handler interface; returns static guidance text
    async (uri) => {
      const runId = uri.pathname.split('/').pop() ?? '';
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            message: 'Use resource subscription (resources/subscribe) for push-based delivery, or poll bughunt_tail tool every ~2s.',
            runId,
          }),
          mimeType: 'application/json',
        }],
      };
    },
  );
}
