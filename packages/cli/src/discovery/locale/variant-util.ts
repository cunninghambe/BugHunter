// Shared utilities for locale variant runners.

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { DOMRectLite } from '../../types.js';

/** Captures bounding rects for all interactive elements + __page__ dimensions. */
export const CAPTURE_RECTS_SCRIPT = `(() => {
  const selectors = ['button','a[href]','input','select','textarea','[role="button"]','[contenteditable]'];
  const result = {};
  function bestSel(el) {
    if (el.id) return '#' + el.id;
    const t = el.getAttribute('data-testid');
    if (t) return '[data-testid="' + t + '"]';
    const a = el.getAttribute('aria-label');
    if (a) return el.tagName.toLowerCase() + '[aria-label="' + a + '"]';
    return el.tagName.toLowerCase() + ':nth-of-type(' + (Array.from(el.parentElement?.children ?? []).indexOf(el) + 1) + ')';
  }
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      const key = bestSel(el);
      result[key] = { x: r.left, y: r.top, w: r.width, h: r.height };
    });
  }
  result['__page__'] = { x: 0, y: 0, w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
  result['__viewport__'] = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  return result;
})()`;

export const RESTORE_SCRIPT = `(() => {
  const prevDir = document.documentElement.getAttribute('data-bughunter-locale-prev-dir');
  if (prevDir !== null) document.documentElement.setAttribute('dir', prevDir || 'ltr');
  document.documentElement.removeAttribute('data-bughunter-locale-prev-dir');
  document.querySelectorAll('[data-bughunter-locale-prev-value]').forEach(el => {
    const htmlEl = el;
    htmlEl.value = el.getAttribute('data-bughunter-locale-prev-value') ?? '';
    el.removeAttribute('data-bughunter-locale-prev-value');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
})()`;

export async function captureRectMap(browser: BrowserMcpAdapter): Promise<Record<string, DOMRectLite>> {
  const result = await browser.evaluate(CAPTURE_RECTS_SCRIPT).catch(() => null);
  if (result === null || typeof result.value !== 'object' || result.value === null) return {};
  return result.value as Record<string, DOMRectLite>;
}
