/**
 * Contract test: adapter → camofox-mcp wire shape for network fault injection.
 *
 * Asserts that BugHunter's NetworkFaultSpec (kind-discriminated) is translated
 * to the exact flat shape expected by camofox-mcp's network_fault tool.
 *
 * Uses the same mock-SDK approach as browser-mcp.shape.test.ts: vi.mock intercepts
 * the MCP SDK Client so no real network I/O occurs. The spy captures the exact
 * arguments object passed to callTool for each NetworkFaultSpec variant.
 *
 * Regression guard for cunninghambe/BugHunter#101 — the drift that caused
 * malformed_response sub-modes and dropEveryN to be silently lost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = {
  callTool: undefined as ReturnType<typeof vi.fn> | undefined,
  callToolImpl: (_params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> =>
    Promise.resolve({ content: [], isError: false }),
};

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    callTool: ReturnType<typeof vi.fn>;

    constructor() {
      this.callTool = vi.fn().mockImplementation(
        (params: { name: string; arguments?: Record<string, unknown> }) => mockState.callToolImpl(params),
      );
      mockState.callTool = this.callTool;
    }
  },
}));

import { CamofoxBrowserMcpAdapter } from '../../src/adapters/browser-mcp.js';
import type { NetworkFaultSpec } from '../../src/types.js';

const STUB_TAB_ID = 'stub-tab-contract';

function makeTextResult(obj: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: false };
}

function makeAdapter(): CamofoxBrowserMcpAdapter {
  return new CamofoxBrowserMcpAdapter({ mode: 'http', url: 'http://127.0.0.1:3104/mcp' });
}

function getCallToolSpy(): ReturnType<typeof vi.fn> {
  if (mockState.callTool === undefined) throw new Error('No Client instance found');
  return mockState.callTool;
}

/** Set up callToolImpl to handle navigate, network_fault, and close_tab. */
function setupMocks() {
  mockState.callToolImpl = (params) => {
    const { name } = params;
    if (name === 'navigate') {
      return Promise.resolve(makeTextResult({
        tabId: STUB_TAB_ID, url: 'http://x', finalUrl: 'http://x', ok: true,
      }));
    }
    if (name === 'network_fault') {
      return Promise.resolve(makeTextResult({ ok: true, applied: true }));
    }
    if (name === 'close_tab') {
      return Promise.resolve(makeTextResult({ ok: true }));
    }
    if (name === 'clear_network_fault') {
      return Promise.resolve(makeTextResult({ ok: true, cleared: null }));
    }
    return Promise.resolve(makeTextResult({ ok: true }));
  };
}

/**
 * Run applyNetworkFault via withTab, then return the exact arguments
 * passed to the network_fault callTool call.
 */
async function applyAndCapture(fault: NetworkFaultSpec): Promise<Record<string, unknown>> {
  const adapter = makeAdapter();
  await adapter.withTab('http://x', undefined, async (scope) => {
    await scope.applyNetworkFault(fault);
  });
  const spy = getCallToolSpy();
  const faultCall = spy.mock.calls.find(
    (c) => (c[0] as { name: string }).name === 'network_fault',
  );
  if (!faultCall) throw new Error('network_fault callTool was never called');
  return (faultCall[0] as { name: string; arguments: Record<string, unknown> }).arguments;
}

describe('network-fault adapter contract — wire shape at adapter→camofox-mcp boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.callTool = undefined;
    setupMocks();
  });

  it('malformed_response + truncated_json → mode: malformed_truncated_json (no kind, no sub-mode)', async () => {
    const args = await applyAndCapture({ kind: 'malformed_response', mode: 'truncated_json' });

    expect(args['mode']).toBe('malformed_truncated_json');
    expect(args['tabId']).toBe(STUB_TAB_ID);
    expect(args['kind']).toBeUndefined();
    // sub-mode must not leak through
    expect(Object.keys(args)).not.toContain('fault');
  });

  it('malformed_response + wrong_content_type → mode: malformed_wrong_content_type', async () => {
    const args = await applyAndCapture({ kind: 'malformed_response', mode: 'wrong_content_type' });

    expect(args['mode']).toBe('malformed_wrong_content_type');
    expect(args['tabId']).toBe(STUB_TAB_ID);
    expect(args['kind']).toBeUndefined();
  });

  it('intermittent with dropEveryN → mode: intermittent, dropEveryN preserved (no percent)', async () => {
    const args = await applyAndCapture({ kind: 'intermittent', dropEveryN: 5 });

    expect(args['mode']).toBe('intermittent');
    expect(args['dropEveryN']).toBe(5);
    // must NOT convert to percent
    expect(args['percent']).toBeUndefined();
    expect(args['tabId']).toBe(STUB_TAB_ID);
  });

  it('server_5xx → mode: server_5xx, statusCode (not status)', async () => {
    const args = await applyAndCapture({ kind: 'server_5xx', status: 502 });

    expect(args['mode']).toBe('server_5xx');
    expect(args['statusCode']).toBe(502);
    // BugHunter uses 'status'; camofox uses 'statusCode'
    expect(args['status']).toBeUndefined();
    expect(args['tabId']).toBe(STUB_TAB_ID);
  });

  it('high_latency → mode: high_latency, latencyMs preserved', async () => {
    const args = await applyAndCapture({ kind: 'high_latency', latencyMs: 3000 });

    expect(args['mode']).toBe('high_latency');
    expect(args['latencyMs']).toBe(3000);
    expect(args['tabId']).toBe(STUB_TAB_ID);
  });

  it('offline → mode: offline, no extra fields', async () => {
    const args = await applyAndCapture({ kind: 'offline' });

    expect(args['mode']).toBe('offline');
    expect(args['tabId']).toBe(STUB_TAB_ID);
    expect(args['kind']).toBeUndefined();
    expect(args['percent']).toBeUndefined();
    expect(args['dropEveryN']).toBeUndefined();
    // must not pass a nested fault object
    expect(Object.keys(args)).not.toContain('fault');
  });

  it('slow_3g → mode: slow_3g', async () => {
    const args = await applyAndCapture({ kind: 'slow_3g' });
    expect(args['mode']).toBe('slow_3g');
    expect(args['tabId']).toBe(STUB_TAB_ID);
  });

  it('timeout_at_request → mode: timeout_at_request', async () => {
    const args = await applyAndCapture({ kind: 'timeout_at_request' });
    expect(args['mode']).toBe('timeout_at_request');
  });

  it('timeout_at_response → mode: timeout_at_response', async () => {
    const args = await applyAndCapture({ kind: 'timeout_at_response' });
    expect(args['mode']).toBe('timeout_at_response');
  });
});
