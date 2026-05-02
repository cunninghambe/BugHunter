// Null BrowserMcpAdapter for bisect — used when no real browser is available.
// All methods return safe no-op values matching the interface contract.

import type { BrowserMcpAdapter, TabScope, ExtraHeaders } from '../../adapters/browser-mcp.js';

function makeNullTabScope(): TabScope {
  return {
    tabId: '',
    navigate: async () => ({ url: '' }),
    click: async () => ({ clicked: false }),
    type: async () => ({ typed: false }),
    scroll: async () => ({ scrolled: false }),
    snapshot: async () => ({ snapshot: '' }),
    screenshot: async () => ({ path: '' }),
    evaluate: async () => ({ value: null }),
    clickByHint: async () => ({ clicked: false as const, reason: 'no_hint_fields' as const }),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- interface contract: all BrowserMcpAdapter methods must return Promise
export function makeNullBrowser(): BrowserMcpAdapter {
  return {
    navigate: async () => ({ url: '' }),
    click: async () => ({ clicked: false }),
    type: async () => ({ typed: false }),
    scroll: async () => ({ scrolled: false }),
    snapshot: async () => ({ snapshot: '' }),
    screenshot: async () => ({ path: '' }),
    evaluate: async () => ({ value: null }),
    listTabs: async () => ({ tabs: [] }),
    closeTab: async () => ({ closed: false }),
    openTab: async () => ({ tabId: '', finalUrl: '' }),
    closeTabExplicit: async () => undefined,
    withTab: <T>(_u: string, _h: ExtraHeaders | undefined, fn: (s: TabScope) => Promise<T>): Promise<T> =>
      fn(makeNullTabScope()),
    cookies: async () => ({ tabId: '', cookies: [] }),
    clickByHint: async () => ({ clicked: false as const, reason: 'no_hint_fields' as const }),
  };
}
