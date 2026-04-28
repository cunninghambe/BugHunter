// B-11 and B-12 regression tests.
// B-11: screenshot with empty outputPath must throw, not silently write nothing.
// B-12: domain-hints returns undefined for empty hint string, not empty string.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CamofoxBrowserMcpAdapter } from '../src/adapters/browser-mcp.js';
import { resolveDomainHint } from '../src/mutation/domain-hints.js';
import type { SurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';

// ─── B-11 ─────────────────────────────────────────────────────────────────────

function mockFetch(dataUrl: string): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params?: { name?: string } };
    const name = body.params?.name ?? '';

    if (name === 'navigate') {
      return new Response(
        JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: 'tab-b11', ok: true, finalUrl: 'http://x' }) }] } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (name === 'screenshot') {
      return new Response(
        JSON.stringify({ result: { content: [{ type: 'image', mimeType: 'image/png', data: dataUrl }] } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
      { headers: { 'content-type': 'application/json' } }
    );
  }));
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('B-11: screenshot empty outputPath throws', () => {
  it('B-11: passing empty string outputPath throws instead of silently writing nothing', async () => {
    mockFetch('iVBORw0KGgo=');
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    await expect(adapter.screenshot('')).rejects.toThrow('outputPath is empty');
  });

  it('B-11: undefined outputPath succeeds and returns no path', async () => {
    mockFetch('iVBORw0KGgo=');
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    const result = await adapter.screenshot(undefined);
    expect(result.path).toBe('');
  });
});

// ─── B-12 ─────────────────────────────────────────────────────────────────────

function mockSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn().mockResolvedValue({ samples: [] }),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn(),
    surface_describe_self: vi.fn(),
    surface_describe_auth: vi.fn(),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  };
}

describe('B-12: domain-hints returns undefined for empty hint', () => {
  it('B-12: empty string hint produces undefined and logs a warning', async () => {
    const surface = mockSurface();
    const result = await resolveDomainHint('slug', undefined, surface, { slug: [''] });
    // Empty string hint must NOT be returned as the happy-path value.
    expect(result).toBeUndefined();
  });

  it('B-12: valid non-empty hint is returned', async () => {
    const surface = mockSurface();
    const result = await resolveDomainHint('slug', undefined, surface, { slug: ['my-slug'] });
    expect(result).toBe('my-slug');
  });

  it('B-12: undefined hint (key absent) produces undefined', async () => {
    const surface = mockSurface();
    const result = await resolveDomainHint('slug', undefined, surface, {});
    expect(result).toBeUndefined();
  });
});
