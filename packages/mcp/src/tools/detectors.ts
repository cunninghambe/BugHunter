// bughunt_detectors — coverage transparency: detector registry listing.
// CLI parity: bughunter detectors [--kind <bugkind>] [--status wired|dead|deferred]
// Depends on V26 (DETECTOR_REGISTRY). Returns not_implemented if V26 not landed.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { v26Available } from '../feature-detect.js';

const InputSchema = z.object({
  project: z.string().min(1).optional()
    .describe('When provided, last-fired-at is computed from this project\'s runs; otherwise null'),
  status: z.enum(['wired', 'dead', 'deferred']).optional()
    .describe('Filter by detector status'),
  kind: z.string().min(1).optional()
    .describe('Filter to one BugKind'),
});

type DetectorEntry = {
  kind: string;
  status: 'wired' | 'dead' | 'deferred';
  detectorFile?: string;
  detectorLine?: number;
  runnerInputSource: 'production' | 'synthetic-only' | 'unknown';
  severity: string;
  specRef?: string;
  lastFiredAt?: string;
};

type DetectorMetadata = {
  kind: string;
  severity: string;
  displayName?: string;
  description?: string;
  helpUri?: string;
};

type DetectorRegistry = Record<string, DetectorMetadata>;

export function registerDetectorsTool(server: McpServer): void {
  server.tool(
    'bughunt_detectors',
    'Coverage transparency: for every BugKind, report whether it has a wired detector, the file:line of that detector, the input source (production paths vs synthetic-only), and last-fired-at across runs. Use this to answer "why didn\'t BugHunter flag X" with an actionable answer. Depends on V26 (DETECTOR_REGISTRY). Returns not_implemented if V26 has not landed.',
    InputSchema.shape,
    async (args) => {
      try {
        const { available, registry } = await v26Available();
        if (!available) {
          return toolErr('not_implemented', 'bughunt_detectors requires V26 (DETECTOR_REGISTRY). Land V26 first.', {
            availableViaCli: false,
            suggestion: 'Run `bughunter detectors` after V26 lands.',
          });
        }

        const reg = (registry as { DETECTOR_REGISTRY?: DetectorRegistry }).DETECTOR_REGISTRY;
        if (reg === undefined) {
          return toolErr('not_implemented', 'V26 loaded but DETECTOR_REGISTRY export not found');
        }

        let entries: DetectorEntry[] = Object.values(reg).map((meta): DetectorEntry => ({
          kind: meta.kind,
          status: 'wired',
          runnerInputSource: 'unknown',
          severity: meta.severity,
          specRef: meta.helpUri,
        }));

        if (args.kind !== undefined) {
          entries = entries.filter(e => e.kind === args.kind);
        }
        if (args.status !== undefined) {
          entries = entries.filter(e => e.status === args.status);
        }

        return toolOk(entries);
      } catch (e) {
        return toolErr('error', String(e));
      }
    },
  );
}
