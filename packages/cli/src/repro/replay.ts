// Action-log replay engine (§ 2, § 4.1 bughunter replay).
// Re-executes a captured JSON action log against the current dev server.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { ActionLog, ActionLogEntry } from './action-log.js';
import { runFormSubmit, isStringKeyedRecord } from '../phases/form-submit-runner.js';
import {
  runBackTransition,
  runForwardTransition,
  runBackThenForwardTransition,
  runRefreshTransition,
  runDeepLinkNoAuth,
  runHistoryCorruptTransition,
} from '../phases/nav-transition-runner.js';
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

/**
 * Resolve a (possibly relative) action-log URL against the run's appBaseUrl.
 * Returns the absolute URL string, or null if both inputs are invalid/missing.
 * Only http: and https: protocols are accepted; javascript:, data:, etc. return null.
 */
export function resolveActionLogUrl(maybeRelative: string, appBaseUrl: string | undefined): string | null {
  try {
    const u = new URL(maybeRelative);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    // Any other absolute scheme (javascript:, data:, etc.) is rejected.
    return null;
  } catch { /* not an absolute URL — fall through to base resolution */ }

  if (appBaseUrl === undefined || appBaseUrl === '') return null;
  try {
    const resolved = new URL(maybeRelative, appBaseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

export async function replayActionLog(
  actionLog: ActionLog,
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  runId: string,
  appBaseUrl?: string,
): Promise<ReplayResult> {
  const consoleErrors: unknown[] = [];
  const networkRequests: unknown[] = [];

  try {
    // Re-establish state-page context before replaying actions.
    // The action log's baseUrl is the synthetic route (dedup key); the real
    // navigation target is stateContext.baseRoute + clickByHint(triggerHint).
    if (actionLog.stateContext !== undefined) {
      const { baseRoute, triggerHint } = actionLog.stateContext;
      const resolvedBase = resolveActionLogUrl(baseRoute, appBaseUrl) ?? baseRoute;
      await browser.navigate(resolvedBase, { 'X-BugHunter-Run': runId });
      const clicked = await browser.clickByHint(triggerHint);
      if (!clicked.clicked) {
        log.warn('replay: state trigger not found', { occurrenceId: actionLog.occurrenceId, triggerHint });
      }
      await new Promise<void>(r => { setTimeout(r, 250); });
    }

    for (const entry of actionLog.actions) {
      const stepError = await executeStep(entry, browser, surface, actionLog.role, runId, appBaseUrl);
      if (stepError !== undefined) {
        log.warn('replay: step unresolvable URL', { occurrenceId: actionLog.occurrenceId, error: stepError });
        return { ok: false, observation: { consoleErrors, networkRequests }, error: stepError };
      }
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

/** Returns an error string if a navigate step's URL cannot be resolved, undefined otherwise. */
async function executeStep(
  entry: ActionLogEntry,
  browser: BrowserMcpAdapter,
  surface: SurfaceMcpAdapter,
  role: string,
  runId: string,
  appBaseUrl?: string,
): Promise<string | undefined> {
  switch (entry.kind) {
    case 'navigate': {
      const raw = entry.url ?? '';
      const resolved = resolveActionLogUrl(raw, appBaseUrl);
      if (resolved === null) {
        return `replay_url_unresolvable: url=${JSON.stringify(raw)} appBaseUrl=${JSON.stringify(appBaseUrl)}`;
      }
      await browser.navigate(resolved, { 'X-BugHunter-Run': runId });
      break;
    }

    case 'click':
      if (entry.selector === undefined) throw new Error('replay: click action missing selector');
      if (entry.selector === '') throw new Error('replay: click action has empty selector — corrupted log?');
      await browser.click(entry.selector);
      break;

    case 'fill':
      if (entry.selector === undefined) throw new Error('replay: fill action missing selector');
      if (entry.selector === '') throw new Error('replay: fill action has empty selector — corrupted log?');
      await browser.type(entry.selector, String(entry.value ?? ''));
      break;

    case 'submit':
      if (entry.selector === undefined) throw new Error('replay: submit action missing selector');
      if (entry.selector === '') throw new Error('replay: submit action has empty selector — corrupted log?');
      await runFormSubmit(browser, entry.selector, isStringKeyedRecord(entry.input) ? entry.input : {});
      break;

    case 'api_call':
      if (entry.toolId !== undefined && entry.toolId !== '') {
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

    case 'nav_transition': {
      // v0.22 replay: re-run seed then fire transition in order (§6.4).
      // The seed is stored in entry.navSeed; the transition in entry.transition.
      const seed = entry.navSeed;
      if (seed !== undefined) {
        await executeStep(
          { ...seed, step: entry.step, timestamp: entry.timestamp },
          browser,
          surface,
          role,
          runId,
        );
      }
      if (entry.transition !== undefined) {
        // Replay uses browser methods directly (no tab scope needed in replay context).
        switch (entry.transition.kind) {
          case 'refresh':
            await runRefreshTransition(browser as never);
            break;
          case 'back':
            await runBackTransition(browser as never);
            break;
          case 'forward':
            await runForwardTransition(browser as never);
            break;
          case 'back_then_forward':
            await runBackThenForwardTransition(browser as never);
            break;
          case 'deep_link_no_auth':
            await runDeepLinkNoAuth(browser as never, entry.transition.capturedUrl);
            break;
          case 'history_corrupt':
            await runHistoryCorruptTransition(browser as never, entry.transition.pushStates);
            break;
        }
      }
      break;
    }
  }
  return undefined;
}
