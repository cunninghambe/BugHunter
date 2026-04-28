// PerfCollector — orchestrates the CDP session to collect performance artifacts
// per action window. Writes PerfArtifacts to runs/<runId>/perf/<occurrenceId>.json.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PerfArtifacts, HeapSample } from '../types.js';
import type { CdpSession, CdpTabScope } from '../adapters/cdp-session.js';
import { eventsToHar } from '../adapters/har-writer.js';
import type { HarLog } from '../adapters/har-writer.js';
import { getInjectionScript } from './web-vitals-injector.js';
import { log } from '../log.js';

export type PerfCollector = {
  /** Called when the browser navigates to a new URL; mirrors with CDP session. */
  observe(url: string): Promise<void>;
  /** Called after each action with a window id for tagging. */
  tick(actionWindowId: string): void;
  /** Drains collected data, writes artifact file, returns PerfArtifacts + HAR. */
  drain(occurrenceId: string): Promise<{ perf: PerfArtifacts; har: HarLog }>;
};

export type PerfCollectorOptions = {
  cdpSession: CdpSession & { setActionWindowId(id: string): void };
  perfDir: string;
  networkDir: string;
  heapSampling?: boolean;
};

export async function createPerfCollector(opts: PerfCollectorOptions): Promise<PerfCollector> {
  const { cdpSession, perfDir, networkDir, heapSampling = false } = opts;
  fs.mkdirSync(perfDir, { recursive: true });
  fs.mkdirSync(networkDir, { recursive: true });

  let currentTab: CdpTabScope | null = null;
  let currentUrl = '';
  const heapSamples: HeapSample[] = [];
  let injectionFailed = false;

  return {
    async observe(url: string): Promise<void> {
      currentUrl = url;
      try {
        currentTab = await cdpSession.newTab(url);
        // Inject the web-vitals script into the page
        try {
          await currentTab.evaluate(getInjectionScript());
        } catch (err) {
          injectionFailed = true;
          log.warn('perf-collector: web-vitals injection failed', { err: String(err), url });
        }
      } catch (err) {
        log.warn('perf-collector: newTab failed', { err: String(err), url });
        currentTab = null;
      }
    },

    tick(actionWindowId: string): void {
      cdpSession.setActionWindowId(actionWindowId);
    },

    async drain(occurrenceId: string): Promise<{ perf: PerfArtifacts; har: HarLog }> {
      let drained = await cdpSession.drain();

      // Optionally sample heap after action
      if (heapSampling && currentTab !== null) {
        try {
          const sample = await currentTab.sampleHeap();
          heapSamples.push(sample);
        } catch (err) {
          log.warn('perf-collector: heap sample failed', { err: String(err) });
        }
      }

      const perf: PerfArtifacts = {
        occurrenceId,
        webVitals: injectionFailed ? [] : drained.webVitals,
        longTasks: injectionFailed ? [] : drained.longTasks,
        heapSamples: heapSampling ? [...heapSamples] : [],
        renderEvents: injectionFailed ? [] : drained.renderEvents,
        cdpConsoleErrors: drained.consoleErrors,
      };

      const har = eventsToHar(drained.networkEvents);

      // Write perf artifact
      const perfFile = path.join(perfDir, `${occurrenceId}.json`);
      fs.writeFileSync(perfFile, JSON.stringify(perf, null, 2));

      // Write HAR artifact
      const harFile = path.join(networkDir, `${occurrenceId}.har`);
      fs.writeFileSync(harFile, JSON.stringify(har, null, 2));

      log.debug('perf-collector: drained', {
        occurrenceId,
        vitals: perf.webVitals.length,
        longTasks: perf.longTasks.length,
        networkEvents: drained.networkEvents.length,
        pageRoute: currentUrl,
      });

      return { perf, har };
    },
  };
}
