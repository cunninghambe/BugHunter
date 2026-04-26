import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpSurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';

// Capture the URL that the adapter actually fetches.
function mockFetchCapture(): { urls: string[] } {
  const urls: string[] = [];
  const captured = { urls };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    // Return a minimal valid JSON-RPC response.
    const body = JSON.stringify({
      result: { content: [{ text: JSON.stringify({ revision: 1, tools: [] }) }] },
    });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  }));
  return captured;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpSurfaceMcpAdapter — surfaceMcpUrl convention (§ 3.4.5)', () => {
  it('base URL without /mcp appends /mcp on each call', async () => {
    const { urls } = mockFetchCapture();
    const adapter = new HttpSurfaceMcpAdapter('http://127.0.0.1:3102');
    await adapter.surface_list_tools();
    expect(urls[0]).toBe('http://127.0.0.1:3102/mcp');
  });

  it('URL with trailing /mcp produces the same final URL as the base URL form', async () => {
    const { urls: urlsBase } = mockFetchCapture();
    const base = new HttpSurfaceMcpAdapter('http://127.0.0.1:3102');
    await base.surface_list_tools();
    const baseUrl = urlsBase[0];

    const { urls: urlsLegacy } = mockFetchCapture();
    const legacy = new HttpSurfaceMcpAdapter('http://127.0.0.1:3102/mcp');
    await legacy.surface_list_tools();
    const legacyUrl = urlsLegacy[0];

    expect(legacyUrl).toBe(baseUrl);
  });

  it('URL with trailing /mcp/ (extra slash) is also normalised', async () => {
    const { urls } = mockFetchCapture();
    const adapter = new HttpSurfaceMcpAdapter('http://127.0.0.1:3102/mcp/');
    await adapter.surface_list_tools();
    expect(urls[0]).toBe('http://127.0.0.1:3102/mcp');
  });
});
