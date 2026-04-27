// Unit tests for CamofoxBrowserMcpAdapter.cookies()
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CamofoxBrowserMcpAdapter } from '../../src/adapters/browser-mcp.js';

function makeFetchMock(responseBody: unknown, status = 200) {
  return vi.fn(async () => {
    const body = JSON.stringify({
      result: {
        content: [{ type: 'text', text: JSON.stringify(responseBody) }],
        isError: false,
      },
    });
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('CamofoxBrowserMcpAdapter.cookies()', () => {
  let adapter: CamofoxBrowserMcpAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    // Manually set a current tab by navigating first
  });

  it('calls the cookies MCP tool with the current tabId', async () => {
    const cookiesResponse = { tabId: 'tab-abc', cookies: [{ name: 'session', value: 'x', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }] };
    fetchMock = makeFetchMock(cookiesResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First navigate to set currentTabId
    const navResponse = { tabId: 'tab-abc', url: 'http://localhost/' };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(navResponse) }] } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await adapter.navigate('http://localhost/');

    // Now set cookies mock
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(cookiesResponse) }] } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await adapter.cookies();
    expect(result.tabId).toBe('tab-abc');
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]!.name).toBe('session');
    expect(result.cookies[0]!.httpOnly).toBe(true);

    // Verify the request included the tabId
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const body = JSON.parse(lastCall[1]!.body as string) as { params: { name: string; arguments: { tabId: string } } };
    expect(body.params.name).toBe('cookies');
    expect(body.params.arguments.tabId).toBe('tab-abc');
    expect(body.params.arguments).not.toHaveProperty('urls');
  });

  it('forwards the urls argument when provided', async () => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const navResponse = { tabId: 'tab-xyz', url: 'http://localhost/' };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(navResponse) }] } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await adapter.navigate('http://localhost/');

    const cookiesResponse = { tabId: 'tab-xyz', cookies: [] };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(cookiesResponse) }] } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await adapter.cookies(['http://localhost:3002']);

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const body = JSON.parse(lastCall[1]!.body as string) as { params: { arguments: { urls: string[] } } };
    expect(body.params.arguments.urls).toEqual(['http://localhost:3002']);
  });
});
