// RTL locale variant — apply, capture geometry, restore (§3.1, §4.3).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection, DOMRectLite } from '../../types.js';
import { checkGeometry } from './geometric-checker.js';
import { captureRectMap, RESTORE_SCRIPT } from './variant-util.js';

const APPLY_SCRIPT = `(() => {
  document.documentElement.setAttribute('data-bughunter-locale-prev-dir',
    document.documentElement.getAttribute('dir') ?? '');
  document.documentElement.setAttribute('dir', 'rtl');
  document.documentElement.setAttribute('lang', 'ar');
})()`;

export async function runRtlVariant(
  browser: BrowserMcpAdapter,
  ltrRectMap: Record<string, DOMRectLite>,
  settleMs: number,
  pageUrl: string,
  screenshotPath: string | undefined,
): Promise<{ detections: BugDetection[]; variantRectMap: Record<string, DOMRectLite>; restored: boolean }> {
  await browser.evaluate(APPLY_SCRIPT);
  await new Promise(r => setTimeout(r, settleMs));

  const variantRectMap = await captureRectMap(browser);
  const viewport = variantRectMap['__viewport__'] ?? { x: 0, y: 0, w: 1280, h: 800 };
  delete variantRectMap['__viewport__'];

  const geoFindings = checkGeometry(ltrRectMap, variantRectMap, { w: viewport.w, h: viewport.h });

  const detections: BugDetection[] = geoFindings
    .filter(f => f.certainty === 'high')
    .map(f => ({
      kind: 'i18n_rtl_layout_break' as const,
      rootCause: `RTL layout break: ${f.kind} on ${f.selector}${f.pairSelector !== undefined ? ` / ${f.pairSelector}` : ''}`,
      pageRoute: pageUrl,
      selectorClass: f.selector,
      screenshotPath,
      evidence: {
        category: f.kind,
        certainty: f.certainty,
        selector: f.selector,
        pairSelector: f.pairSelector,
        ltrRect: ltrRectMap[f.selector],
        variantRect: variantRectMap[f.selector],
      },
    }));

  let restored = true;
  try {
    await browser.evaluate(RESTORE_SCRIPT);
  } catch {
    restored = false;
  }

  return { detections, variantRectMap, restored };
}

export { RESTORE_SCRIPT };
