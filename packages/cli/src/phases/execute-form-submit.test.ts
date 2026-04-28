// Tests for runFormSubmit helper and related utilities (v0.10 + v0.11).

import { describe, it, expect, vi } from 'vitest';
import { runFormSubmit, buildFillSubmitScript, isStringKeyedRecord } from './form-submit-runner.js';

function makeScope(value: unknown = { ok: true, via: 'button', missingFields: [] }) {
  return { evaluate: vi.fn().mockResolvedValue({ value }) };
}

describe('runFormSubmit (v0.10 single-evaluate path)', () => {
  it('zero fields → calls scope.evaluate exactly once, script contains formSelector', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', {});
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
    const script = scope.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('"#f"');
  });

  it('N fields → still calls scope.evaluate exactly once (no per-field calls)', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { username: 'u', password: 'p' });
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
  });

  it('never calls scope.type — FormSubmitScope has no type method', () => {
    const scope = makeScope();
    expect('type' in scope).toBe(false);
  });

  it('skips null and undefined values — they do not reach the page-side input map', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { a: null, b: undefined, c: 'val' });
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
    const script = scope.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('"c"');
    expect(script).toContain('"val"');
    expect(script).not.toContain('"a"');
    expect(script).not.toContain('"b"');
  });

  it('coerces non-string values via String(): { count: 7 } → page receives "7"', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { count: 7 });
    const script = scope.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('"7"');
  });

  it('field name with double-quote/backslash/unicode is preserved verbatim via JSON.stringify', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { 'a"b': 'v', 'x\\y': 'w', 'zé': 'q' });
    const script = scope.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('"a\\"b"');
    expect(script).toContain('"x\\\\y"');
    expect(script).toContain('"zé"');
  });

  it('throws "submit: form_not_found (formSelector=#missing)" when evaluate returns ok:false form_not_found', async () => {
    const scope = makeScope({ ok: false, reason: 'form_not_found' });
    await expect(runFormSubmit(scope, '#missing', {})).rejects.toThrow(
      'submit: form_not_found (formSelector=#missing)',
    );
  });

  it('throws "submit: file_field_unsettable (formSelector=#f) (field=avatar)" for file fields', async () => {
    const scope = makeScope({ ok: false, reason: 'file_field_unsettable', field: 'avatar' });
    await expect(runFormSubmit(scope, '#f', {})).rejects.toThrow(
      'submit: file_field_unsettable (formSelector=#f) (field=avatar)',
    );
  });

  it('throws "submit: submit_failed (formSelector=#f)" when evaluate returns submit_failed', async () => {
    const scope = makeScope({ ok: false, reason: 'submit_failed' });
    await expect(runFormSubmit(scope, '#f', {})).rejects.toThrow(
      'submit: submit_failed (formSelector=#f)',
    );
  });

  it('throws "submit: no_result (formSelector=#f)" when evaluate returns { value: undefined }', async () => {
    const scope = { evaluate: vi.fn().mockResolvedValue({ value: undefined }) };
    await expect(runFormSubmit(scope, '#f', {})).rejects.toThrow(
      'submit: no_result (formSelector=#f)',
    );
  });

  it('throws "submit: page_eval_threw: <msg>" when scope.evaluate rejects', async () => {
    const scope = { evaluate: vi.fn().mockRejectedValue(new Error('CSP violation')) };
    await expect(runFormSubmit(scope, '#f', {})).rejects.toThrow(
      'submit: page_eval_threw: Error: CSP violation',
    );
  });

  it('resolves silently when evaluate returns { ok: true, via: "button", missingFields: [] }', async () => {
    const scope = makeScope({ ok: true, via: 'button', missingFields: [] });
    await expect(runFormSubmit(scope, '#f', {})).resolves.toBeUndefined();
  });

  it('resolves (does NOT throw) when evaluate returns ok:true with non-empty missingFields', async () => {
    const scope = makeScope({ ok: true, via: 'requestSubmit', missingFields: ['stale_field'] });
    await expect(runFormSubmit(scope, '#f', {})).resolves.toBeUndefined();
  });
});

