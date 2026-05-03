// Tests for the data-bughunter-visual-ignore opt-out attribute (#114).

import { describe, it, expect, vi } from 'vitest';
import { pageHasVisualIgnore } from './discover.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';

function makeBrowser(evaluateValue: unknown, throws = false): BrowserMcpAdapter {
  return {
    evaluate: throws
      ? vi.fn().mockRejectedValue(new Error('evaluate failed'))
      : vi.fn().mockResolvedValue({ value: evaluateValue }),
    navigate: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    openTab: vi.fn(),
    closeTabExplicit: vi.fn(),
    withTab: vi.fn(),
    cookies: vi.fn(),
    clickByHint: vi.fn(),
  } as unknown as BrowserMcpAdapter;
}

describe('pageHasVisualIgnore', () => {
  it('returns true when document.querySelector finds data-bughunter-visual-ignore', async () => {
    const browser = makeBrowser(true);
    expect(await pageHasVisualIgnore(browser, '/branding')).toBe(true);
  });

  it('returns true when a child element carries the attribute (ancestor check via querySelector)', async () => {
    // querySelector('[data-bughunter-visual-ignore]') matches descendants too — this
    // verifies the selector covers the child-of-ignored case.
    const browser = makeBrowser(true);
    expect(await pageHasVisualIgnore(browser, '/brand/child')).toBe(true);
  });

  it('returns false when no element carries the attribute', async () => {
    const browser = makeBrowser(false);
    expect(await pageHasVisualIgnore(browser, '/dashboard')).toBe(false);
  });

  it('returns false (does not suppress) when evaluate throws — coverage is preserved', async () => {
    const browser = makeBrowser(null, true);
    expect(await pageHasVisualIgnore(browser, '/any-route')).toBe(false);
  });

  it('passes the correct selector expression to browser.evaluate', async () => {
    const browser = makeBrowser(false);
    await pageHasVisualIgnore(browser, '/check-selector');
    expect(browser.evaluate).toHaveBeenCalledWith(
      'document.querySelector("[data-bughunter-visual-ignore]") !== null',
    );
  });
});
