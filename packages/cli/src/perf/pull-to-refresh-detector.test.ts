import { describe, it, expect, vi } from 'vitest';
import {
  detectPullToRefreshConflict,
  installPullToRefreshInitScript,
  PULL_TO_REFRESH_INIT_SCRIPT,
} from './pull-to-refresh-detector.js';
import type { PullToRefreshBrowserScope } from './pull-to-refresh-detector.js';

function makeBrowser(listeners: Array<{ type: string; passive: boolean; selector: string }>): PullToRefreshBrowserScope {
  return {
    evaluate: vi.fn().mockImplementation(async (script: string) => {
      if (script.includes('__bh_listeners__')) return { value: listeners };
      // y-position script
      return { value: 0 }; // near top
    }),
    addInitScript: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('pull-to-refresh-detector', () => {
  it('emits detection for non-passive touchstart on window', async () => {
    const browser = makeBrowser([{ type: 'touchstart', passive: false, selector: 'window' }]);
    const result = await detectPullToRefreshConflict(browser, '/');
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('pull_to_refresh_conflict');
    expect(result[0].rootCause).toContain('touchstart');
  });

  it('does not emit for passive touchstart', async () => {
    const browser = makeBrowser([{ type: 'touchstart', passive: true, selector: 'window' }]);
    const result = await detectPullToRefreshConflict(browser, '/');
    expect(result).toHaveLength(0);
  });

  it('does not emit when no listeners captured', async () => {
    const browser = makeBrowser([]);
    const result = await detectPullToRefreshConflict(browser, '/');
    expect(result).toHaveLength(0);
  });

  it('deduplicates same listener type+selector', async () => {
    const browser = makeBrowser([
      { type: 'touchmove', passive: false, selector: 'window' },
      { type: 'touchmove', passive: false, selector: 'window' },
    ]);
    const result = await detectPullToRefreshConflict(browser, '/');
    expect(result).toHaveLength(1);
  });

  it('emits for both touchstart and touchmove non-passive', async () => {
    const browser = makeBrowser([
      { type: 'touchstart', passive: false, selector: 'document' },
      { type: 'touchmove', passive: false, selector: 'document' },
    ]);
    const result = await detectPullToRefreshConflict(browser, '/');
    expect(result).toHaveLength(2);
  });

  it('installPullToRefreshInitScript returns ok:false when addInitScript unavailable', async () => {
    const browser: PullToRefreshBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [] }),
    };
    const result = await installPullToRefreshInitScript(browser);
    expect(result.ok).toBe(false);
  });

  it('installPullToRefreshInitScript calls addInitScript with correct script', async () => {
    const addInitSpy = vi.fn().mockResolvedValue({ ok: true });
    const browser: PullToRefreshBrowserScope = {
      evaluate: vi.fn().mockResolvedValue({ value: [] }),
      addInitScript: addInitSpy,
    };
    const result = await installPullToRefreshInitScript(browser);
    expect(result.ok).toBe(true);
    expect(addInitSpy).toHaveBeenCalledWith(PULL_TO_REFRESH_INIT_SCRIPT);
  });
});
