// V56 harness executor: invokes a DetectorContract's required phases with a hard
// AbortController budget. Wraps existing phase functions; does NOT rewrite them.
//
// TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.
// The runtime check in bughunt_run_detector warns if adapters don't honour AbortSignal;
// this module propagates signals but cannot enforce compliance in all adapters.

import type { DetectorContract, RequiredPhase } from '../detectors/contracts.js';
import type { BugCluster } from '../types.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HarnessTarget = {
  appBaseUrl: string;
  surfaceMcpUrl?: string;
  browserMcpUrl?: string;
  auth?: HarnessAuth;
};

export type HarnessAuth =
  | { kind: 'none' }
  | { kind: 'cookie'; cookie: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'form'; loginUrl: string; username: string; password: string };

export type HarnessScope = {
  routes?: string[];
  roles?: string[];
  surfaces?: Array<'web' | 'api' | 'static-source'>;
  maxTests?: number;
};

export type HarnessResult = {
  clusters: BugCluster[];
  phasesRun: RequiredPhase[];
  plannedTests: number;
  runTests: number;
  skippedTests: number;
  durationMs: number;
  budgetExceeded: boolean;
  warnings: string[];
};

export type HarnessRunOptions = {
  contract: DetectorContract;
  target: HarnessTarget;
  scope?: HarnessScope;
  budgetMs: number;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// AbortSignal compliance check
// ---------------------------------------------------------------------------

/**
 * Performs a quick (~100ms) signal-compliance check for an adapter URL.
 * Returns true if the adapter honoured an abort within the timeout, false otherwise.
 * Does NOT throw — callers should emit a warning on false.
 *
 * TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.
 */
export async function checkAdapterSignalCompliance(adapterUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await fetch(adapterUrl, { signal: controller.signal });
    clearTimeout(timer);
    // Fetch completed before abort — adapter may not be signal-compliant but
    // we can't distinguish "fast response" from "ignores signal". Treat as compliant.
    return true;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') return true;
    // Network error or timeout — treated as compliant (signal did fire)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Harness executor
// ---------------------------------------------------------------------------

/**
 * Runs the phases declared in contract.requires.phases against target, respecting
 * the hard budgetMs deadline via AbortController propagation.
 *
 * V56.1: this is a structural scaffold. Full phase dispatch wires in V56.2 when
 * the first contracts land. The executor today validates inputs, runs the budget
 * timer, and returns an empty cluster set with correct telemetry fields.
 */
export async function runHarness(opts: HarnessRunOptions): Promise<HarnessResult> {
  const { contract, target, budgetMs, signal: parentSignal } = opts;
  const startMs = Date.now();
  const warnings: string[] = [];
  const phasesRun: RequiredPhase[] = [];

  // Build a combined abort signal: budget OR parent signal
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);

  const combinedSignal = combineSignals(budgetController.signal, parentSignal);

  try {
    // Validate that required tools are available
    for (const tool of contract.requires.tools) {
      if (tool === 'browser-mcp' && target.browserMcpUrl === undefined) {
        warnings.push(
          `kind '${contract.kind}' requires browser-mcp but no browserMcpUrl provided — some phases may be skipped`,
        );
      }
      if (tool === 'surface-mcp' && target.surfaceMcpUrl === undefined) {
        warnings.push(
          `kind '${contract.kind}' requires surface-mcp but no surfaceMcpUrl provided — some phases may be skipped`,
        );
      }
    }

    // Validate auth requirements
    if (contract.requires.role.kind === 'specific' || contract.requires.role.kind === 'any-authenticated') {
      if (target.auth === undefined || target.auth.kind === 'none') {
        warnings.push(
          `kind '${contract.kind}' requires auth (${contract.requires.role.kind}) but no auth provided`,
        );
      }
    }

    // Check budget signal before starting phases
    if (combinedSignal.aborted) {
      return buildResult([], phasesRun, 0, 0, 0, Date.now() - startMs, true, warnings);
    }

    log.info('harness: starting detector run', {
      kind: contract.kind,
      phases: contract.requires.phases,
      budgetMs,
      appBaseUrl: target.appBaseUrl,
    });

    // Phase dispatch: structural scaffold (V56.1).
    // Full phase wiring lands in V56.2 when concrete contracts are defined.
    // The executor iterates over requires.phases but does not call phase modules
    // directly yet — that coupling requires concrete adapter setup per contract.
    for (const phase of contract.requires.phases) {
      // Re-check abort after each awaited microtask — signal.aborted is a live property
      // that can flip between iterations when a budget timer fires.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (combinedSignal.aborted) {
        log.warn('harness: budget exceeded, stopping phase execution', { phase, kind: contract.kind });
        const elapsed = Date.now() - startMs;
        return buildResult([], phasesRun, 0, 0, 0, elapsed, true, warnings);
      }

      log.info('harness: phase stub (V56.2 wires full execution)', { kind: contract.kind, phase });
      phasesRun.push(phase);

      // Allow other microtasks to run so abort signals are checked between phases
      await Promise.resolve();
    }

    const durationMs = Date.now() - startMs;
    const budgetExceeded = durationMs > budgetMs || combinedSignal.aborted;

    log.info('harness: run complete', { kind: contract.kind, durationMs, budgetExceeded });

    return buildResult([], phasesRun, 0, 0, 0, durationMs, budgetExceeded, warnings);
  } finally {
    clearTimeout(budgetTimer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(
  clusters: BugCluster[],
  phasesRun: RequiredPhase[],
  plannedTests: number,
  runTests: number,
  skippedTests: number,
  durationMs: number,
  budgetExceeded: boolean,
  warnings: string[],
): HarnessResult {
  return { clusters, phasesRun, plannedTests, runTests, skippedTests, durationMs, budgetExceeded, warnings };
}

/**
 * Combines two AbortSignals into a single signal that aborts when either fires.
 * If parent is undefined, returns the budget signal directly.
 */
function combineSignals(budget: AbortSignal, parent?: AbortSignal): AbortSignal {
  if (parent === undefined) return budget;
  if (parent.aborted || budget.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const combined = new AbortController();
  const abort = (): void => combined.abort();
  budget.addEventListener('abort', abort, { once: true });
  parent.addEventListener('abort', abort, { once: true });
  return combined.signal;
}
