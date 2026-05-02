import { describe, it, expect, vi } from 'vitest';
import { detectOrientationChangeBreak } from './orientation-change-detector.js';
import type { OrientationBrowserScope } from './orientation-change-detector.js';

function makeBrowser(opts: {
  elemsBefore?: Array<{ testId: string; right: number }>;
  elemsAfter?: Array<{ testId: string; right: number }>;
  url?: string;
  setViewportOk?: boolean;
}): OrientationBrowserScope {
  const {
    elemsBefore = [],
    elemsAfter = elemsBefore,
    url = 'http://localhost/',
    setViewportOk = true,
  } = opts;
  let evaluateCallCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('location.href')) return { value: url };
      if (script.includes('scrollTop')) return { value: [] };
      evaluateCallCount++;
      // Odd calls → before, even calls → after
      return { value: evaluateCallCount % 2 === 1 ? elemsBefore : elemsAfter };
    }),
    setViewport: vi.fn().mockResolvedValue(setViewportOk ? { ok: true } : { ok: false, reason: 'unavailable' }),
  };
}

describe('orientation-change-detector', () => {
  it('returns empty when no overflows or state changes', async () => {
    const browser = makeBrowser({
      elemsBefore: [{ testId: 'nav', right: 300 }],
      elemsAfter: [{ testId: 'nav', right: 300 }],
    });
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('detects horizontal overflow after rotation', async () => {
    const browser = makeBrowser({
      elemsBefore: [{ testId: 'wide-table', right: 300 }],
      elemsAfter: [{ testId: 'wide-table', right: 450 }], // wider than 390
    });
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844);
    const overflow = result.filter(r => r.rootCause.includes('overflows horizontally'));
    expect(overflow.length).toBeGreaterThanOrEqual(1);
    expect(overflow[0].kind).toBe('orientation_change_layout_break');
  });

  it('detects state loss after restore', async () => {
    const browser = makeBrowser({
      elemsBefore: [{ testId: 'modal-content', right: 300 }],
      elemsAfter: [], // disappeared
    });
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844);
    const stateLoss = result.filter(r => r.rootCause.includes('state loss'));
    expect(stateLoss.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when setViewport unavailable', async () => {
    const browser: OrientationBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [] }),
    };
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('skips comparison when URL changes mid-rotation', async () => {
    let urlCallCount = 0;
    const browser: OrientationBrowserScope = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('location.href')) {
          urlCallCount++;
          return { value: urlCallCount === 1 ? 'http://localhost/' : 'http://localhost/other' };
        }
        return { value: [] };
      }),
      setViewport: vi.fn().mockResolvedValue({ ok: true }),
    };
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('respects exclusion list', async () => {
    const browser = makeBrowser({
      elemsBefore: [{ testId: 'mobile-drawer', right: 300 }],
      elemsAfter: [],
    });
    const result = await detectOrientationChangeBreak(browser, '/', 390, 844, ['mobile-drawer']);
    expect(result).toHaveLength(0);
  });
});
