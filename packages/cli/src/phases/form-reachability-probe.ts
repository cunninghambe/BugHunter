// Phase 1.5: form-reachability probe — runs once after discovery, before plan.
// Detects per-(role, state-page, form) whether the form mounts within asyncMaxWaitMs.
// Results gate submit-test generation in plan.ts to avoid emitting tests against
// forms that are structurally unreachable for a given role.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { DiscoveredPage } from '../types.js';
import { waitForFormPresent } from './form-submit-runner.js';
import { log } from '../log.js';
import { perfMs } from '../lib/perf.js';

export type ProbeKey = `${string}::${string}::${string}`; // role::pageRoute::formSelector

export type ProbeResult =
  | { probed: true; formPresent: true; latencyMs: number }
  | { probed: true; formPresent: false; latencyMs: number; reason: 'trigger_not_found' | 'form_never_rendered' | 'navigate_failed' };

export type ProbeTelemetry = {
  probesRun: number;
  skippedByBudget: number;
  durationMs: number;
};

export type ProbeOptions = {
  browser: BrowserMcpAdapter;
  appBaseUrl: string;
  pages: DiscoveredPage[];
  roles: string[];
  runId: string;
  extraHeaders?: Record<string, string>;
  asyncMaxWaitMs: number;
  perProbeTimeoutMs: number;
  budgetMs: number;
};

/** Build the canonical key for a probe result. */
export function probeKey(role: string, pageRoute: string, formSelector: string): ProbeKey {
  return `${role}::${pageRoute}::${formSelector}` as ProbeKey;
}

/**
 * Run one form-reachability probe tab: navigate to baseRoute, click trigger,
 * wait for the form. Returns a ProbeResult.
 */
async function runSingleProbe(
  browser: BrowserMcpAdapter,
  baseUrl: string,
  page: DiscoveredPage,
  formSelector: string,
  extraHeaders: Record<string, string> | undefined,
  asyncMaxWaitMs: number,
): Promise<ProbeResult> {
  const startMs = perfMs();
  const ctx = page.stateContext;
  if (ctx === undefined) {
    return { probed: true, formPresent: false, latencyMs: 0, reason: 'navigate_failed' };
  }

  const targetUrl = ctx.baseRoute.startsWith('http')
    ? ctx.baseRoute
    : `${baseUrl}${ctx.baseRoute}`;

  return browser.withTab(targetUrl, extraHeaders, async (scope) => {
    const clickRes = await scope.clickByHint(ctx.triggerHint);
    const latencyMs = perfMs() - startMs;

    if (!clickRes.clicked) {
      return { probed: true, formPresent: false, latencyMs, reason: 'trigger_not_found' };
    }

    const { present, latencyMs: waitLatency } = await waitForFormPresent(scope, formSelector, asyncMaxWaitMs);
    const totalLatency = perfMs() - startMs;

    if (present) {
      return { probed: true, formPresent: true, latencyMs: totalLatency };
    }
    return { probed: true, formPresent: false, latencyMs: waitLatency, reason: 'form_never_rendered' };
  });
}

/**
 * Run form-reachability probes for every (role, state-page, form) tuple.
 * Sequential; honours budgetMs. Pages with kind !== 'state' or no forms are skipped.
 */
export async function runFormReachabilityProbes(opts: ProbeOptions): Promise<{
  results: Map<ProbeKey, ProbeResult>;
  telemetry: ProbeTelemetry;
}> {
  const results = new Map<ProbeKey, ProbeResult>();
  const phaseStart = perfMs();
  let probesRun = 0;
  let skippedByBudget = 0;

  const statePagesWithForms = opts.pages.filter(
    p => p.kind === 'state' && p.forms.length > 0 && p.stateContext !== undefined,
  );

  for (const role of opts.roles) {
    for (const page of statePagesWithForms) {
      for (const form of page.forms) {
        const budgetRemaining = opts.budgetMs - (perfMs() - phaseStart);
        if (budgetRemaining < opts.perProbeTimeoutMs) {
          skippedByBudget += 1;
          log.warn('form-reachability-probe: budget exhausted; remaining tuples will default to emit', {
            role, page: page.route, form: form.formSelector,
          });
          continue;
        }

        const key = probeKey(role, page.route, form.formSelector);
        log.debug('form-reachability-probe: probing', { role, page: page.route, form: form.formSelector });

        let result: ProbeResult;
        try {
          result = await runSingleProbe(
            opts.browser,
            opts.appBaseUrl,
            page,
            form.formSelector,
            opts.extraHeaders,
            opts.asyncMaxWaitMs,
          );
        } catch (err) {
          log.warn('form-reachability-probe: probe threw; defaulting to formPresent:false', {
            role, page: page.route, form: form.formSelector, err: String(err),
          });
          result = { probed: true, formPresent: false, latencyMs: 0, reason: 'navigate_failed' };
        }

        results.set(key, result);
        probesRun += 1;

        log.info('form-reachability-probe: result', {
          role, page: page.route, form: form.formSelector,
          formPresent: result.formPresent,
          latencyMs: result.latencyMs,
          reason: result.formPresent ? undefined : result.reason,
        });
      }
    }
  }

  const durationMs = perfMs() - phaseStart;
  log.info('form-reachability-probe: complete', { probesRun, skippedByBudget, durationMs });

  return { results, telemetry: { probesRun, skippedByBudget, durationMs } };
}
