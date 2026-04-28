// Tests for runFormSubmit helper and related utilities (v0.9 T3).

import { describe, it, expect, vi } from 'vitest';
import { runFormSubmit, buildSubmitScript, isStringKeyedRecord } from './form-submit-runner.js';

function makeScope(evaluateResult: { value: unknown } = { value: { ok: true, via: 'button' } }) {
  return {
    type: vi.fn().mockResolvedValue({ typed: true }),
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  };
}

describe('runFormSubmit', () => {
  it('calls scope.type for each non-null field in order', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { username: 'u', password: 'p' });
    expect(scope.type).toHaveBeenCalledTimes(2);
    expect(scope.type).toHaveBeenNthCalledWith(1, '#f [name="username"]', 'u');
    expect(scope.type).toHaveBeenNthCalledWith(2, '#f [name="password"]', 'p');
  });

  it('calls scope.evaluate with a script containing the formSelector', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', {});
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
    const script = scope.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('"#f"');
  });

  it('zero fields → zero type calls, one evaluate call', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', {});
    expect(scope.type).not.toHaveBeenCalled();
    expect(scope.evaluate).toHaveBeenCalledTimes(1);
  });

  it('skips null and undefined values', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { a: null, b: undefined, c: 'val' });
    expect(scope.type).toHaveBeenCalledTimes(1);
    expect(scope.type).toHaveBeenCalledWith('#f [name="c"]', 'val');
  });

  it('field name with double-quote is escaped in selector', async () => {
    const scope = makeScope();
    await runFormSubmit(scope, '#f', { 'field"weird': 'v' });
    expect(scope.type).toHaveBeenCalledWith('#f [name="field\\"weird"]', 'v');
  });

  it('throws when evaluate returns ok:false', async () => {
    const scope = makeScope({ value: { ok: false, reason: 'form_not_found' } });
    await expect(runFormSubmit(scope, '#missing', {})).rejects.toThrow('submit: form_not_found');
  });

  it('does not throw when evaluate returns ok:true via requestSubmit', async () => {
    const scope = makeScope({ value: { ok: true, via: 'requestSubmit' } });
    await expect(runFormSubmit(scope, '#f', {})).resolves.toBeUndefined();
  });

  it('throws with unknown reason when evaluate returns ok:false with no reason', async () => {
    const scope = makeScope({ value: { ok: false } });
    await expect(runFormSubmit(scope, '#f', {})).rejects.toThrow('submit: unknown');
  });
});

describe('buildSubmitScript', () => {
  it('includes the formSelector as a JSON-stringified value', () => {
    const script = buildSubmitScript('#my-form');
    expect(script).toContain('"#my-form"');
  });

  it('escapes formSelector with special chars', () => {
    const script = buildSubmitScript('form[data-id="x"]');
    // JSON.stringify wraps in quotes and escapes inner quotes
    expect(script).toContain('"form[data-id=\\"x\\"]"');
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
