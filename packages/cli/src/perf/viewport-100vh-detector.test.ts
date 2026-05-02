import { describe, it, expect, vi } from 'vitest';
import { detectViewport100vhBreak } from './viewport-100vh-detector.js';
import type { ViewportBrowserScope } from './viewport-100vh-detector.js';

function makeBrowser(opts: {
  scrollHeight?: number;
  vhElements?: Array<{ selector: string; height: string }>;
  setViewportOk?: boolean;
}): ViewportBrowserScope {
  const { scrollHeight = 1000, vhElements = [], setViewportOk = true } = opts;
  let callCount = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('scrollHeight')) {
        return { value: scrollHeight };
      }
      if (script.includes('querySelectorAll')) {
        callCount++;
        return { value: callCount === 1 ? vhElements : vhElements };
      }
      return { value: null };
    }),
    setViewport: vi.fn().mockResolvedValue(setViewportOk ? { ok: true } : { ok: false, reason: 'unavailable' }),
  };
}

describe('viewport-100vh-detector', () => {
  it('emits detection when 100vh element present and scroll height unchanged', async () => {
    const browser = makeBrowser({
      scrollHeight: 900,
      vhElements: [{ selector: '#hero', height: '844px' }],
    });

    const result = await detectViewport100vhBreak(browser, '/', 390, 844);

    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('viewport_100vh_break');
    expect(result[0].selectorClass).toBe('#hero');
    expect(result[0].rootCause).toContain('100dvh');
  });

  it('returns empty when no 100vh elements found', async () => {
    const browser = makeBrowser({ vhElements: [] });
    const result = await detectViewport100vhBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('returns empty when setViewport unavailable', async () => {
    const { evaluate } = makeBrowser({ vhElements: [{ selector: 'body', height: '100vh' }] });
    const browser: ViewportBrowserScope = { evaluate };
    const result = await detectViewport100vhBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('returns empty when setViewport fails', async () => {
    const browser = makeBrowser({
      vhElements: [{ selector: 'body', height: '100vh' }],
      setViewportOk: false,
    });
    const result = await detectViewport100vhBreak(browser, '/', 390, 844);
    expect(result).toHaveLength(0);
  });

  it('restores viewport after detection', async () => {
    const setViewportSpy = vi.fn().mockResolvedValue({ ok: true });
    const browser: ViewportBrowserScope = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('scrollHeight')) return { value: 900 };
        return { value: [{ selector: '#app', height: '844px' }] };
      }),
      setViewport: setViewportSpy,
    };

    await detectViewport100vhBreak(browser, '/', 390, 844);

    // Expects two calls: one to reduce, one to restore
    expect(setViewportSpy).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = setViewportSpy.mock.calls as [[number, number], [number, number]];
    expect(firstCall[1]).toBe(760); // 844 - 84
    expect(secondCall[1]).toBe(844); // restored
  });
});
