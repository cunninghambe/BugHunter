// Locale-stress phase orchestrator (§4.1) — post-discovery per-URL variant pass.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { DomWalkResult } from '../discovery/dom-walker.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import type { VisionBudget } from '../classify/vision-budget.js';
import type { BugDetection, DOMRectLite, LocaleVariant } from '../types.js';
import { captureRectMap } from '../discovery/locale/variant-util.js';
import { runRtlVariant } from '../discovery/locale/rtl.js';
import { runLongStringDeVariant, runLongStringZhVariant } from '../discovery/locale/long-string.js';
import { runAmbiguousDateVariant } from '../discovery/locale/ambiguous-date.js';
import { runCurrencyVariant } from '../discovery/locale/currency.js';
import { runPluralizationVariant } from '../discovery/locale/pluralization.js';
import { runTimezoneDisplayVariant } from '../discovery/locale/timezone-display.js';
import { log } from '../log.js';

export type { LocaleVariant };

export type LocaleStressInput = {
  url: string;
  domWalk: DomWalkResult;
  ltrScreenshotPath: string;
  ltrRectMap: Record<string, DOMRectLite>;
  browser: BrowserMcpAdapter;
  vision: VisionClientInterface;
  visionBudget: VisionBudget;
  runId: string;
  outDir: string;
  settleMs?: number;
};

export type LocaleStressOutput = {
  url: string;
  variantsRun: LocaleVariant[];
  detections: BugDetection[];
  skippedReasons: Array<{ variant: LocaleVariant; reason: string }>;
};

const VARIANTS_ORDER: Exclude<LocaleVariant, 'ltr_baseline'>[] = [
  'rtl',
  'long_string_de',
  'long_string_zh',
  'ambiguous_date',
  'currency_jpy_bhd',
  'pluralization_n0_n1_nmany',
];

export async function runLocaleStress(input: LocaleStressInput): Promise<LocaleStressOutput> {
  const { url, ltrRectMap, browser, visionBudget, settleMs = 400 } = input;
  const variantsRun: LocaleVariant[] = ['ltr_baseline'];
  const detections: BugDetection[] = [];
  const skippedReasons: Array<{ variant: LocaleVariant; reason: string }> = [];

  for (const variant of VARIANTS_ORDER) {
    if (!visionBudget.tryConsume()) {
      skippedReasons.push({ variant, reason: 'vision_budget_exhausted' });
      log.info(`locale-stress: skipping ${variant} for ${url} — vision budget exhausted`);
      continue;
    }

    let variantDetections: BugDetection[] = [];
    let restored = true;

    try {
      switch (variant) {
        case 'rtl': {
          const r = await runRtlVariant(browser, ltrRectMap, settleMs, url, undefined);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
        case 'long_string_de': {
          const r = await runLongStringDeVariant(browser, ltrRectMap, settleMs, url);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
        case 'long_string_zh': {
          const r = await runLongStringZhVariant(browser, ltrRectMap, settleMs, url);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
        case 'ambiguous_date': {
          const r = await runAmbiguousDateVariant(browser, settleMs, url);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
        case 'currency_jpy_bhd': {
          const r = await runCurrencyVariant(browser, settleMs, url);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
        case 'pluralization_n0_n1_nmany': {
          const r = await runPluralizationVariant(browser, settleMs, url);
          variantDetections = r.detections;
          restored = r.restored;
          break;
        }
      }

      detections.push(...variantDetections);
      variantsRun.push(variant);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skippedReasons.push({ variant, reason });
      log.warn(`locale-stress: variant ${variant} failed for ${url}`, { reason });
    }

    if (!restored) {
      log.warn(`locale-stress: restore failed after ${variant} on ${url} — skipping remaining variants`);
      for (const remaining of VARIANTS_ORDER.slice(VARIANTS_ORDER.indexOf(variant) + 1)) {
        skippedReasons.push({ variant: remaining, reason: 'restore_failed' });
      }
      break;
    }
  }

  // Timezone display is stateless — runs after all mutating variants.
  try {
    const tzResult = await runTimezoneDisplayVariant(browser, settleMs, url);
    detections.push(...tzResult.detections);
  } catch (err) {
    log.warn(`locale-stress: timezone-display check failed for ${url}`, { err: String(err) });
  }

  return { url, variantsRun, detections, skippedReasons };
}

/** Capture the LTR rect map for a page already loaded in the browser. */
export async function captureLtrRectMap(browser: BrowserMcpAdapter): Promise<Record<string, DOMRectLite>> {
  const rectMap = await captureRectMap(browser);
  delete rectMap['__viewport__'];
  return rectMap;
}
