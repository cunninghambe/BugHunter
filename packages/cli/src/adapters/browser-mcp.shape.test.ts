/**
 * Snapshot tests for CamofoxBrowserMcpAdapter — §7.2.
 *
 * Each test records the exact `callTool` argument object for one adapter method.
 * Vitest snapshot-matches them. Catches accidental argument-shape drift.
 *
 * Mock strategy: vi.mock the SDK Client and transports so no real I/O occurs.
 * The callTool spy is captured into a module-level mutable container by the
 * MockClient constructor so tests can inspect it after connect() runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be a plain object — vi.mock factories are hoisted before variable initialization.
// Each MockClient constructor call updates lastCallToolSpy with its own spy.
const mockState = {
  callTool: undefined as ReturnType<typeof vi.fn> | undefined,
  callToolImpl: (_params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> =>
    Promise.resolve({ content: [], isError: false }),
};

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdio {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    callTool: ReturnType<typeof vi.fn>;

    constructor() {
      // Create this instance's callTool spy and route it through mockState.callToolImpl
      this.callTool = vi.fn().mockImplementation(
        (params: { name: string; arguments?: Record<string, unknown> }) =>
          mockState.callToolImpl(params),
      );
      // Expose via mockState so tests can inspect/override after connect()
      mockState.callTool = this.callTool;
    }
  },
}));

import { CamofoxBrowserMcpAdapter, CamofoxBrowserHttpAdapter, makeBrowserAdapter } from './browser-mcp.js';

const TAB_ID = 'tab-shape-test';

function makeTextResult(obj: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    isError: false,
  };
}

function makeImageResult() {
  return {
    content: [{ type: 'image', data: 'base64data==', mimeType: 'image/png' }],
    isError: false,
  };
}

function makeAdapter(): CamofoxBrowserMcpAdapter {
  return new CamofoxBrowserMcpAdapter({ mode: 'http', url: 'http://127.0.0.1:3104/mcp' });
}

/** Returns the callTool spy on the last Client instance created. */
function getCallToolSpy(): ReturnType<typeof vi.fn> {
  if (mockState.callTool === undefined) throw new Error('No Client instance found — was connect() called?');
  return mockState.callTool;
}

function setupDefaultCallTool() {
  mockState.callToolImpl = (params) => {
    const name = params.name;
    if (name === 'navigate') return Promise.resolve(makeTextResult({ tabId: TAB_ID, url: 'http://x', finalUrl: 'http://x' }));
    if (name === 'snapshot') return Promise.resolve(makeTextResult({ tabId: TAB_ID, snapshot: '' }));
    if (name === 'click') return Promise.resolve(makeTextResult({ tabId: TAB_ID, ok: true }));
    if (name === 'type') return Promise.resolve(makeTextResult({ tabId: TAB_ID, ok: true }));
    if (name === 'scroll') return Promise.resolve(makeTextResult({ tabId: TAB_ID, ok: true }));
    if (name === 'screenshot') return Promise.resolve(makeImageResult());
    if (name === 'evaluate') return Promise.resolve(makeTextResult({ tabId: TAB_ID, result: null }));
    if (name === 'list_tabs') return Promise.resolve(makeTextResult({ tabs: [] }));
    if (name === 'close_tab') return Promise.resolve(makeTextResult({ ok: true }));
    if (name === 'cookies') return Promise.resolve(makeTextResult({ tabId: TAB_ID, cookies: [] }));
    if (name === 'set_viewport') return Promise.resolve(makeTextResult({ tabId: TAB_ID, ok: true, width: 1280, height: 720 }));
    if (name === 'route_fulfill') return Promise.resolve(makeTextResult({ fulfillId: 'f1' }));
    if (name === 'route_fulfill_remove') return Promise.resolve(makeTextResult({ ok: true }));
    return Promise.resolve(makeTextResult({ ok: true }));
  };
}

async function makeNavigatedAdapter(): Promise<CamofoxBrowserMcpAdapter> {
  const adapter = makeAdapter();
  await adapter.navigate('http://x');
  getCallToolSpy().mockClear();
  return adapter;
}

