// bughunter replay <occurrenceId> — re-executes a captured action log.

import { loadConfig, resolvedConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { readActionLog } from '../repro/action-log.js';
import { replayActionLog } from '../repro/replay.js';
import { listRunIds, runPaths } from '../store/filesystem.js';
import { log } from '../log.js';
import * as path from 'node:path';

export async function replayCommand(projectDir: string, occurrenceId: string): Promise<void> {
  const config = resolvedConfig(loadConfig(projectDir));
  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
  const browser = config.browserMcpUrl ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl) : undefined;

  // Find the action log across all runs
  const runIds = listRunIds(projectDir);
  let actionLog = null;

  for (const runId of runIds) {
    const paths = runPaths(projectDir, runId);
    try {
      actionLog = readActionLog(paths.actionLogsDir, occurrenceId);
      break;
    } catch {
      // Not in this run
    }
  }

  if (!actionLog) {
    throw new Error(`Action log not found for occurrence ${occurrenceId}. Run 'bughunter list' to see available runs.`);
  }

  log.info(`Replaying occurrence ${occurrenceId} from run ${actionLog.runId}`);

  if (!browser) {
    log.warn('No browser MCP configured — UI steps will be skipped');
  }

  const result = await replayActionLog(
    actionLog,
    browser ?? ({ navigate: async () => ({ url: '' }), click: async () => ({ clicked: false }), type: async () => ({ typed: false }), scroll: async () => ({ scrolled: false }), snapshot: async () => ({ snapshot: '' }), screenshot: async () => ({ path: '' }), evaluate: async () => ({ value: null }), listTabs: async () => ({ tabs: [] }), closeTab: async () => ({ closed: false }), openTab: async () => ({ tabId: '', finalUrl: '' }), closeTabExplicit: async () => {}, withTab: async (_u: string, _h: Record<string,string> | undefined, fn: (s: never) => Promise<never>) => fn({} as never) }),
    surface,
    actionLog.runId
  );

  process.stdout.write('\n=== Replay Result ===\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (!result.ok) {
    process.exitCode = 1;
  }
}
