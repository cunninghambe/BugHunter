/**
 * Stdio-transport-specific tests for CamofoxBrowserMcpAdapter — §7.3.
 * Tests subprocess error handling, dispose() cleanup, and concurrency safety.
 *
 * All tests mock the SDK Client + StdioClientTransport to avoid spawning real subprocesses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable state — must be a plain object to survive vi.mock hoisting.
const mockState = {
  connectShouldReject: false,
  connectRejectMessage: '',
  connectCallCount: 0,
  // Constructor args from the last StdioClientTransport instantiation
  lastStdioArgs: undefined as Record<string, unknown> | undefined,
  // The callTool spy on the last Client instance
  callTool: undefined as ReturnType<typeof vi.fn> | undefined,
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect: ReturnType<typeof vi.fn>;
    close = vi.fn().mockResolvedValue(undefined);
    callTool: ReturnType<typeof vi.fn>;

    constructor() {
      mockState.connectCallCount++;
      this.connect = vi.fn().mockImplementation(() => {
        if (mockState.connectShouldReject) {
          return Promise.reject(new Error(mockState.connectRejectMessage));
        }
        return Promise.resolve();
      });
      this.callTool = vi.fn().mockImplementation(() =>
        Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify({ tabId: 'tab-stdio-test', url: 'http://x', finalUrl: 'http://x', tabs: [] }) }],
          isError: false,
        }),
      );
      mockState.callTool = this.callTool;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdio {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);

    constructor(args: Record<string, unknown>) {
      mockState.lastStdioArgs = args;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockHTTP {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

import { CamofoxBrowserMcpAdapter, CamofoxBrowserHttpAdapter } from './browser-mcp.js';

function makeStdioAdapter() {
  return new CamofoxBrowserMcpAdapter({
    mode: 'stdio',
    command: 'node',
    args: ['/opt/camofox-mcp/dist/index.js'],
  });
}

describe('CamofoxBrowserMcpAdapter — stdio transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.connectShouldReject = false;
    mockState.connectRejectMessage = '';
    mockState.connectCallCount = 0;
    mockState.lastStdioArgs = undefined;
    mockState.callTool = undefined;
  });

  it('connects via StdioClientTransport with the given command and args', async () => {
    const adapter = makeStdioAdapter();

    await adapter.navigate('http://x');

    expect(mockState.lastStdioArgs).toMatchObject({
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
      stderr: 'inherit',
    });

    await adapter.dispose();
  });

  it('dispose() before any call is a no-op (does not throw)', async () => {
    const adapter = makeStdioAdapter();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('double dispose() is safe (second call is no-op)', async () => {
    const adapter = makeStdioAdapter();
    await adapter.navigate('http://x');
    await adapter.dispose();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('throws BrowserMcpError(transport) when subprocess fails to start', async () => {
    mockState.connectShouldReject = true;
    mockState.connectRejectMessage = 'ENOENT: no such file or directory, spawn /missing/bin';

    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: '/missing/bin',
      args: [],
    });

    await expect(adapter.navigate('http://x')).rejects.toMatchObject({
      kind: 'transport',
      message: expect.stringContaining('subprocess failed to start'),
    });
  });

  it('wraps callTool transport errors as BrowserMcpError(transport)', async () => {
    const adapter = makeStdioAdapter();
    await adapter.navigate('http://x');

    if (mockState.callTool === undefined) throw new Error('No callTool spy captured');
    mockState.callTool.mockRejectedValueOnce(new Error('Transport closed unexpectedly'));

    await expect(adapter.listTabs()).rejects.toMatchObject({ kind: 'transport' });
  });

  it('concurrent first callers share the same connectPromise — connect called once', async () => {
    const adapter = makeStdioAdapter();

    await Promise.all([
      adapter.navigate('http://a'),
      adapter.navigate('http://b'),
    ]);

    // Only one Client instance should have been created (one connect)
    expect(mockState.connectCallCount).toBe(1);
    await adapter.dispose();
  });

  it('missing command throws BrowserMcpError(transport) on first use', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
    } as never);

    await expect(adapter.navigate('http://x')).rejects.toMatchObject({
      kind: 'transport',
      message: expect.stringContaining('command'),
    });
  });
});

describe('CamofoxBrowserHttpAdapter — deprecation warning', () => {
  beforeEach(() => {
    // Reset static flag between tests
    (CamofoxBrowserHttpAdapter as unknown as { deprecationWarned: boolean }).deprecationWarned = false;
  });

  it('emits a console.warn on first construction', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new CamofoxBrowserHttpAdapter('http://127.0.0.1:3104');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('deprecated');
    warnSpy.mockRestore();
  });

  it('emits warning only once per process — subsequent constructions are silent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new CamofoxBrowserHttpAdapter('http://127.0.0.1:3104');
    new CamofoxBrowserHttpAdapter('http://127.0.0.1:3104');
    new CamofoxBrowserHttpAdapter('http://127.0.0.1:3104');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
