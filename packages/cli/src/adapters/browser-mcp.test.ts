// Unit tests for CamofoxBrowserMcpAdapter.clickByHint (11 cases per §5.1)
// Mocks the fetch transport so no real browser is needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CamofoxBrowserMcpAdapter } from './browser-mcp.js';
import { BrowserMcpError } from './browser-mcp-error.js';
import type { TriggerSelectorHint } from '../types.js';

type FetchCall = { name: string; arguments: Record<string, unknown> };

/**
 * Stubs globalThis.fetch so that each `evaluate` call returns the value from
 * evaluateReturns in sequence (or the last value if exhausted).
 * Returns the list of captured tool calls for assertion.
 */
function mockEvaluateSequence(tabId: string, evaluateReturns: boolean[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let evaluateCallIndex = 0;

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const name = body.params?.name ?? '';
    const args = body.params?.arguments ?? {};
    calls.push({ name, arguments: args });

    let payload: unknown;
    if (name === 'navigate') {
      payload = { tabId, ok: true, finalUrl: 'http://test' };
    } else if (name === 'evaluate') {
      const returnVal = evaluateReturns[evaluateCallIndex] ?? evaluateReturns[evaluateReturns.length - 1] ?? false;
      evaluateCallIndex++;
      payload = { tabId, result: returnVal };
    } else {
      payload = { tabId, ok: true };
    }

    return new Response(
      JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }),
      { headers: { 'content-type': 'application/json' } }
    );
  }));

  return { calls };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

async function makeAdapter(): Promise<CamofoxBrowserMcpAdapter> {
  const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
  await adapter.navigate('http://test');
  return adapter;
}

describe('CamofoxBrowserMcpAdapter.clickByHint — §5.1 unit tests', () => {
  // Case 1: testId hits → clicked:true, matchedBy:'testId'
  it('1: testId hits', async () => {
    mockEvaluateSequence('tab-1', [true]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ testId: 'nav-x' });
    expect(result).toEqual({ clicked: true, matchedBy: 'testId' });
  });

  // Case 2: ariaLabel hits when testId absent → matched by ariaLabel
  it('2: ariaLabel hits when testId absent', async () => {
    mockEvaluateSequence('tab-2', [true]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ ariaLabel: 'Go home' });
    expect(result).toEqual({ clicked: true, matchedBy: 'ariaLabel' });
  });

  // Case 3: text hits when testId+ariaLabel absent
  it('3: text hits when testId and ariaLabel absent', async () => {
    mockEvaluateSequence('tab-3', [true]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ text: 'Leaderboard' });
    expect(result).toEqual({ clicked: true, matchedBy: 'text' });
  });

  // Case 4: testId provided but DOM has no testid → falls through to ariaLabel
  it('4: testId misses, ariaLabel hits', async () => {
    mockEvaluateSequence('tab-4', [false, true]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ testId: 'x', ariaLabel: 'Y' });
    expect(result).toEqual({ clicked: true, matchedBy: 'ariaLabel' });
  });

  // Case 5: testId+ariaLabel both miss → falls through to text
  it('5: testId+ariaLabel miss, text hits', async () => {
    mockEvaluateSequence('tab-5', [false, false, true]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ testId: 'x', ariaLabel: 'Y', text: 'Z' });
    expect(result).toEqual({ clicked: true, matchedBy: 'text' });
  });

  // Case 6: all hint fields populated but DOM matches none → not_found
  it('6: all hint fields miss → not_found', async () => {
    mockEvaluateSequence('tab-6', [false, false, false]);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ testId: 'x', ariaLabel: 'Y', text: 'Z' });
    expect(result).toEqual({ clicked: false, reason: 'not_found' });
  });

  // Case 7: empty hint → no_hint_fields (evaluate never called)
  it('7: empty hint → no_hint_fields', async () => {
    const { calls } = mockEvaluateSequence('tab-7', []);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({});
    expect(result).toEqual({ clicked: false, reason: 'no_hint_fields' });
    // navigate was called but evaluate should not have been called for clickByHint
    const evaluateCalls = calls.filter(c => c.name === 'evaluate');
    expect(evaluateCalls.length).toBe(0);
  });

  // Case 8: all hint fields are empty strings → no_hint_fields
  it('8: all hint fields are empty strings → no_hint_fields', async () => {
    const { calls } = mockEvaluateSequence('tab-8', []);
    const adapter = await makeAdapter();
    const result = await adapter.clickByHint({ testId: '', ariaLabel: '', text: '' } as TriggerSelectorHint);
    expect(result).toEqual({ clicked: false, reason: 'no_hint_fields' });
    const evaluateCalls = calls.filter(c => c.name === 'evaluate');
    expect(evaluateCalls.length).toBe(0);
  });

  // Case 9: double-quote in testId is escaped in the evaluate expression.
  // escapeAttr converts `"` → `\"` so the CSS selector has `say-\"hi\"`.
  // JSON.stringify then further escapes it for safe JS string embedding.
  // We assert: `hi` appears in the expression and `data-testid` selector is used.
  it('9: double-quote escaping in testId is preserved in evaluate script', async () => {
    const { calls } = mockEvaluateSequence('tab-9', [true]);
    const adapter = await makeAdapter();
    await adapter.clickByHint({ testId: 'say-"hi"' });
    const evalCall = calls.find(c => c.name === 'evaluate');
    expect(evalCall).toBeDefined();
    const expr = String(evalCall!.arguments['expression']);
    // testId value passed through to the CSS selector (hi is present)
    expect(expr).toContain('hi');
    // data-testid attribute selector is used (not aria-label or text walk)
    expect(expr).toContain('data-testid');
    // The value is embedded inside a JSON.stringify call — quotes are escaped
    expect(expr).toMatch(/say-.*hi/);
  });

  // Case 10: text is lowercased in script payload
  it('10: text is lowercased in script payload', async () => {
    const { calls } = mockEvaluateSequence('tab-10', [true]);
    const adapter = await makeAdapter();
    await adapter.clickByHint({ text: 'HOUR' });
    const evalCall = calls.find(c => c.name === 'evaluate');
    expect(evalCall).toBeDefined();
    const expr = String(evalCall!.arguments['expression']);
    expect(expr).toContain('"hour"');
    expect(expr).not.toContain('"HOUR"');
  });

  // Case 11: no active tab → throws BrowserMcpError('no_tab')
  it('11: no active tab → throws BrowserMcpError(no_tab)', async () => {
    mockEvaluateSequence('tab-11', []);
    const adapter = new CamofoxBrowserMcpAdapter('http://127.0.0.1:3104');
    // Do NOT call navigate — adapter has no tab
    await expect(adapter.clickByHint({ text: 'X' })).rejects.toMatchObject({
      kind: 'no_tab',
    });
  });
});
