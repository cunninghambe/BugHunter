// Action-log replay engine (§ 2, § 4.1 bughunter replay).
// Re-executes a captured JSON action log against the current dev server.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { ActionLog, ActionLogEntry } from './action-log.js';
import { log } from '../log.js';

export type ReplayResult = {
  ok: boolean;
  observation: {
    finalUrl?: string;
    consoleErrors: unknown[];
    networkRequests: unknown[];
    domSnapshot?: string;
  };
  error?: string;
};

export async function replayActionLog(
  actionLog: ActionLog,
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  runId: string
): Promise<ReplayResult> {
  const consoleErrors: unknown[] = [];
  const networkRequests: unknown[] = [];

  try {
    for (const entry of actionLog.actions) {
      await executeStep(entry, browser, surface, actionLog.role, runId);
    }

    const snapshot = await browser.snapshot().catch(() => null);
    return {
      ok: true,
      observation: {
        consoleErrors,
        networkRequests,
        domSnapshot: snapshot?.snapshot,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Replay failed', { occurrenceId: actionLog.occurrenceId, error: msg });
    return {
      ok: false,
      observation: { consoleErrors, networkRequests },
      error: msg,
    };
  }
}

async function executeStep(
  entry: ActionLogEntry,
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  role: string,
  runId: string
): Promise<void> {
  switch (entry.kind) {
    case 'navigate':
      await browser.navigate(entry.url ?? '', { 'X-BugHunter-Run': runId });
      break;

    case 'click':
      if (entry.selector) await browser.click(entry.selector);
      break;

    case 'fill':
      if (entry.selector) await browser.type(entry.selector, String(entry.value ?? ''));
      break;

    case 'submit':
      if (entry.selector) await browser.click(entry.selector);
      break;

    case 'api_call':
      if (entry.toolId) {
        await surface.surface_call({
          toolId: entry.toolId,
          role,
          input: entry.input ?? {},
          noAutoRelogin: entry.palette !== 'happy',
        });
      }
      break;

    case 'render':
      // Render = just navigate, already handled
      break;
  }
}
