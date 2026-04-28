// Unit tests for click-runner.ts (v0.12).
// All tests stub scope.evaluate — no real browser needed.

import { describe, it, expect, vi } from 'vitest';
import { runEvaluateClick, buildClickScript } from './click-runner.js';
import { BrowserMcpError } from '../adapters/browser-mcp-error.js';

function makeScope(value: unknown) {
  return { evaluate: vi.fn().mockResolvedValue({ value }) };
}

describe('runEvaluateClick — host-side result handling', () => {
  it('returns ok:true result with accessibleNameAbsent:false when element has aria-label', async () => {
    const scope = makeScope({ ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-label', tagName: 'button', role: null });
    const result = await runEvaluateClick(scope, 'button[aria-label="Open"]');
    expect(result).toEqual({ ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-label', tagName: 'button', role: null });
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns ok:true with accessibleNameAbsent:true for icon-only button', async () => {
    const scope = makeScope({ ok: true, accessibleNameAbsent: true, ariaLabelSource: null, tagName: 'button', role: null });
    const result = await runEvaluateClick(scope, 'button:nth-of-type(3)');
    expect(result.ok).toBe(true);
    expect(result.accessibleNameAbsent).toBe(true);
    expect(result.ariaLabelSource).toBeNull();
  });

  it('throws BrowserMcpError(element_not_found) when element_not_in_dom', async () => {
    const scope = makeScope({ ok: false, reason: 'element_not_in_dom' });
    await expect(runEvaluateClick(scope, '#missing')).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.kind === 'element_not_found' && e.selector === '#missing',
    );
  });

  it('throws BrowserMcpError(element_not_found) when element_not_visible', async () => {
    const scope = makeScope({ ok: false, reason: 'element_not_visible' });
    await expect(runEvaluateClick(scope, '.hidden-btn')).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.kind === 'element_not_found',
    );
  });

  it('throws BrowserMcpError(evaluate_failed) when scope.evaluate rejects', async () => {
    const scope = { evaluate: vi.fn().mockRejectedValue(new Error('transport error')) };
    await expect(runEvaluateClick(scope, 'button')).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.kind === 'evaluate_failed',
    );
  });

  it('throws BrowserMcpError(evaluate_failed) when evaluate returns { value: undefined }', async () => {
    const scope = { evaluate: vi.fn().mockResolvedValue({ value: undefined }) };
    await expect(runEvaluateClick(scope, 'button')).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.kind === 'evaluate_failed' && e.message.includes('no_result'),
    );
  });

  it('throws BrowserMcpError(evaluate_failed) when page_eval_threw reason returned', async () => {
    const scope = makeScope({ ok: false, reason: 'page_eval_threw' });
    await expect(runEvaluateClick(scope, 'button')).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.kind === 'evaluate_failed',
    );
  });

  it('preserves selector with embedded quotes and backslashes in the error', async () => {
    const scope = makeScope({ ok: false, reason: 'element_not_in_dom' });
    const sel = 'button[data-id="x\\y"]';
    await expect(runEvaluateClick(scope, sel)).rejects.toSatisfy(
      (e: unknown) => e instanceof BrowserMcpError && e.selector === sel,
    );
  });
});

describe('buildClickScript — IIFE structure', () => {
  it('JSON-stringifies the selector exactly once in the script', () => {
    const script = buildClickScript('button.primary');
    expect(script).toContain('"button.primary"');
  });

  it('output is a self-invoking IIFE (starts with (function and ends with })()', () => {
    const script = buildClickScript('a');
    expect(script.trimStart()).toMatch(/^\(function\(\)/);
    expect(script.trimEnd()).toMatch(/\}\)\(\)$/);
  });

  it('output references all accessible-name sources', () => {
    const script = buildClickScript('button');
    expect(script).toContain('aria-labelledby');
    expect(script).toContain('aria-label');
    expect(script).toContain('title');
    expect(script).toContain('label[for=');
    expect(script).toContain('textContent');
  });

  it('output dispatches MouseEvent with the correct options', () => {
    const script = buildClickScript('button');
    expect(script).toContain("new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0})");
  });

  it('selector with double-quote is JSON-encoded in the script', () => {
    const script = buildClickScript('button[data-id="x"]');
    expect(script).toContain('"button[data-id=\\"x\\"]"');
  });

  it('selector with backslash is preserved via JSON.stringify', () => {
    const script = buildClickScript('a\\b');
    expect(script).toContain(JSON.stringify('a\\b'));
  });

  it('selector with single quote is preserved via JSON.stringify', () => {
    const script = buildClickScript("button[title='ok']");
    expect(script).toContain(JSON.stringify("button[title='ok']"));
  });

  it('output is under 4 KiB', () => {
    const script = buildClickScript('button');
    expect(script.length).toBeLessThan(4096);
  });
});
