// retest op — called by the /bughunt fix skill (§ 3.9.1).
// Refreshes SurfaceMCP catalog; replays each cluster occurrence with revision-aware input regen.

import * as fs from 'node:fs';
import type { BugCluster, BugDetection, BugKind, OccurrenceFull, ReplayKind, RetestVerdict, ToolMeta, PaletteVariant } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { ActionLog } from '../repro/action-log.js';
import { readActionLog } from '../repro/action-log.js';
import { replayActionLog } from '../repro/replay.js';
import { buildApiInput } from '../mutation/apply.js';
import { hashSchema } from '../util/hash.js';
import { runPaths } from '../store/filesystem.js';
import { loadConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { clusterSignature } from '../cluster/signature.js';
import { runStaticTool } from '../static/runner.js';
import type { StaticTool } from '../static/runner.js';
import { npmAuditTool } from '../static/tools/npm-audit.js';
import { gitleaksTool } from '../static/tools/gitleaks.js';
import { semgrepTool } from '../static/tools/semgrep.js';
import { eslintNoEmptyTool } from '../static/tools/eslint-no-empty.js';
import { log } from '../log.js';

export type RetestResultDetail = {
  occurrenceId: string;
  via: 'verbatim' | 'regenerated' | 'tool_removed';
  passed: boolean;
  error?: string;
};

export type RetestResult = {
  verdict: RetestVerdict;
  replayedOccurrences: number;
  passedOccurrences: number;
  details: RetestResultDetail[];
  /** Present when verdict is `cannot_retest`. */
  detail?: string;
};

// ---------------------------------------------------------------------------
// Static-rerun path
// ---------------------------------------------------------------------------

/** Re-run one or more StaticTools against projectDir and aggregate detections. */
async function runStaticRerunners(tools: StaticTool[], projectDir: string): Promise<BugDetection[]> {
  const detections: BugDetection[] = [];
  for (const tool of tools) {
    const run = await runStaticTool(tool, projectDir);
    detections.push(...run.detections);
  }
  return detections;
}

/**
 * Map from BugKind to the static tools that can re-validate it.
 * Kinds not in this map (SEO, a11y, vision, perf, header-probe) require a live
 * browser/server session — `retestViaStaticRerun` returns `cannot_retest` for those.
 */
const TOOL_RERUNNERS: Partial<Record<BugKind, StaticTool[]>> = {
  vulnerable_dependency_high: [npmAuditTool],
  hardcoded_credentials_in_source: [gitleaksTool, semgrepTool],
  swallowed_error_empty_catch: [eslintNoEmptyTool],
};

/**
 * Return the stable cluster signature key to match against fresh detections.
 * Prefers `cluster.signatureKey` (set at mint time). Falls back to a proxy
 * detection for old artifacts that lack this field.
 */
function expectedSignature(cluster: BugCluster): string {
  if (cluster.signatureKey !== undefined && cluster.signatureKey !== '') {
    return cluster.signatureKey;
  }
  // Fallback for old artifacts: reconstruct from a minimal proxy.
  // Accurate only for kinds whose signature derives solely from kind + pageRoute.
  const proxy: BugDetection = {
    kind: cluster.kind,
    rootCause: cluster.rootCause,
    pageRoute: cluster.occurrences[0]?.page,
  };
  return clusterSignature(proxy);
}

function verdictForStaticRerun(
  total: number,
  stillPresent: number,
): 'verified_fixed_static' | 'not_fixed_static' | 'partially_verified_static' {
  if (stillPresent === 0) return 'verified_fixed_static';
  if (stillPresent >= total) return 'not_fixed_static';
  return 'partially_verified_static';
}

/**
 * Re-validate a static-detector cluster by re-running the appropriate detector
 * against the current project state and checking whether the cluster's signature recurs.
 */
async function retestViaStaticRerun(cluster: BugCluster, projectDir: string): Promise<RetestResult> {
  const tools = TOOL_RERUNNERS[cluster.kind];

  if (tools === undefined) {
    // SEO, a11y, vision, perf, and header-probe kinds need a live browser/server session.
    // EC-7: cannot be re-run from the retest path without full infrastructure.
    return {
      verdict: 'cannot_retest',
      replayedOccurrences: 0,
      passedOccurrences: 0,
      details: [],
      detail: `static rerunner for ${cluster.kind} requires a live browser/server session — run a full smoke instead`,
    };
  }

  let freshDetections: BugDetection[];
  try {
    freshDetections = await runStaticRerunners(tools, projectDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('retest: static rerunner crashed', { kind: cluster.kind, error: msg });
    return {
      verdict: 'cannot_retest',
      replayedOccurrences: 0,
      passedOccurrences: 0,
      details: [],
      detail: `static rerunner crashed: ${msg}`,
    };
  }

  const freshSignatures = new Set(freshDetections.map(d => clusterSignature(d)));
  const expected = expectedSignature(cluster);
  const occurrenceCount = cluster.occurrences.length;

  // All occurrences in a cluster share the same signature (that's how clustering works).
  const stillPresent = freshSignatures.has(expected);
  const stillPresentCount = stillPresent ? occurrenceCount : 0;
  const passedOccurrences = occurrenceCount - stillPresentCount;

  return {
    verdict: verdictForStaticRerun(occurrenceCount, stillPresentCount),
    replayedOccurrences: occurrenceCount,
    passedOccurrences,
    details: cluster.occurrences.map(occ => ({
      occurrenceId: occ.occurrenceId,
      via: 'verbatim' as const,
      passed: !stillPresent,
    })),
  };
}

// ---------------------------------------------------------------------------
// Action-log replay path (existing, unchanged)
// ---------------------------------------------------------------------------

function findCluster(projectDir: string, runId: string, clusterId: string): BugCluster {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.bugsFile)) {
    throw new Error(`No bugs.jsonl found for run ${runId}`);
  }
  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
  const cluster = lines
    .map(l => JSON.parse(l) as BugCluster)
    .find(c => c.id === clusterId);
  if (cluster === undefined) {
    throw new Error(`Cluster ${clusterId} not found in run ${runId}`);
  }
  return cluster;
}

