// bughunt_artifact — fetch the bytes of one artifact.
// CLI parity: none — CLI users open the file directly; MCP clients lack filesystem access.

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, resolveRun, readAllClusters, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { OccurrenceFull } from 'bughunter/src/types.js';

const MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

const InputSchema = z.object({
  project: z.string().min(1).describe('Absolute project directory path'),
  runId: z.string().min(1).describe('Run id'),
  occurrenceId: z.string().min(1).describe('Occurrence id (from bughunt_occurrence)'),
  kind: z.enum(['screenshot', 'dom', 'console', 'network', 'action-log'])
    .describe('Artifact kind to fetch'),
});

type ArtifactKind = 'screenshot' | 'dom' | 'console' | 'network' | 'action-log';

function resolveArtifactPath(occ: OccurrenceFull, kind: ArtifactKind, paths: ReturnType<typeof runPaths>): string {
  function resolve(stored: string, fallback: string): string {
    if (stored === '') return fallback;
    // If the stored path is already absolute, use it directly; otherwise resolve relative to runDir.
    return path.isAbsolute(stored) ? stored : path.join(paths.runDir, stored);
  }
  switch (kind) {
    case 'screenshot': return resolve(occ.screenshotPath, path.join(paths.screenshotsDir, `${occ.occurrenceId}.png`));
    case 'dom':        return resolve(occ.domSnapshotPath, path.join(paths.domDir, `${occ.occurrenceId}.html`));
    case 'console':    return resolve(occ.consoleLogPath, path.join(paths.consoleDir, `${occ.occurrenceId}.jsonl`));
    case 'network':    return resolve(occ.networkLogPath, path.join(paths.networkDir, `${occ.occurrenceId}.json`));
    case 'action-log': return resolve(occ.actionLogPath, path.join(paths.actionLogsDir, `${occ.occurrenceId}.json`));
  }
}

type ContentTypeMeta = { contentType: string; binary: boolean };

function contentTypeMeta(kind: ArtifactKind): ContentTypeMeta {
  switch (kind) {
    case 'screenshot': return { contentType: 'image/png', binary: true };
    case 'dom':        return { contentType: 'text/html', binary: false };
    case 'console':    return { contentType: 'application/x-ndjson', binary: false };
    case 'network':    return { contentType: 'application/json', binary: false };
    case 'action-log': return { contentType: 'application/json', binary: false };
  }
}

export function registerArtifactTool(server: McpServer): void {
  server.tool(
    'bughunt_artifact',
    'Fetch the bytes of one artifact (screenshot PNG, DOM HTML, console log, network HAR, action log). Use after bughunt_occurrence returned a path. Binary artifacts come back base64-encoded; text artifacts as utf-8. Subject to a 4MB cap — exceeding artifacts return payload_too_large with a path that the caller can read directly if it has filesystem access.',
    InputSchema.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const { runId } = resolveRun(projectDir, args.runId);
        const paths = runPaths(projectDir, runId);
        const clusters = await readAllClusters(paths.bugsFile);

        let foundOcc: OccurrenceFull | undefined;
        for (const cluster of clusters) {
          const occ = cluster.occurrences.find(o => o.occurrenceId === args.occurrenceId);
          if (occ !== undefined) {
            if (!occ.fullArtifacts) {
              return toolErr('not_found', 'occurrence has summary-only retention; full artifacts not retained');
            }
            foundOcc = occ as OccurrenceFull;
            break;
          }
        }

        if (foundOcc === undefined) {
          return toolErr('not_found', `occurrence ${args.occurrenceId} not found in run ${runId}`);
        }

        const artifactPath = resolveArtifactPath(foundOcc, args.kind, paths);
        if (!fs.existsSync(artifactPath)) {
          return toolErr('not_found', `artifact pruned: ${artifactPath} no longer exists on disk`);
        }

        const stat = fs.statSync(artifactPath);
        if (stat.size > MAX_BYTES) {
          return toolErr('payload_too_large', `artifact size ${stat.size} bytes exceeds 4MB cap`, { path: artifactPath });
        }

        const { contentType, binary } = contentTypeMeta(args.kind);

        if (binary) {
          const base64 = fs.readFileSync(artifactPath).toString('base64');
          return toolOk({ kind: args.kind, contentType, base64, bytes: stat.size });
        } else {
          const text = fs.readFileSync(artifactPath, 'utf-8');
          return toolOk({ kind: args.kind, contentType, text, bytes: stat.size });
        }
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
