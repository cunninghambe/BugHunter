/**
 * Unit tests for CamofoxBrowserMcpAdapter.withTab lifecycle.
 *
 * Verifies:
 * - openTab creates a new tab without aliasing currentTabId
 * - scope methods carry the bound tabId
 * - closeTabExplicit fires on fn success
 * - closeTabExplicit fires on fn throw (no tab leakage)
 * - concurrent withTab calls use independent tabIds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CamofoxBrowserMcpAdapter } from '../../src/adapters/browser-mcp.js';

const SIMPLE_SNAPSHOT = `
- generic [e1]:
  - button "Submit" [ref=e2]
`;

type FetchCall = { name: string; arguments: Record<string, unknown> };

function mockDispatch(
  handlers: Record<string, unknown>,
  defaultPayload: unknown = { ok: true }
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const name = body.params?.name ?? '';
    const args = body.params?.arguments ?? {};
    calls.push({ name, arguments: args });

    const payload = Object.prototype.hasOwnProperty.call(handlers, name)
      ? handlers[name]
      : defaultPayload;

    return new Response(
      JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }),
      { headers: { 'content-type': 'application/json' } }
    );
  }));
  return { calls };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('CamofoxBrowserMcpAdapter.withTab', () => {
  it('opens a tab, runs fn with bound scope, closes tab on success', async () => {
    const { calls } = mockDispatch({
      navigate: { tabId: 'tab-1', ok: true, finalUrl: 'http://x' },
      snapshot: { tabId: 'tab-1', snapshot: SIMPLE_SNAPSHOT },
      close_tab: { ok: true },
    });

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    let scopeTabId = '';

    await adapter.withTab('http://x', undefined, async (scope) => {
      scopeTabId = scope.tabId;
      await scope.snapshot();
    });

    expect(scopeTabId).toBe('tab-1');
    const navigateCalls = calls.filter(c => c.name === 'navigate');
    expect(navigateCalls).toHaveLength(1);
    expect(navigateCalls[0].arguments['url']).toBe('http://x');
    // No tabId on initial navigate (new tab creation)
    expect(navigateCalls[0].arguments['tabId']).toBeUndefined();

    const closeCalls = calls.filter(c => c.name === 'close_tab');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].arguments['tabId']).toBe('tab-1');
  });

  it('closes tab even when fn throws', async () => {
    const { calls } = mockDispatch({
      navigate: { tabId: 'tab-err', ok: true, finalUrl: 'http://x' },
      close_tab: { ok: true },
    });

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');

    await expect(
      adapter.withTab('http://x', undefined, async (_scope) => {
        throw new Error('fn failure');
      })
    ).rejects.toThrow('fn failure');

    const closeCalls = calls.filter(c => c.name === 'close_tab');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].arguments['tabId']).toBe('tab-err');
  });

  it('scope methods carry the bound tabId, not the shared currentTabId', async () => {
    let tabIdCounter = 0;
    const fetchCalls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const name = body.params?.name ?? '';
      const args = body.params?.arguments ?? {};
      fetchCalls.push({ name, arguments: args });

      if (name === 'navigate' && !args['tabId']) {
        tabIdCounter++;
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: `tab-${tabIdCounter}`, ok: true, finalUrl: 'http://x' }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: args['tabId'] ?? 'tab-x', snapshot: SIMPLE_SNAPSHOT, ok: true }) }] } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }));

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');

    // Run two withTab calls concurrently — each gets its own tabId
    const [id1, id2] = await Promise.all([
      adapter.withTab('http://x', undefined, async (scope) => {
        // Simulate some async work — the scope tabId must stay stable
        await new Promise(r => setTimeout(r, 5));
        await scope.snapshot();
        return scope.tabId;
      }),
      adapter.withTab('http://x', undefined, async (scope) => {
        await new Promise(r => setTimeout(r, 2));
        await scope.snapshot();
        return scope.tabId;
      }),
    ]);

    expect(id1).not.toBe(id2);

    // Every snapshot call must carry its own tab's tabId, not the other's
    const snapshotCalls = fetchCalls.filter(c => c.name === 'snapshot');
    expect(snapshotCalls).toHaveLength(2);
    const snapshotTabIds = snapshotCalls.map(c => c.arguments['tabId']);
    expect(snapshotTabIds).toContain(id1);
    expect(snapshotTabIds).toContain(id2);
  });

  it('does not mutate currentTabId after withTab completes', async () => {
    // Set up: first navigate gives 'legacy-tab', subsequent navigate gives 'scoped-tab'
    let navigateCount = 0;
    const fetchCalls: FetchCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const name = body.params?.name ?? '';
      const args = body.params?.arguments ?? {};
      fetchCalls.push({ name, arguments: args });

      if (name === 'navigate') {
        navigateCount++;
        const tabId = navigateCount === 1 ? 'legacy-tab' : 'scoped-tab';
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId, ok: true, finalUrl: 'http://x' }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      if (name === 'snapshot') {
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: args['tabId'] ?? '', snapshot: SIMPLE_SNAPSHOT }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }));

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');

    // Establish legacy-tab as currentTabId
    await adapter.navigate('http://x');

    // withTab opens scoped-tab; must not overwrite currentTabId
    await adapter.withTab('http://y', undefined, async (_scope) => {});

    // After withTab, legacy snapshot() still uses 'legacy-tab'
    await adapter.snapshot();
    const snapshotCalls = fetchCalls.filter(c => c.name === 'snapshot');
    const lastSnapshot = snapshotCalls[snapshotCalls.length - 1];
    expect(lastSnapshot?.arguments['tabId']).toBe('legacy-tab');
  });
});
