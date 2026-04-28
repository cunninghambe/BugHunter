import { describe, it, expect, vi } from 'vitest';
import { PlaywrightKeyboardTrapProbe } from '../../src/adapters/keyboard-trap-probe.js';
import type { TabScope } from '../../src/adapters/browser-mcp.js';

function makeScope(focusSequence: string[]): TabScope {
  let callCount = 0;
  return {
    tabId: 'test-tab',
    navigate: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    clickByHint: vi.fn(),
    evaluate: vi.fn().mockImplementation((script: string) => {
      // document.body.focus() call
      if (script.includes('document.body.focus')) {
        return Promise.resolve({ value: null });
      }
      // keydown dispatch
      if (script.includes('KeyboardEvent')) {
        return Promise.resolve({ value: null });
      }
      // focus advance
      if (script.includes('focusables')) {
        return Promise.resolve({ value: null });
      }
      // active element query
      if (script.includes('activeElement')) {
        const val = focusSequence[callCount] ?? 'BODY';
        callCount++;
        return Promise.resolve({ value: val });
      }
      return Promise.resolve({ value: null });
    }),
  } as unknown as TabScope;
}

describe('PlaywrightKeyboardTrapProbe', () => {
  it('returns trapped:true when all focus elements are identical', async () => {
    const trapped = Array(5).fill('INPUT#modal');
    const scope = makeScope(trapped);
    const probe = new PlaywrightKeyboardTrapProbe();
    const result = await probe.probe(scope, 5);
    expect(result.trapped).toBe(true);
    if (result.trapped) {
      expect(result.selectorClass).toBe('INPUT#modal');
      expect(result.pressCount).toBe(5);
      expect(result.observedFocusChain).toHaveLength(5);
    }
  });

  it('returns trapped:false when focus moves across elements', async () => {
    const chain = ['INPUT#a', 'INPUT#b', 'BUTTON#c', 'INPUT#d', 'TEXTAREA#e'];
    const scope = makeScope(chain);
    const probe = new PlaywrightKeyboardTrapProbe();
    const result = await probe.probe(scope, 5);
    expect(result.trapped).toBe(false);
  });

  it('returns trapped:false when focus lands on BODY (non-interactive page)', async () => {
    const chain = Array(5).fill('BODY');
    const scope = makeScope(chain);
    const probe = new PlaywrightKeyboardTrapProbe();
    const result = await probe.probe(scope, 5);
    expect(result.trapped).toBe(false);
  });

  it('returns trapped:false when focus lands on null', async () => {
    const chain = Array(5).fill('null');
    const scope = makeScope(chain);
    const probe = new PlaywrightKeyboardTrapProbe();
    const result = await probe.probe(scope, 5);
    expect(result.trapped).toBe(false);
  });

  it('uses the configured maxPresses', async () => {
    const chain = Array(3).fill('INPUT#trap');
    const scope = makeScope(chain);
    const probe = new PlaywrightKeyboardTrapProbe();
    const result = await probe.probe(scope, 3);
    expect(result.trapped).toBe(true);
    if (result.trapped) {
      expect(result.pressCount).toBe(3);
    }
  });
});
