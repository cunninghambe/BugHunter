// PerfCollector — collects performance artifacts per action window.
// Web Vitals are injected into the main crawl tab (same tab BrowserMCP uses),
// eliminating the race condition caused by opening a separate CDP tab (#146).
// Writes PerfArtifacts to runs/<runId>/perf/<occurrenceId>.json.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PerfArtifacts, WebVitalSample, LongTaskSample, RenderEvent } from '../types.js';
import type { CdpSession } from '../adapters/cdp-session.js';
import { eventsToHar } from '../adapters/har-writer.js';
import type { HarLog } from '../adapters/har-writer.js';
import { getInjectionScript } from './web-vitals-injector.js';
import { log } from '../log.js';

/** Minimal interface for a page that can evaluate JS expressions. */
export type PageEvaluator = {
  evaluate(script: string): Promise<{ value: unknown }>;
};

export type PerfCollector = {
  /** Inject Web Vitals into the already-open main crawl tab (no separate CDP tab). */
  observe(scope: PageEvaluator, url: string): Promise<void>;
  /** Called after each action with a window id for tagging. */
  tick(actionWindowId: string): void;
  /** Read Web Vitals from the open scope into memory before the tab closes. */
  captureVitals(): Promise<void>;
  /** Drains collected data, writes artifact file, returns PerfArtifacts + HAR. */
  drain(occurrenceId: string): Promise<{ perf: PerfArtifacts; har: HarLog }>;
};

export type PerfCollectorOptions = {
  cdpSession: CdpSession & { setActionWindowId(id: string): void };
  perfDir: string;
  networkDir: string;
  heapSampling?: boolean;
};

type CapturedVitals = {
  webVitals: WebVitalSample[];
  longTasks: LongTaskSample[];
  renderEvents: RenderEvent[];
};

function emptyVitals(): CapturedVitals {
  return { webVitals: [], longTasks: [], renderEvents: [] };
}

async function readVitalsFromScope(scope: PageEvaluator): Promise<CapturedVitals> {
  let webVitals: WebVitalSample[] = [];
  let longTasks: LongTaskSample[] = [];
  let renderEvents: RenderEvent[] = [];

  try {
    const r = await scope.evaluate('window.__bughunter_vitals__ || []');
    if (Array.isArray(r.value)) webVitals = r.value as WebVitalSample[];
  } catch (err) {
    log.warn('perf-collector: failed to read web vitals from scope', { err: String(err) });
  }

  try {
    const r = await scope.evaluate('window.__bughunter_long_tasks__ || []');
    if (Array.isArray(r.value)) longTasks = r.value as LongTaskSample[];
  } catch (err) {
    log.warn('perf-collector: failed to read long tasks from scope', { err: String(err) });
  }

  try {
    const r = await scope.evaluate('window.__bughunter_render_events__ || []');
    if (Array.isArray(r.value)) renderEvents = r.value as RenderEvent[];
  } catch (err) {
    log.warn('perf-collector: failed to read render events from scope', { err: String(err) });
  }

  return { webVitals, longTasks, renderEvents };
}

export function createPerfCollector(opts: PerfCollectorOptions): PerfCollector {
  const { cdpSession, perfDir, networkDir } = opts;
  fs.mkdirSync(perfDir, { recursive: true });
  fs.mkdirSync(networkDir, { recursive: true });

  let currentUrl = '';
  let currentScope: PageEvaluator | null = null;
  let captured: CapturedVitals = emptyVitals();

  return {
    async observe(scope: PageEvaluator, url: string): Promise<void> {
      currentUrl = url;
      currentScope = scope;
      captured = emptyVitals();
      try {
        await scope.evaluate(getInjectionScript());
      } catch (err) {
        log.warn('perf-collector: web-vitals injection failed', { err: String(err), url });
      }
    },

    tick(actionWindowId: string): void {
      cdpSession.setActionWindowId(actionWindowId);
    },

    async captureVitals(): Promise<void> {
      if (currentScope === null) return;
      captured = await readVitalsFromScope(currentScope);
      currentScope = null;
    },

    async drain(occurrenceId: string): Promise<{ perf: PerfArtifacts; har: HarLog }> {
      const drained = await cdpSession.drain();

      const perf: PerfArtifacts = {
        occurrenceId,
        webVitals: captured.webVitals,
        longTasks: captured.longTasks,
        heapSamples: [],
        renderEvents: captured.renderEvents,
        navigationEvents: [...drained.navigationEvents],
        cdpConsoleErrors: drained.consoleErrors,
      };

      const har = eventsToHar(drained.networkEvents);

      const perfFile = path.join(perfDir, `${occurrenceId}.json`);
      fs.writeFileSync(perfFile, JSON.stringify(perf, null, 2));

      const harFile = path.join(networkDir, `${occurrenceId}.har`);
      fs.writeFileSync(harFile, JSON.stringify(har, null, 2));

      log.debug('perf-collector: drained', {
        occurrenceId,
        vitals: perf.webVitals.length,
        longTasks: perf.longTasks.length,
        networkEvents: drained.networkEvents.length,
        pageRoute: currentUrl,
      });

      captured = emptyVitals();
      return { perf, har };
    },
  };
}
