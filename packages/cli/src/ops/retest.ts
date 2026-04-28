// retest op — called by the /bughunt fix skill (§ 3.9.1).
// Refreshes SurfaceMCP catalog; replays each cluster occurrence with revision-aware input regen.

import * as fs from 'node:fs';
import type { BugCluster, OccurrenceFull, ToolMeta, PaletteVariant } from '../types.js';
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

export type RetestResultDetail = {
  occurrenceId: string;
  via: 'verbatim' | 'regenerated' | 'tool_removed';
  passed: boolean;
  error?: string;
};

export type RetestResult = {
  verdict:
    | 'verified_fixed'
    | 'verified_fixed_by_removal'
    | 'partially_verified'
    | 'not_fixed'
    | 'bugs_lost_to_revision';
  replayedOccurrences: number;
  passedOccurrences: number;
  details: RetestResultDetail[];
};

function findCluster(projectDir: string, runId: string, clusterId: string): BugCluster {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.bugsFile)) {
    throw new Error(`No bugs.jsonl found for run ${runId}`);
  }
  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
  const cluster = lines
    .map(l => JSON.parse(l) as BugCluster)
    .find(c => c.id === clusterId);
  if (!cluster) {
    throw new Error(`Cluster ${clusterId} not found in run ${runId}`);
  }
  return cluster;
}

function applySchemaChanges(actionLog: ActionLog, toolMap: Map<string, ToolMeta>): { log: ActionLog; via: 'verbatim' | 'regenerated' } {
  const updatedActions = actionLog.actions.map(entry => {
    if (!entry.toolId || !entry.inputSchemaHash) return entry;
    const newTool = toolMap.get(entry.toolId);
    if (!newTool) return entry;
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

    if (toolId && !existingToolIds.has(toolId)) {
      removedCount++;
      details.push({ occurrenceId: occ.occurrenceId, via: 'tool_removed', passed: true });
      continue;
    }

    if (!browser && occ.action.via === 'ui') {
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

export async function retestCluster(
  projectDir: string,
  runId: string,
  clusterId: string,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter,
): Promise<RetestResult> {
  const cluster = findCluster(projectDir, runId, clusterId);
  const paths = runPaths(projectDir, runId);
  return replayCluster(cluster, paths.actionLogsDir, surface, browser, runId);
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
  const browser = config.browserMcpUrl ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;

  // baseBranch and fixBranch are available for the skill's context;
  // the retest itself replays against the current dev server regardless of branch.
  void baseBranch;
  void fixBranch;

  return retestCluster(projectDir, runId, clusterId, surface, browser);
}
