import { describe, it, expect, vi } from 'vitest';
import { detectSoftKeyboardOcclusion } from './soft-keyboard-detector.js';
import type { SoftKeyboardBrowserScope } from './soft-keyboard-detector.js';

const VIEWPORT_HEIGHT = 844;
const KEYBOARD_HEIGHT = 271;
const VISIBLE_THRESHOLD = VIEWPORT_HEIGHT - KEYBOARD_HEIGHT; // 573

function makeInput(selector: string, bottom: number) {
  return { selector, type: 'text', bottom };
}

function makeBrowser(inputs: ReturnType<typeof makeInput>[], postFocusBottom?: number): SoftKeyboardBrowserScope {
  let callIndex = 0;
  return {
    evaluate: vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('querySelectorAll')) return { value: inputs };
      if (script.includes('visualViewport')) return { value: null };
      // focus + rect script
      callIndex++;
      const bottom = postFocusBottom ?? inputs[callIndex - 1]?.bottom ?? 0;
      return { value: { bottom } };
    }),
    setVirtualKeyboardInsets: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('soft-keyboard-detector', () => {
  it('emits detection when input is occluded after keyboard appears', async () => {
    const inputs = [makeInput('#email', 700)]; // 700 > 573 threshold
    const browser = makeBrowser(inputs, 700);

    const result = await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);

    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('soft_keyboard_occlusion');
    expect(result[0].selectorClass).toBe('#email');
  });

  it('does not emit when input is above keyboard threshold', async () => {
    const inputs = [makeInput('#email', 400)]; // 400 < 573
    const browser = makeBrowser(inputs, 400);

    const result = await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);
    expect(result).toHaveLength(0);
  });

  it('returns empty when setVirtualKeyboardInsets unavailable', async () => {
    const browser: SoftKeyboardBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [makeInput('#e', 700)] }),
    };
    const result = await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);
    expect(result).toHaveLength(0);
  });

  it('returns empty when no visible inputs', async () => {
    const browser: SoftKeyboardBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [] }),
      setVirtualKeyboardInsets: vi.fn().mockResolvedValue({ ok: true }),
    };
    const result = await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);
    expect(result).toHaveLength(0);
  });

  it('always restores keyboard insets (finally block)', async () => {
    const restoreSpy = vi.fn().mockResolvedValue({ ok: true });
    const browser: SoftKeyboardBrowserScope = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('querySelectorAll')) return { value: [makeInput('#a', 700)] };
        if (script.includes('visualViewport')) return { value: null };
        return { value: { bottom: 700 } };
      }),
      setVirtualKeyboardInsets: restoreSpy,
    };

    await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);

    const calls = restoreSpy.mock.calls as number[][];
    // Last call should be restore (0)
    expect(calls[calls.length - 1][0]).toBe(0);
  });

  it('skips remaining inputs when keyboard simulation fails', async () => {
    const browser: SoftKeyboardBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [makeInput('#a', 700), makeInput('#b', 700)] }),
      setVirtualKeyboardInsets: vi.fn().mockResolvedValue({ ok: false, reason: 'emulation_unsupported' }),
    };
    const result = await detectSoftKeyboardOcclusion(browser, '/', VIEWPORT_HEIGHT, KEYBOARD_HEIGHT);
    expect(result).toHaveLength(0);
  });
});
