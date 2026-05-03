import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CamofoxBrowserMcpAdapter } from '../src/adapters/browser-mcp.js';
import { BrowserMcpError } from '../src/adapters/browser-mcp-error.js';

const SIMPLE_SNAPSHOT = `
- generic [e1]:
  - button "Submit" [ref=e2]
  - textbox "Email" [ref=e3]
`;

type FetchCall = { name: string; arguments: Record<string, unknown> };

/**
 * A fetch mock that dispatches based on tool name.
 * handlers: map of tool name → response payload
 * Unmatched tool names fall back to defaultPayload.
 */
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

describe('CamofoxBrowserMcpAdapter — tab tracking (§3.6)', () => {
  it('stores tabId from navigate and reuses on subsequent calls', async () => {
    // v0.12: string-selector click uses evaluate (not snapshot+click)
    const clickResult = { ok: true, accessibleNameAbsent: false, ariaLabelSource: 'text', tagName: 'button', role: null };
    const { calls } = mockDispatch({
      navigate: { tabId: 'tab-abc', ok: true, finalUrl: 'http://x' },
      evaluate: { tabId: 'tab-abc', result: clickResult },
    });

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    await adapter.click('button');

    const evalCall = calls.find(c => c.name === 'evaluate');
    expect(evalCall?.arguments?.['tabId']).toBe('tab-abc');
  });

  it('throws no_tab if click is called before navigate', async () => {
    mockDispatch({});
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await expect(adapter.click('button')).rejects.toMatchObject({ kind: 'no_tab' });
  });

  it('closeTab clears currentTabId when it matches', async () => {
    const { calls } = mockDispatch({
      navigate: { tabId: 'tab-xyz', ok: true, finalUrl: 'http://x' },
      close_tab: { ok: true },
      snapshot: { tabId: 'tab-xyz', snapshot: SIMPLE_SNAPSHOT },
    });

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    await adapter.closeTab('tab-xyz');

    // Now click should throw no_tab
    await expect(adapter.click('button')).rejects.toMatchObject({ kind: 'no_tab' });
  });

  it('closeTab does NOT clear currentTabId when it does not match', async () => {
    // v0.12: string-selector click uses evaluate (not snapshot+click)
    const clickResult = { ok: true, accessibleNameAbsent: false, ariaLabelSource: 'text', tagName: 'button', role: null };
    mockDispatch({
      navigate: { tabId: 'tab-1', ok: true, finalUrl: 'http://x' },
      close_tab: { ok: true },
      evaluate: { tabId: 'tab-1', result: clickResult },
    });

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    await adapter.closeTab('tab-2'); // different tabId
    // Should not throw — currentTabId is still tab-1
    await expect(adapter.click('button')).resolves.toMatchObject({ clicked: true });
  });
});

describe('CamofoxBrowserMcpAdapter — screenshot path materialisation (§3.8)', () => {
  it('without outputPath returns {path:"", data:<base64>}', async () => {
    const base64 = 'iVBORw0KGgo=';
    mockDispatch({
      navigate: { tabId: 't1', ok: true, finalUrl: 'http://x' },
      screenshot: { dataUrl: `data:image/png;base64,${base64}` },
    });
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    const result = await adapter.screenshot();
    expect(result.path).toBe('');
    expect(result.data).toContain(base64);
  });

  it('with outputPath writes file and returns {path, data}', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const base64 = pngBytes.toString('base64');
    mockDispatch({
      navigate: { tabId: 't1', ok: true, finalUrl: 'http://x' },
      screenshot: { dataUrl: `data:image/png;base64,${base64}` },
    });

    const tmpFile = path.join(os.tmpdir(), `bh-screenshot-test-${Date.now()}.png`);
    try {
      const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
      await adapter.navigate('http://x');
      const result = await adapter.screenshot(tmpFile);
      expect(result.path).toBe(tmpFile);
      expect(fs.existsSync(tmpFile)).toBe(true);
      const written = fs.readFileSync(tmpFile);
      expect(written.equals(pngBytes)).toBe(true);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});

describe('CamofoxBrowserMcpAdapter — error mapping (§3.9)', () => {
  it('HTTP non-ok response → transport error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Internal Error', { status: 500, headers: { 'content-type': 'text/plain' } })
    ));
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    const err = await adapter.listTabs().catch(e => e);
    expect(err).toBeInstanceOf(BrowserMcpError);
    expect((err as BrowserMcpError).kind).toBe('transport');
  });

  it('JSON-RPC error envelope with timeout → timeout error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: 'Operation timeout exceeded' } }),
        { headers: { 'content-type': 'application/json' } }
      )
    ));
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    const err = await adapter.listTabs().catch(e => e);
    expect(err).toBeInstanceOf(BrowserMcpError);
    expect((err as BrowserMcpError).kind).toBe('timeout');
  });

  it('JSON-RPC error envelope with not found message → element_not_found', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // navigate
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: 't1', ok: true, finalUrl: 'http://x' }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      // snapshot or click — return error
      return new Response(
        JSON.stringify({ error: { message: 'Element not found in tree' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }));
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    const err = await adapter.click('button').catch(e => e);
    expect(err).toBeInstanceOf(BrowserMcpError);
  });
});