describe('buildFillSubmitScript', () => {
  it('JSON-stringifies the formSelector exactly once', () => {
    const script = buildFillSubmitScript('#my-form', {});
    expect(script).toContain('"#my-form"');
  });

  it('JSON-stringifies the input map exactly once', () => {
    const script = buildFillSubmitScript('#f', { user: 'alice' });
    expect(script).toContain('"user"');
    expect(script).toContain('"alice"');
  });

  it('output is a single self-invoking IIFE expression', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script.trimStart()).toMatch(/^\(\(\)/);
    expect(script.trimEnd()).toMatch(/\)\(\)$/);
  });

  it('output references querySelector(formSelector)', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain('document.querySelector(');
  });

  it('output references iteration over input keys', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain('Object.entries(inputMap)');
  });

  it('output references native value setter', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain('getOwnPropertyDescriptor');
    expect(script).toContain('.set.call(');
  });

  it('output references dispatchEvent input and change', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain("'input'");
    expect(script).toContain("'change'");
    expect(script).toContain('dispatchEvent');
  });

  it('output references submit-button resolution and requestSubmit fallback', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain('button[type="submit"]');
    expect(script).toContain('requestSubmit');
  });

  it('formSelector with embedded double-quote is JSON-encoded', () => {
    const script = buildFillSubmitScript('form[data-id="x"]', {});
    expect(script).toContain('"form[data-id=\\"x\\"]"');
  });

  it('input map with field name containing double-quote is JSON-encoded', () => {
    const script = buildFillSubmitScript('#f', { 'a"b': 'v' });
    expect(script).toContain('"a\\"b"');
  });

  it('output length is bounded under 4 KiB', () => {
    const script = buildFillSubmitScript('#f', { field1: 'value1', field2: 'value2' });
    expect(script.length).toBeLessThan(4096);
  });
});

describe('runFormSubmit v0.11 — bounded form-present wait', () => {
  it('resolves when evaluate returns success (form appeared within asyncMaxWaitMs)', async () => {
    const scope = { evaluate: vi.fn().mockResolvedValue({ value: { ok: true, via: 'button', missingFields: [] } }) };
    await expect(runFormSubmit(scope, 'form:nth-of-type(1)', {}, { asyncMaxWaitMs: 2000 })).resolves.toBeUndefined();
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
  });

  it('throws form_never_rendered when evaluate returns that reason', async () => {
    const scope = { evaluate: vi.fn().mockResolvedValue({ value: { ok: false, reason: 'form_never_rendered' } }) };
    await expect(runFormSubmit(scope, 'form:nth-of-type(1)', {}, { asyncMaxWaitMs: 2000 })).rejects.toThrow(
      'submit: form_never_rendered (formSelector=form:nth-of-type(1))',
    );
  });

  it('falls back to form_not_found when asyncMaxWaitMs <= 0 (legacy mode)', async () => {
    const scope = { evaluate: vi.fn().mockResolvedValue({ value: { ok: false, reason: 'form_not_found' } }) };
    await expect(runFormSubmit(scope, 'form:nth-of-type(1)', {}, { asyncMaxWaitMs: 0 })).rejects.toThrow(
      'submit: form_not_found (formSelector=form:nth-of-type(1))',
    );
  });
});

describe('buildFillSubmitScript v0.11 — asyncMaxWaitMs', () => {
  it('produces a polled IIFE with a deadline when asyncMaxWaitMs > 0', () => {
    const script = buildFillSubmitScript('#f', {}, 2000);
    expect(script).toContain('deadline');
    expect(script).toContain('2000');
    expect(script).toContain('form_never_rendered');
  });

  it('produces immediate IIFE with form_not_found when asyncMaxWaitMs <= 0', () => {
    const script = buildFillSubmitScript('#f', {}, 0);
    expect(script).toContain('form_not_found');
    expect(script).not.toContain('form_never_rendered');
  });

  it('default asyncMaxWaitMs is 2000 (polled path active)', () => {
    const script = buildFillSubmitScript('#f', {});
    expect(script).toContain('form_never_rendered');
  });
});

describe('isStringKeyedRecord', () => {
  it('returns true for a plain object', () => {
    expect(isStringKeyedRecord({ a: 1 })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isStringKeyedRecord(null)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isStringKeyedRecord([1, 2])).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isStringKeyedRecord('string')).toBe(false);
    expect(isStringKeyedRecord(42)).toBe(false);
    expect(isStringKeyedRecord(undefined)).toBe(false);
  });
});
