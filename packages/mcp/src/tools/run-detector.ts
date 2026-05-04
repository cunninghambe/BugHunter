// V56: bughunt_run_detector — per-detector write-side MCP tool.
// Runs a single BugKind (or list of BugKinds) against a target and returns clusters.
// Results are persisted to the run store with runMode: 'detector-call'.
//
// TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.
// Runtime check at tool startup warns if adapters don't honour AbortSignal.

import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';

// ---------------------------------------------------------------------------
// Zod input schema (mirrors spec section 5.1)
// ---------------------------------------------------------------------------

const AuthSchema = z.union([
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('cookie'), cookie: z.string() }),
  z.object({ kind: z.literal('bearer'), token: z.string() }),
  z.object({
    kind: z.literal('form'),
    loginUrl: z.string().url(),
    username: z.string(),
    password: z.string(),
  }),
]);

const InputSchema = z.object({
  kind: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe('One BugKind or an array. Array form lets agents target a category like all V21 IDOR kinds.'),

  target: z.object({
    appBaseUrl: z.string().url(),
    surfaceMcpUrl: z.string().url().optional(),
    browserMcpUrl: z.string().url().optional(),
    auth: AuthSchema.optional(),
  }),

  scope: z.object({
    routes: z.array(z.string().min(1)).optional(),
    roles: z.array(z.string().min(1)).optional(),
    surfaces: z.array(z.enum(['web', 'api', 'static-source'])).optional(),
    maxTests: z.number().int().min(1).max(500).optional(),
  }).optional(),

  budgetMs: z.number().int().min(1_000).max(600_000).default(60_000)
    .describe('Per-call hard budget in milliseconds. Defaults to 60s.'),

  reset: z.boolean().default(false)
    .describe('If true, invoke the V54 resetCommand on the target before running.'),

  /** Project directory for persisting results. Required so runs are queryable via bughunt_clusters. */
  project: z.string().min(1).optional()
    .describe('Project directory path for persisting results. If omitted, results are not persisted.'),
});

// ---------------------------------------------------------------------------
// Lazy dynamic import of CLI harness (avoids circular deps at module load)
// ---------------------------------------------------------------------------

import type { runHarness as RunHarnessType, checkAdapterSignalCompliance as CheckAdapterType } from 'bughunter/src/harness/executor.js';
import type { DETECTOR_CONTRACTS as DetectorContractsType } from 'bughunter/src/detectors/contracts.js';

type HarnessExports = {
  runHarness: typeof RunHarnessType;
  checkAdapterSignalCompliance: typeof CheckAdapterType;
};

type ContractsExports = {
  DETECTOR_CONTRACTS: typeof DetectorContractsType;
};

async function importHarness(): Promise<HarnessExports> {
  return import('bughunter/src/harness/executor.js') as Promise<HarnessExports>;
}

async function importContracts(): Promise<ContractsExports> {
  return import('bughunter/src/detectors/contracts.js') as Promise<ContractsExports>;
}

// ---------------------------------------------------------------------------
// Signal compliance check (runtime warning at tool startup)
// ---------------------------------------------------------------------------

let signalCheckDone = false;

