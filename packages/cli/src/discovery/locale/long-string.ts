// Long-string locale variant — fills text inputs with 200-char DE compound or 1000-char ZH (§3.2).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection, DOMRectLite } from '../../types.js';
import { captureRectMap, RESTORE_SCRIPT } from './variant-util.js';
import { checkGeometry } from './geometric-checker.js';

const DE_COMPOUND = `'Donaudampfschiffahrtsgesellschaftskapitänsmützenherstellungs'.repeat(4).slice(0, 200)`;
const ZH_LONG = `'长'.repeat(1000)`;

function makeApplyScript(payload: string): string {
  return `(() => {
  const compound = ${payload};
  document.querySelectorAll('input[type=text], input[type=search], textarea').forEach(el => {
    el.setAttribute('data-bughunter-locale-prev-value', el.value || '');
    el.value = compound;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
})()`;
}

async function runPayload(
  browser: BrowserMcpAdapter,
  payload: string,
  payloadClass: 'de_compound' | 'zh_long',
  ltrRectMap: Record<string, DOMRectLite>,
  settleMs: number,
  pageUrl: string,
): Promise<BugDetection[]> {
  await browser.evaluate(makeApplyScript(payload));
  await new Promise<void>((r) => { setTimeout(r, settleMs); });

  const variantRectMap = await captureRectMap(browser);
  const viewport = variantRectMap['__viewport__'] ?? { x: 0, y: 0, w: 1280, h: 800 };
  delete variantRectMap['__viewport__'];

  const geoFindings = checkGeometry(ltrRectMap, variantRectMap, { w: viewport.w, h: viewport.h });

  return geoFindings
    .filter(f => f.certainty === 'high')
    .map(f => ({
      kind: 'i18n_long_string_overflow' as const,
      rootCause: `Long-string overflow (${payloadClass}): ${f.kind} on ${f.selector}`,
      pageRoute: pageUrl,
      selectorClass: f.selector,
      evidence: {
        payloadClass,
        category: f.kind,
        selector: f.selector,
        ltrRect: ltrRectMap[f.selector],
        variantRect: variantRectMap[f.selector],
      },
    }));
}

export async function runLongStringDeVariant(
  browser: BrowserMcpAdapter,
  ltrRectMap: Record<string, DOMRectLite>,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  const detections = await runPayload(browser, DE_COMPOUND, 'de_compound', ltrRectMap, settleMs, pageUrl);
  let restored = true;
  try {
    await browser.evaluate(RESTORE_SCRIPT);
  } catch {
    restored = false;
  }
  return { detections, restored };
}

export async function runLongStringZhVariant(
  browser: BrowserMcpAdapter,
  ltrRectMap: Record<string, DOMRectLite>,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  const detections = await runPayload(browser, ZH_LONG, 'zh_long', ltrRectMap, settleMs, pageUrl);
  let restored = true;
  try {
    await browser.evaluate(RESTORE_SCRIPT);
  } catch {
    restored = false;
  }
  return { detections, restored };
}
