// soft_keyboard_occlusion detector (v0.41).
// Simulates virtual keyboard via viewport inset; checks whether focused inputs remain visible.

import type { BugDetection } from '../types.js';
import { log } from '../log.js';

const SETTLE_MS = 200;

type InputInfo = { selector: string; type: string; bottom: number };

const VISIBLE_INPUTS_SCRIPT = `
(function() {
  const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
  return inputs
    .filter(el => {
      if (el.type === 'hidden') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map(el => ({
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase()),
      type: el.getAttribute('type') ?? 'text',
      bottom: el.getBoundingClientRect().bottom,
    }));
})()
`;

function focusAndRectScript(selector: string): string {
  return `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.focus();
  const rect = el.getBoundingClientRect();
  return { bottom: rect.bottom };
})()
`;
}

const DISPATCH_VISUAL_VIEWPORT_RESIZE = `
(function() {
  if (window.visualViewport) {
    window.visualViewport.dispatchEvent(new Event('resize'));
  }
})()
`;

export type SoftKeyboardBrowserScope = {
  evaluate(script: string): Promise<{ value: unknown }>;
  setVirtualKeyboardInsets?(bottomPx: number): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export async function detectSoftKeyboardOcclusion(
  browser: SoftKeyboardBrowserScope,
  pageRoute: string,
  viewportHeight: number,
  keyboardHeightPx: number,
): Promise<BugDetection[]> {
  if (browser.setVirtualKeyboardInsets === undefined) {
    log.warn('soft-keyboard-detector: setVirtualKeyboardInsets unavailable; skipping');
    return [];
  }

  const inputsResult = await browser.evaluate(VISIBLE_INPUTS_SCRIPT);
  const inputs = Array.isArray(inputsResult.value) ? inputsResult.value as InputInfo[] : [];
  if (inputs.length === 0) return [];

  const detections: BugDetection[] = [];
  const visibleThreshold = viewportHeight - keyboardHeightPx;

  for (const input of inputs) {
    const setResult = await browser.setVirtualKeyboardInsets(keyboardHeightPx);
    if (!setResult.ok) {
      log.warn(`soft-keyboard-detector: keyboard simulation failed (${setResult.reason})`);
      break;
    }

    try {
      await browser.evaluate(DISPATCH_VISUAL_VIEWPORT_RESIZE);
      await new Promise<void>(r => { setTimeout(r, SETTLE_MS); });

      const focusResult = await browser.evaluate(focusAndRectScript(input.selector));
      const postBottom = typeof (focusResult.value as { bottom?: number } | null)?.bottom === 'number'
        ? (focusResult.value as { bottom: number }).bottom
        : input.bottom;

      if (postBottom > visibleThreshold) {
        detections.push({
          kind: 'soft_keyboard_occlusion',
          rootCause: `Input "${input.selector}" (bottom=${Math.round(postBottom)}px) is occluded by simulated virtual keyboard (threshold=${visibleThreshold}px). App does not scroll input into view on focus.`,
          pageRoute,
          selectorClass: input.selector.slice(0, 80),
          evidence: {
            inputBottom: Math.round(postBottom),
            visibleThreshold,
            keyboardHeightPx,
            viewportHeight,
          },
        });
      }
    } finally {
      await browser.setVirtualKeyboardInsets(0);
    }
  }

  return detections;
}