async function checkSignalComplianceOnce(surfaceMcpUrl?: string, browserMcpUrl?: string): Promise<string[]> {
  if (signalCheckDone) return [];
  signalCheckDone = true;

  const warnings: string[] = [];
  const { checkAdapterSignalCompliance } = await importHarness();

  for (const [label, url] of [['surface-mcp', surfaceMcpUrl], ['browser-mcp', browserMcpUrl]] as const) {
    if (url === undefined) continue;
    const compliant = await checkAdapterSignalCompliance(url);
    if (!compliant) {
      warnings.push(
        `[tool startup] adapter '${label}' at ${url} may not honour AbortSignal — budget hard-stop reliability is reduced. ` +
        `TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.`,
      );
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Run store persistence helper
// ---------------------------------------------------------------------------

function persistDetectorCallRun(
  projectDir: string,
  runId: string,
  clusters: unknown[],
  kinds: string[],
): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  const state = {
    runId,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'emit',
    config: { appBaseUrl: '', projectDir },
    clusterCount: clusters.length,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: true,
    partialEmit: false,
    runMode: 'detector-call',
    detectorKinds: kinds,
  };

  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));

  const bugsLines = clusters.map(c => JSON.stringify(c)).join('\n');
  fs.writeFileSync(path.join(runDir, 'bugs.jsonl'), bugsLines.length > 0 ? `${bugsLines}\n` : '');
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerRunDetectorTool(server: McpServer): void {
  server.tool(
    'bughunt_run_detector',
    [
      'V56 per-detector primitive: run one or more specific BugHunter detectors against a target right now.',
      'Returns clusters immediately — no need to wait for a full bughunter run.',
      'Use for: "did my XSS fix take?", "recheck CSP only", "re-run all IDOR detectors after auth change".',
      'Results are persisted with runMode:detector-call so they are queryable via bughunt_clusters.',
      'Hard-stops at budgetMs (default 60s) with telemetry.budgetExceeded:true on overrun.',
    ].join(' '),
    InputSchema.shape,
    async (args) => {
      try {
        const { DETECTOR_CONTRACTS } = await importContracts();
        const { runHarness } = await importHarness();

        // Normalise kind to array
        const requestedKinds = Array.isArray(args.kind) ? args.kind : [args.kind];

        // Validate requested kinds against DETECTOR_CONTRACTS
        const contractsByKind = new Map(DETECTOR_CONTRACTS.map(c => [c.kind, c]));
        const unknownKinds = requestedKinds.filter(k => !contractsByKind.has(k as never));
        if (unknownKinds.length > 0) {
          return toolErr(
            'unknown_detector_kind',
            `No DetectorContract registered for: ${unknownKinds.join(', ')}. ` +
            `V56.1 ships with empty DETECTOR_CONTRACTS (populated in V56.2+). ` +
            `Available kinds: ${DETECTOR_CONTRACTS.length > 0 ? DETECTOR_CONTRACTS.map(c => c.kind).join(', ') : '(none yet — awaiting V56.2)'}`,
            { unknownKinds },
          );
        }

        // Signal compliance check (warns once, non-fatal — per Brad's decision 4)
        const startupWarnings = await checkSignalComplianceOnce(
          args.target.surfaceMcpUrl,
          args.target.browserMcpUrl,
        );

        const allWarnings: string[] = [...startupWarnings];
        const allClusters: unknown[] = [];
        const perDetectorElapsed: Record<string, number> = {};
        const plannedTotal = { planned: 0, run: 0, skipped: 0 };
        const allPhasesRun = new Set<string>();
        let anyBudgetExceeded = false;

        // Budget is divided equally across requested kinds
        const perKindBudgetMs = Math.floor(args.budgetMs / requestedKinds.length);
        const budgetController = new AbortController();
        const globalTimer = setTimeout(() => budgetController.abort(), args.budgetMs);

        try {
          for (const kindStr of requestedKinds) {
            if (budgetController.signal.aborted) break;

            const contract = contractsByKind.get(kindStr as never);
            if (contract === undefined) continue; // already validated above

            const kindStart = Date.now();
            const result = await runHarness({
              contract,
              target: {
                appBaseUrl: args.target.appBaseUrl,
                surfaceMcpUrl: args.target.surfaceMcpUrl,
                browserMcpUrl: args.target.browserMcpUrl,
                auth: args.target.auth,
              },
              scope: args.scope,
              budgetMs: perKindBudgetMs,
              signal: budgetController.signal,
            });

            perDetectorElapsed[kindStr] = Date.now() - kindStart;
            allClusters.push(...result.clusters);
            allWarnings.push(...result.warnings);
            plannedTotal.planned += result.plannedTests;
            plannedTotal.run += result.runTests;
            plannedTotal.skipped += result.skippedTests;
            for (const p of result.phasesRun) allPhasesRun.add(p);
            if (result.budgetExceeded) anyBudgetExceeded = true;
          }
        } finally {
          clearTimeout(globalTimer);
        }

        const totalDurationMs = Object.values(perDetectorElapsed).reduce((a, b) => a + b, 0);

        // Persist to run store if project dir provided
        if (args.project !== undefined) {
          const runId = `detector-${Date.now()}-${requestedKinds.join('-').slice(0, 40)}`;
          try {
            persistDetectorCallRun(args.project, runId, allClusters, requestedKinds);
          } catch (e: unknown) {
            allWarnings.push(`Failed to persist run results: ${String(e)}`);
          }
        }

        return toolOk({
          clusters: allClusters,
          telemetry: {
            plannedTests: plannedTotal.planned,
            runTests: plannedTotal.run,
            skippedTests: plannedTotal.skipped,
            durationMs: totalDurationMs,
            perDetectorElapsed,
            budgetExceeded: anyBudgetExceeded,
            phasesRun: [...allPhasesRun],
          },
          warnings: allWarnings,
        });
      } catch (e: unknown) {
        return toolErr('internal', String(e));
      }
    },
  );
}
