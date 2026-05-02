// orientation_change_layout_break detector (v0.41).
// Rotates viewport portrait → landscape → portrait; detects layout breaks and state loss.

import type { BugDetection } from '../types.js';
import { log } from '../log.js';

const ROTATION_SETTLE_MS = 500;

type ElementRect = { testId: string; right: number };
type ScrollState = { id: string; scrollTop: number };

const TEST_IDS_SCRIPT = `
(function() {
  return Array.from(document.querySelectorAll('[data-testid]')).map(el => {
    const rect = el.getBoundingClientRect();
    return { testId: el.getAttribute('data-testid'), right: rect.right };
  });
})()
`;

const SCROLL_STATE_SCRIPT = `
(function() {
  return Array.from(document.querySelectorAll('[data-testid]')).filter(el => el.scrollTop > 0).map(el => ({
    id: el.getAttribute('data-testid'),
    scrollTop: el.scrollTop,
  }));
})()
`;

const URL_SCRIPT = `window.location.href`;

export type OrientationBrowserScope = {
  evaluate(script: string): Promise<{ value: unknown }>;
  setViewport?(width: number, height: number): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export async function detectOrientationChangeBreak(
  browser: OrientationBrowserScope,
  pageRoute: string,
  portraitWidth: number,
  portraitHeight: number,
  exclusions: string[] = [],
): Promise<BugDetection[]> {
  if (browser.setViewport === undefined) {
    log.warn('orientation-change-detector: setViewport unavailable; skipping');
    return [];
  }

  // Capture portrait state
  const urlBefore = (await browser.evaluate(URL_SCRIPT)).value as string;
  const elemsBefore = (await browser.evaluate(TEST_IDS_SCRIPT)).value as ElementRect[];
  const scrollBefore = (await browser.evaluate(SCROLL_STATE_SCRIPT)).value as ScrollState[];

  // Rotate to landscape
  const toLandscape = await browser.setViewport(portraitHeight, portraitWidth);
  if (!toLandscape.ok) {
    log.warn(`orientation-change-detector: rotate to landscape failed (${toLandscape.reason}); skipping`);
    return [];
  }
  await new Promise<void>(r => { setTimeout(r, ROTATION_SETTLE_MS); });

  const urlMid = (await browser.evaluate(URL_SCRIPT)).value as string;

  // Rotate back to portrait
  const toPortrait = await browser.setViewport(portraitWidth, portraitHeight);
  if (!toPortrait.ok) {
    log.warn(`orientation-change-detector: restore to portrait failed (${toPortrait.reason})`);
  }
  await new Promise<void>(r => { setTimeout(r, ROTATION_SETTLE_MS); });

  const urlAfter = (await browser.evaluate(URL_SCRIPT)).value as string;

  // If URL changed mid-rotation, navigation occurred — skip comparison
  if (urlMid !== urlBefore) {
    log.info(`orientation-change-detector: navigation during rotation on ${pageRoute}; skipping comparison`);
    return [];
  }

  const elemsAfter = (await browser.evaluate(TEST_IDS_SCRIPT)).value as ElementRect[];
  const scrollAfter = (await browser.evaluate(SCROLL_STATE_SCRIPT)).value as ScrollState[];

  const detections: BugDetection[] = [];
  const exclusionSet = new Set(exclusions);

  // Check horizontal overflow in landscape
  for (const el of elemsAfter) {
    if (el.right > portraitWidth && !exclusionSet.has(el.testId)) {
      detections.push({
        kind: 'orientation_change_layout_break',
        rootCause: `Element [data-testid="${el.testId}"] overflows horizontally (right=${Math.round(el.right)}px > viewport=${portraitWidth}px) after orientation change`,
        pageRoute,
        selectorClass: `horizontal-overflow`,
        evidence: { testId: el.testId, rightPx: Math.round(el.right), viewportWidth: portraitWidth },
      });
    }
  }

  // Check state loss (testId present before but missing after restore)
  if (urlAfter === urlBefore) {
    const beforeIds = new Set(elemsBefore.map(e => e.testId));
    const afterIds = new Set(elemsAfter.map(e => e.testId));
    for (const id of beforeIds) {
      if (!afterIds.has(id) && !exclusionSet.has(id)) {
        detections.push({
          kind: 'orientation_change_layout_break',
          rootCause: `Element [data-testid="${id}"] disappeared after portrait→landscape→portrait rotation (state loss)`,
          pageRoute,
          selectorClass: id.slice(0, 80),
          evidence: { testId: id, kind: 'state_loss' },
        });
      }
    }

    // Check scroll loss (> 100px difference)
    const scrollBeforeMap = new Map(scrollBefore.map(s => [s.id, s.scrollTop]));
    for (const s of scrollAfter) {
      const before = scrollBeforeMap.get(s.id);
      if (before !== undefined && Math.abs(s.scrollTop - before) > 100 && !exclusionSet.has(s.id)) {
        detections.push({
          kind: 'orientation_change_layout_break',
          rootCause: `Scroll container [data-testid="${s.id}"] lost scroll position after orientation change (before=${before}px, after=${s.scrollTop}px)`,
          pageRoute,
          selectorClass: s.id.slice(0, 80),
          evidence: { testId: s.id, scrollBefore: before, scrollAfter: s.scrollTop, kind: 'scroll_loss' },
        });
      }
    }
  }

  return detections;
}
