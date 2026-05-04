// bughunt_clusters — list bug clusters with filtering and cursor pagination.
// CLI parity: bughunter inspect <runId> (filtered list view).

import * as fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, readClustersPage, runPaths, listRunIds } from '../io/runs.js';
import { encodeCursor, decodeCursor, computeFilterHash } from '../cursor.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { BugCluster } from 'bughunter/src/types.js';

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).optional().describe('Run id; defaults to latest run for the project'),
  kind: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Filter to one or more BugKinds (e.g. "xss_reflected" or ["slow_lcp","high_cls"])'),
  role: z.string().min(1).optional().describe('Filter to clusters whose occurrences include this role'),
  routePattern: z.string().min(1).optional().describe('Glob over occurrence.page (e.g. "/api/users/*")'),
  verdict: z.enum([
    'verified_fixed', 'verified_fixed_by_removal', 'not_fixed',
    'partially_verified', 'architect_refused',
  ]).optional().describe('Filter to clusters with this verdict'),
  severity: z.enum(['critical', 'major', 'minor', 'info']).optional()
    .describe('V29-defined severity. Returns not_implemented until V29 lands.'),
  minClusterSize: z.number().int().min(1).optional().describe('Minimum number of occurrences in cluster'),
  limit: z.number().int().min(1).max(200).default(50).describe('Page size; default 50, max 200'),
  cursor: z.string().optional().describe('Opaque pagination token from previous call'),
  runMode: z.enum(['full-scan', 'detector-call']).optional()
    .describe('V56: filter to runs initiated by a specific mode. full-scan = standard bughunter run; detector-call = bughunt_run_detector invocations. Pre-V56 runs without this field are treated as full-scan.'),
});

// V29 adds severity to BugCluster; treat it as optional for forward-compatibility on pre-V29 data.
type BugClusterWithSeverity = BugCluster & { severity?: string };

type ClusterSummary = {
  id: string;
  bugIdentity?: string;
  kind: BugCluster['kind'];
  severity?: string;
  clusterSize: number;
  rootCause: string;
  suspectedFiles: string[];
  verdict?: BugCluster['verdict'];
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

export function registerClustersTool(server: McpServer): void {
  server.tool(
    'bughunt_clusters',
    'List bug clusters from a run with filtering and cursor-paginated results. Use this to browse findings before drilling into a specific cluster. Filters: kind, role, route pattern, verdict, severity, minimum cluster size. Returns cluster summaries (id, kind, severity, size, root cause, suspected files, verdict). For full cluster detail including occurrences, call bughunt_cluster_detail after.',
    InputSchema.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);

        // V56: if runMode filter is set and no runId provided, find latest run of that mode
        let resolvedRunId = args.runId;
        if (resolvedRunId === undefined && args.runMode !== undefined) {
          const allIds = listRunIds(projectDir).sort();
          const targetMode = args.runMode;
          // Walk from newest to oldest, find first run with matching mode
          for (const id of [...allIds].reverse()) {
            const paths = runPaths(projectDir, id);
            if (fs.existsSync(paths.stateFile)) {
              const raw = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as { runMode?: string };
              const mode = raw.runMode ?? 'full-scan';
              if (mode === targetMode) {
                resolvedRunId = id;
                break;
              }
            }
          }
          if (resolvedRunId === undefined) {
            return toolErr('not_found', `No runs with runMode '${targetMode}' found in project ${projectDir}`);
          }
        }

        const { runId } = resolveRun(projectDir, resolvedRunId);

        // severity filter requires V29 — detect by checking cluster data at runtime
        // Per spec: return not_implemented if severity is supplied and V29 hasn't landed
        // We check by attempting to filter (if no clusters have severity field, not implemented)
        // Conservative approach: flag not_implemented if severity filter is requested
        if (args.severity !== undefined) {
          // Try to see if any clusters carry severity by sampling the first cluster
          const paths = runPaths(projectDir, runId);
          const { clusters: sample } = await readClustersPage(paths.bugsFile, {}, 0, 1);
          if (sample.length > 0 && (sample[0] as BugClusterWithSeverity).severity === undefined) {
            return toolErr('not_implemented', 'severity filter requires V29 (severity field not present in run data)');
          }
        }

        let cursorOffset = 0;
        let cursorFilterHash: string | undefined;

        if (args.cursor !== undefined) {
          let decoded;
          try {
            decoded = decodeCursor(args.cursor);
          } catch (e) {
            return toolErr('invalid_argument', String(e));
          }
          if (decoded.runId !== runId) {
            return toolErr('invalid_argument', 'cursor scoped to a different run');
          }
          cursorOffset = decoded.offset;
          cursorFilterHash = decoded.filterHash;

          const expectedHash = computeFilterHash({
            kind: args.kind,
            role: args.role,
            routePattern: args.routePattern,
            verdict: args.verdict,
            severity: args.severity,
            minClusterSize: args.minClusterSize,
          });
          if (cursorFilterHash !== expectedHash) {
            return toolErr('invalid_argument', 'cursor filter hash mismatch: filter args changed between pages');
          }
        }

        const filters = {
          kind: args.kind,
          role: args.role,
          routePattern: args.routePattern,
          verdict: args.verdict,
          severity: args.severity,
          minClusterSize: args.minClusterSize,
        };
        const filterHash = computeFilterHash(filters);
        const paths = runPaths(projectDir, runId);
        const page = await readClustersPage(paths.bugsFile, filters, cursorOffset, args.limit);

        const nextCursor = page.hasMore
          ? encodeCursor({ offset: page.nextOffset, runId, filterHash })
          : undefined;

        return toolOk({
          clusters: (page.clusters as BugClusterWithSeverity[]).map(toSummary),
          nextCursor,
          total: page.total,
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
