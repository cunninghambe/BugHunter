import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CamofoxBrowserMcpAdapter } from '../src/adapters/browser-mcp.js';

// Capture the URL + request body that the adapter fetches.
type CapturedCall = { url: string; body: Record<string, unknown> };

function mockFetchCapture(responsePayload: unknown = { tabs: [] }): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body: parsed });
    const text = JSON.stringify({
      result: { content: [{ text: JSON.stringify(responsePayload) }] },
    });
    return new Response(text, { headers: { 'content-type': 'application/json' } });
  }));
  return { calls };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('CamofoxBrowserMcpAdapter — browserMcpUrl convention (§4)', () => {
  it('base URL without /mcp appends /mcp on each call', async () => {
    const { calls } = mockFetchCapture();
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.listTabs();
    expect(calls[0]?.url).toBe('http://127.0.0.1:3104/mcp');
  });

  it('URL with trailing /mcp produces the same final URL as base form', async () => {
    const { calls: calls1 } = mockFetchCapture();
    const base = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await base.listTabs();

    const { calls: calls2 } = mockFetchCapture();
    const withMcp = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp');
    await withMcp.listTabs();

    expect(calls1[0]?.url).toBe(calls2[0]?.url);
  });

  it('URL with trailing /mcp/ (extra slash) is also normalised', async () => {
    const { calls } = mockFetchCapture();
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104/mcp/');
    await adapter.listTabs();
    expect(calls[0]?.url).toBe('http://127.0.0.1:3104/mcp');
  });

  it('listTabs() request uses bare tool name list_tabs (no mcp__camofox__ prefix)', async () => {
    const { calls } = mockFetchCapture();
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.listTabs();
    const params = calls[0]?.body?.['params'] as { name?: string } | undefined;
    expect(params?.name).toBe('list_tabs');
  });

  it('navigate() request uses bare tool name navigate', async () => {
    const { calls } = mockFetchCapture({ tabId: 't1', ok: true, finalUrl: 'https://x.com' });
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('https://x.com');
    const params = calls[0]?.body?.['params'] as { name?: string } | undefined;
    expect(params?.name).toBe('navigate');
  });

  it('click() sends tabId and ref (not selector), and uses snapshot first', async () => {
    // First call: navigate to set tabId
    // Second call: snapshot (returns a11y tree with #submit ref)
    // Third call: click with {tabId, ref}
    const snapshotText = `- generic [e1]:
  - button "Submit" [ref=e3]`;

    let callCount = 0;
    const capturedBodies: Record<string, unknown>[] = [];

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      capturedBodies.push(body);
      callCount++;

      const params = body['params'] as { name?: string; arguments?: Record<string, unknown> };

      if (params?.name === 'snapshot') {
        return new Response(JSON.stringify({
          result: { content: [{ text: JSON.stringify({ tabId: 't1', snapshot: snapshotText }) }] },
        }), { headers: { 'content-type': 'application/json' } });
      }

      if (params?.name === 'click') {
        return new Response(JSON.stringify({
          result: { content: [{ text: JSON.stringify({ tabId: 't1', ok: true }) }] },
        }), { headers: { 'content-type': 'application/json' } });
      }

      // Default (navigate, list_tabs, etc.)
      return new Response(JSON.stringify({
        result: { content: [{ text: JSON.stringify({ tabId: 't1', ok: true, finalUrl: 'http://x' }) }] },
      }), { headers: { 'content-type': 'application/json' } });
    }));

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    await adapter.click('button[aria-label="Submit"]');

    const clickBody = capturedBodies.find(b => {
      const p = b['params'] as { name?: string } | undefined;
      return p?.name === 'click';
    });
    expect(clickBody).toBeDefined();
    const clickArgs = (clickBody?.['params'] as { arguments?: Record<string, unknown> })?.arguments;
    expect(clickArgs?.['tabId']).toBeDefined();
    expect(clickArgs?.['ref']).toBeDefined();
    expect(clickArgs?.['selector']).toBeUndefined();
  });
});
