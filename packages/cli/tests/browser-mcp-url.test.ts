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

  it('click() with string selector uses evaluate (not snapshot+ref) — v0.12', async () => {
    // v0.12: string-selector clicks go through a single evaluate round-trip.
    // No snapshot call, no camofox click call.
    const capturedBodies: Record<string, unknown>[] = [];

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      capturedBodies.push(body);

      const params = body['params'] as { name?: string; arguments?: Record<string, unknown> };

      if (params?.name === 'evaluate') {
        // Return a valid click result so runEvaluateClick succeeds
        return new Response(JSON.stringify({
          result: { content: [{ text: JSON.stringify({ tabId: 't1', result: { ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-label', tagName: 'button', role: null } }) }] },
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

    // Must call evaluate (not snapshot or camofox click)
    const evalBody = capturedBodies.find(b => {
      const p = b['params'] as { name?: string } | undefined;
      return p?.name === 'evaluate';
    });
    expect(evalBody).toBeDefined();
    const evalArgs = (evalBody?.['params'] as { arguments?: Record<string, unknown> })?.arguments;
    expect(evalArgs?.['tabId']).toBeDefined();
    expect(evalArgs?.['expression']).toBeDefined();
    expect(typeof evalArgs?.['expression']).toBe('string');

    // Must NOT call snapshot or camofox click for string selectors
    const snapshotBody = capturedBodies.find(b => (b['params'] as { name?: string } | undefined)?.name === 'snapshot');
    expect(snapshotBody).toBeUndefined();
    const clickBody = capturedBodies.find(b => (b['params'] as { name?: string } | undefined)?.name === 'click');
    expect(clickBody).toBeUndefined();
  });
});