function applySchemaChanges(actionLog: ActionLog, toolMap: Map<string, ToolMeta>): { log: ActionLog; via: 'verbatim' | 'regenerated' } {
  const updatedActions = actionLog.actions.map(entry => {
    if (entry.toolId === undefined || entry.toolId === '' || entry.inputSchemaHash === undefined || entry.inputSchemaHash === '') return entry;
    const newTool = toolMap.get(entry.toolId);
    if (newTool === undefined) return entry;
    if (hashSchema(newTool.inputSchema) === entry.inputSchemaHash) return entry;

    const palette = (entry.palette ?? 'happy') as PaletteVariant;
    const newInput = buildApiInput(newTool, palette, entry.input, undefined);
    return { ...entry, input: newInput };
  });

  const regenerated = updatedActions.some((a, i) => a !== actionLog.actions[i]);
  return { log: { ...actionLog, actions: updatedActions }, via: regenerated ? 'regenerated' : 'verbatim' };
}

export async function replayCluster(
  cluster: BugCluster,
  actionLogsDir: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter,
  runId?: string,
  appBaseUrl?: string,
): Promise<RetestResult> {
  const catalog = await surface.surface_list_tools().catch(() => null);
  const tools = catalog?.tools ?? [];
  const existingToolIds = new Set(tools.map(t => t.toolId));
  const toolMap = new Map<string, ToolMeta>(tools.map(t => [t.toolId, t]));

  const fullOccs = cluster.occurrences.filter((o): o is OccurrenceFull => o.fullArtifacts);
  const lightweightCount = cluster.occurrences.filter(o => !o.fullArtifacts).length;

  const details: RetestResultDetail[] = [];
  let removedCount = 0;

  for (const occ of fullOccs) {
    const toolId = occ.action.toolId;

    if (toolId !== undefined && toolId !== '' && !existingToolIds.has(toolId)) {
      removedCount++;
      details.push({ occurrenceId: occ.occurrenceId, via: 'tool_removed', passed: true });
      continue;
    }

    if (browser === undefined && occ.action.via === 'ui') {
      details.push({
        occurrenceId: occ.occurrenceId,
        via: 'verbatim',
        passed: false,
        error: 'Cannot replay UI occurrence without browser adapter',
      });
      continue;
    }

    try {
      const rawLog = readActionLog(actionLogsDir, occ.occurrenceId);
      const { log: replayLog, via } = applySchemaChanges(rawLog, toolMap);
      const result = await replayActionLog(
        replayLog,
        browser ?? ({} as BrowserMcpAdapter),
        surface,
        runId ?? cluster.runId,
        appBaseUrl,
      );
      const passed = result.ok && result.observation.consoleErrors.length === 0;
      details.push({ occurrenceId: occ.occurrenceId, via, passed });
    } catch (err) {
      details.push({
        occurrenceId: occ.occurrenceId,
        via: 'verbatim',
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const replayedOccurrences = details.length;
  const passedOccurrences = details.filter(d => d.passed).length;

  if (removedCount === fullOccs.length && fullOccs.length > 0 && lightweightCount === 0) {
    return { verdict: 'verified_fixed_by_removal', replayedOccurrences, passedOccurrences, details };
  }

  if (removedCount === fullOccs.length && fullOccs.length > 0 && lightweightCount > 0) {
    return { verdict: 'bugs_lost_to_revision', replayedOccurrences, passedOccurrences, details };
  }

  if (replayedOccurrences === 0) {
    return { verdict: 'not_fixed', replayedOccurrences: 0, passedOccurrences: 0, details };
  }

  const allPassed = passedOccurrences === replayedOccurrences;
  if (allPassed && lightweightCount > 0) {
    return { verdict: 'partially_verified', replayedOccurrences, passedOccurrences, details };
  }

  if (allPassed) {
    return { verdict: 'verified_fixed', replayedOccurrences, passedOccurrences, details };
  }

  return { verdict: 'not_fixed', replayedOccurrences, passedOccurrences, details };
}

// ---------------------------------------------------------------------------
// Dispatch entry points
// ---------------------------------------------------------------------------

export async function retestCluster(
  projectDir: string,
  runId: string,
  clusterId: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter,
  appBaseUrl?: string,
): Promise<RetestResult> {
  const cluster = findCluster(projectDir, runId, clusterId);
  const paths = runPaths(projectDir, runId);
  const kind: ReplayKind = cluster.replayKind ?? 'action_log';

  switch (kind) {
    case 'action_log':
      return replayCluster(cluster, paths.actionLogsDir, surface, browser, runId, appBaseUrl);
    case 'static_rerun':
      return retestViaStaticRerun(cluster, projectDir);
    case 'unrunable':
      return {
        verdict: 'cannot_retest',
        replayedOccurrences: 0,
        passedOccurrences: 0,
        details: [],
        detail: 'cluster type does not support automated retest',
      };
  }
}

export async function retestOp(
  projectDir: string,
  runId: string,
  clusterId: string,
  baseBranch: string | undefined,
  fixBranch: string | undefined,
): Promise<RetestResult> {
  const config = loadConfig(projectDir);
  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
  const browser = config.browserMcpUrl !== undefined ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;

  // baseBranch and fixBranch are available for the skill's context;
  // the retest itself replays against the current dev server regardless of branch.
  void baseBranch;
  void fixBranch;

  return retestCluster(projectDir, runId, clusterId, surface, browser, config.appBaseUrl);
}