describe('evaluate timeout propagation to MCP callTool (#169)', () => {
  it('passes timeout to tool() when evaluate is called with { timeout: 120000 }', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({ mode: 'http', url: 'http://127.0.0.1:3104/mcp' });

    // Intercept tool() to: (a) set currentTabId on navigate, (b) capture timeout on evaluate.
    const capturedTimeouts: Array<number | undefined> = [];
    vi.spyOn(adapter, 'tool').mockImplementation(async (name, _args, _expect, timeout) => {
      if (name === 'navigate') return { tabId: 't1', ok: true, finalUrl: 'http://x' } as never;
      capturedTimeouts.push(timeout);
      return { tabId: 't1', result: 'ok', value: 'ok' } as never;
    });

    await adapter.navigate('http://x');
    await adapter.evaluate('(function(){return true;})()', { timeout: 120_000 });

    expect(capturedTimeouts[0]).toBe(120_000);
  });

  it('passes undefined timeout to tool() when evaluate is called without options', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({ mode: 'http', url: 'http://127.0.0.1:3104/mcp' });

    const capturedTimeouts: Array<number | undefined> = [];
    vi.spyOn(adapter, 'tool').mockImplementation(async (name, _args, _expect, timeout) => {
      if (name === 'navigate') return { tabId: 't1', ok: true, finalUrl: 'http://x' } as never;
      capturedTimeouts.push(timeout);
      return { tabId: 't1', result: 'ok', value: 'ok' } as never;
    });

    await adapter.navigate('http://x');
    await adapter.evaluate('(function(){return true;})()');

    expect(capturedTimeouts[0]).toBeUndefined();
  });
});

describe('CamofoxBrowserMcpAdapter — retry on element_not_found (§3.7)', () => {
  it('retries once after element_not_found on structured selector and succeeds on second snapshot', async () => {
    // v0.12: retry only applies to structured selectors (snapshot path).
    // String selectors use evaluate — no retry.
    let snapshotCount = 0;
    let clickCount = 0;

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { params?: { name?: string } };
      const name = body.params?.name;

      if (name === 'navigate') {
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: 't1', ok: true, finalUrl: 'http://x' }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }

      if (name === 'snapshot') {
        snapshotCount++;
        // First snapshot: has no matching ref for role=button
        // Second snapshot (after retry): has the button
        const snap = snapshotCount === 1
          ? '- generic [e1]:'
          : SIMPLE_SNAPSHOT;
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: 't1', snapshot: snap }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }

      if (name === 'click') {
        clickCount++;
        return new Response(
          JSON.stringify({ result: { content: [{ text: JSON.stringify({ tabId: 't1', ok: true }) }] } }),
          { headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }));

    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    await adapter.navigate('http://x');
    // Use structured selector (snapshot path) to test retry
    const result = await adapter.click({ role: 'button', name: 'Submit' });
    expect(result.clicked).toBe(true);
    expect(clickCount).toBe(1);
    // At least 2 snapshot calls (initial + retry)
    expect(snapshotCount).toBeGreaterThanOrEqual(2);
  });
});