describe('CamofoxBrowserMcpAdapter — callTool argument shapes (§7.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.callTool = undefined;
    setupDefaultCallTool();
  });

  it('navigate args shape — new tab', async () => {
    const adapter = makeAdapter();
    await adapter.navigate('http://example.com');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('navigate args shape — existing tab (with tabId)', async () => {
    const adapter = makeAdapter();
    await adapter.navigate('http://first');
    const spy = getCallToolSpy();
    spy.mockClear();
    await adapter.navigate('http://second');
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('listTabs args shape', async () => {
    const adapter = makeAdapter();
    await adapter.listTabs();
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('snapshot args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.snapshot();
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('evaluate args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.evaluate('document.title');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('scroll args shape — down with custom distance', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.scroll('body', 'down', 300);
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('scroll args shape — up with default distance', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.scroll('body', 'up');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('cookies args shape — no urls', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.cookies();
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('cookies args shape — with urls', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.cookies(['http://example.com']);
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('closeTab args shape', async () => {
    const adapter = makeAdapter();
    await adapter.closeTab('tab-close-test');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('closeTabExplicit args shape', async () => {
    const adapter = makeAdapter();
    await adapter.closeTabExplicit('tab-explicit-close');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('openTab args shape — always new tab (no tabId)', async () => {
    const adapter = makeAdapter();
    await adapter.openTab('http://newtab.com');
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('setViewport args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.setViewport!(1280, 720);
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('routeFulfill args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.routeFulfill!(
      { method: 'POST', path: '/api/items' },
      { status: 200, body: '{"ok":true}', contentType: 'application/json' },
    );
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('routeFulfill with bodyHash args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.routeFulfill!(
      { method: 'DELETE', path: '/api/items/1', bodyHash: 'abc123' },
      { status: 204, body: '' },
    );
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });

  it('screenshot args shape', async () => {
    const adapter = await makeNavigatedAdapter();
    await adapter.screenshot();
    const spy = getCallToolSpy();
    expect(spy.mock.calls[0][0]).toMatchSnapshot();
  });
});

describe('CamofoxBrowserMcpAdapter — error mapping (§4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.callTool = undefined;
    setupDefaultCallTool();
  });

  it('isError:true maps to BrowserMcpError with classifyRpcError kind', async () => {
    const adapter = await makeNavigatedAdapter();
    const spy = getCallToolSpy();
    spy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'No element found for selector' }],
      isError: true,
    });
    await expect(adapter.snapshot()).rejects.toMatchObject({ kind: 'element_not_found' });
  });

  it('transport error wraps in BrowserMcpError with kind transport', async () => {
    const adapter = await makeNavigatedAdapter();
    const spy = getCallToolSpy();
    spy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(adapter.evaluate('1+1')).rejects.toMatchObject({ kind: 'transport' });
  });

  it('auth key is redacted from error messages (EC-7)', async () => {
    const adapter = await makeNavigatedAdapter();
    const spy = getCallToolSpy();
    spy.mockRejectedValueOnce(
      new Error('Request failed: Authorization: Bearer secret-token-xyz'),
    );
    await expect(adapter.evaluate('1+1')).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && !err.message.includes('secret-token-xyz'),
    );
  });

  it('screenshot_failed kind for screenshot tool isError', async () => {
    const adapter = await makeNavigatedAdapter();
    const spy = getCallToolSpy();
    spy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'screenshot failed: viewport too large' }],
      isError: true,
    });
    await expect(adapter.screenshot()).rejects.toMatchObject({ kind: 'screenshot_failed' });
  });
});

describe('CamofoxBrowserMcpAdapter — no_tab guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.callTool = undefined;
    setupDefaultCallTool();
  });

  it('throws BrowserMcpError(no_tab) when no tab is open', async () => {
    const adapter = makeAdapter();
    await expect(adapter.snapshot()).rejects.toMatchObject({ kind: 'no_tab' });
    await expect(adapter.evaluate('1')).rejects.toMatchObject({ kind: 'no_tab' });
    await expect(adapter.screenshot()).rejects.toMatchObject({ kind: 'no_tab' });
  });
});

describe('CamofoxBrowserMcpAdapter — factory (makeBrowserAdapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.callTool = undefined;
    setupDefaultCallTool();
  });

  it('returns undefined when browserMcpUrl is not set and transport is mcp-http', () => {
    const result = makeBrowserAdapter({ projectName: 'test', surfaceMcpUrl: 'http://x' });
    expect(result).toBeUndefined();
  });

  it('returns CamofoxBrowserMcpAdapter for mcp-http transport', () => {
    const result = makeBrowserAdapter({
      projectName: 'test',
      surfaceMcpUrl: 'http://x',
      browserMcpUrl: 'http://127.0.0.1:3104/mcp',
      browserTransport: 'mcp-http',
    });
    expect(result).toBeInstanceOf(CamofoxBrowserMcpAdapter);
  });

  it('returns CamofoxBrowserHttpAdapter for http-legacy transport', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (CamofoxBrowserHttpAdapter as unknown as { deprecationWarned: boolean }).deprecationWarned = false;
    const result = makeBrowserAdapter({
      projectName: 'test',
      surfaceMcpUrl: 'http://x',
      browserMcpUrl: 'http://127.0.0.1:3104/mcp',
      browserTransport: 'http-legacy',
    });
    expect(result).toBeInstanceOf(CamofoxBrowserHttpAdapter);
    warnSpy.mockRestore();
  });

  it('throws when mcp-stdio transport is used without browserMcpStdio config', () => {
    expect(() =>
      makeBrowserAdapter({
        projectName: 'test',
        surfaceMcpUrl: 'http://x',
        browserTransport: 'mcp-stdio',
      }),
    ).toThrow('browserMcpStdio.command');
  });

  it('returns CamofoxBrowserMcpAdapter for mcp-stdio with command', () => {
    const result = makeBrowserAdapter({
      projectName: 'test',
      surfaceMcpUrl: 'http://x',
      browserTransport: 'mcp-stdio',
      browserMcpStdio: { command: '/opt/camofox-mcp/dist/index.js' },
    });
    expect(result).toBeInstanceOf(CamofoxBrowserMcpAdapter);
  });
});
