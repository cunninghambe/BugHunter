// viewport_100vh_break detector (v0.41).
// Two-shot capture comparing layouts with and without simulated iOS toolbar inset.

import type { BugDetection } from '../types.js';
import { log } from '../log.js';

// iOS combined top+bottom toolbar height in px.
const IOS_TOOLBAR_INSET_PX = 84;

type VhElement = { selector: string; height: string };

export type ViewportBrowserScope = {
  evaluate(script: string): Promise<{ value: unknown }>;
  setViewport?(width: number, height: number): Promise<{ ok: true } | { ok: false; reason: string }>;
};

const VH_ELEMENTS_SCRIPT = `
(function() {
  function cssPathOf(el) {
    if (el.id) return '#' + el.id;
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).join('.') : '';
    return tag + cls;
  }
  return Array.from(document.querySelectorAll('*')).filter(el => {
    const role = el.getAttribute('role');
    if (role === 'dialog' || role === 'alertdialog') return false;
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if (pos === 'relative' || pos === 'static') return false;
    return cs.height.endsWith('vh') || cs.minHeight.endsWith('vh');
  }).map(el => ({ selector: cssPathOf(el), height: getComputedStyle(el).height }));
})()
`;

const SCROLL_HEIGHT_SCRIPT = `document.documentElement.scrollHeight`;

export async function detectViewport100vhBreak(
  browser: ViewportBrowserScope,
  pageRoute: string,
  viewportWidth: number,
  viewportHeight: number,
): Promise<BugDetection[]> {
  if (browser.setViewport === undefined) {
    log.warn('viewport-100vh-detector: setViewport unavailable; skipping');
    return [];
  }

  // Shot A: at normal iOS viewport height
  const heightAResult = await browser.evaluate(SCROLL_HEIGHT_SCRIPT);
  const heightA = typeof heightAResult.value === 'number' ? heightAResult.value : -1;

  const vhElemsResultA = await browser.evaluate(VH_ELEMENTS_SCRIPT);
  const vhElementsA = Array.isArray(vhElemsResultA.value) ? vhElemsResultA.value as VhElement[] : [];

  if (vhElementsA.length === 0) return [];

  // Shot B: simulate iOS toolbar by reducing height by IOS_TOOLBAR_INSET_PX
  const reducedHeight = viewportHeight - IOS_TOOLBAR_INSET_PX;
  const setResult = await browser.setViewport(viewportWidth, reducedHeight);
  if (!setResult.ok) {
    log.warn(`viewport-100vh-detector: setViewport failed (${setResult.reason}); skipping`);
    return [];
  }

  const heightBResult = await browser.evaluate(SCROLL_HEIGHT_SCRIPT);
  const heightB = typeof heightBResult.value === 'number' ? heightBResult.value : -1;

  // Restore viewport
  const restoreResult = await browser.setViewport(viewportWidth, viewportHeight);
  if (!restoreResult.ok) {
    log.warn(`viewport-100vh-detector: viewport restore failed (${restoreResult.reason})`);
  }

  const detections: BugDetection[] = [];

  // If scroll height didn't change after the simulated inset, the vh elements didn't reflow.
  if (heightA >= 0 && heightB >= 0 && Math.abs(heightA - heightB) < 10) {
    for (const el of vhElementsA) {
      detections.push({
        kind: 'viewport_100vh_break',
        rootCause: `Element "${el.selector}" uses 100vh (height: ${el.height}) which does not reflow when iOS toolbar appears (84px inset). Use 100dvh or 100svh instead.`,
        pageRoute,
        selectorClass: el.selector.slice(0, 80),
        evidence: {
          scrollHeightBefore: heightA,
          scrollHeightAfter: heightB,
          simulatedInsetPx: IOS_TOOLBAR_INSET_PX,
          viewportWidth,
          viewportHeight,
        },
      });
    }
  }

  return detections;
}
