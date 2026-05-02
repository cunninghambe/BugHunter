// Unit tests for dataIntegrity/template.ts

import { describe, it, expect } from 'vitest';
import { resolveTemplate, resolveValue } from '../template.js';

describe('resolveTemplate — literal passthrough', () => {
  it('returns string with no placeholders unchanged', () => {
    expect(resolveTemplate('hello world', {})).toBe('hello world');
  });

  it('returns empty string unchanged', () => {
    expect(resolveTemplate('', {})).toBe('');
  });
});

describe('resolveTemplate — extract substitution', () => {
  it('substitutes {{key}} from extract context', () => {
    const ctx = { extract: { userId: '42' } };
    expect(resolveTemplate('user/{{userId}}/profile', ctx)).toBe('user/42/profile');
  });

  it('substitutes multiple placeholders', () => {
    const ctx = { extract: { a: 'foo', b: 'bar' } };
    expect(resolveTemplate('{{a}}-{{b}}', ctx)).toBe('foo-bar');
  });

  it('substitutes same placeholder used twice', () => {
    const ctx = { extract: { id: '7' } };
    expect(resolveTemplate('{{id}} and {{id}}', ctx)).toBe('7 and 7');
  });
});

describe('resolveTemplate — beforeStore substitution', () => {
  it('resolves before.key prefix from beforeStore', () => {
    const ctx = { beforeStore: { count: 3 } };
    expect(resolveTemplate('count={{before.count}}', ctx)).toBe('count=3');
  });

  it('extract takes priority over same key name', () => {
    // extract uses bare keys, beforeStore uses before.* prefix — they do not collide
    const ctx = { extract: { x: 'extract' } };
    expect(resolveTemplate('{{x}}', ctx)).toBe('extract');
  });
});

describe('resolveTemplate — runtime substitution', () => {
  it('falls back to runtime when not in extract or beforeStore', () => {
    const ctx = { runtime: { actionId: 'create-user' } };
    expect(resolveTemplate('action={{actionId}}', ctx)).toBe('action=create-user');
  });

  it('runtime is lowest priority', () => {
    const ctx = {
      extract: { k: 'e' },
      beforeStore: { k: 'b' },
      runtime: { k: 'r' },
    };
    expect(resolveTemplate('{{k}}', ctx)).toBe('e');
  });
});

describe('resolveTemplate — arithmetic', () => {
  it('adds two numbers', () => {
    const ctx = { extract: { n: '10' } };
    expect(resolveTemplate('{{n + 5}}', ctx)).toBe('15');
  });

  it('subtracts', () => {
    const ctx = { extract: { n: '10' } };
    expect(resolveTemplate('{{n - 3}}', ctx)).toBe('7');
  });

  it('multiplies', () => {
    const ctx = { extract: { n: '4' } };
    expect(resolveTemplate('{{n * 3}}', ctx)).toBe('12');
  });

  it('divides', () => {
    const ctx = { extract: { n: '9' } };
    expect(resolveTemplate('{{n / 3}}', ctx)).toBe('3');
  });

  it('handles float result', () => {
    const ctx = { extract: { n: '1' } };
    const result = resolveTemplate('{{n / 3}}', ctx);
    expect(parseFloat(result)).toBeCloseTo(1 / 3, 5);
  });

  it('throws when operand is non-numeric', () => {
    const ctx = { extract: { n: 'abc' } };
    // 'abc' is not numeric, so arithmetic fails → falls back to key lookup, which also fails
    expect(() => resolveTemplate('{{n + 1}}', ctx)).toThrow('invariant_template_invalid');
  });
});

describe('resolveTemplate — missing key', () => {
  it('throws on missing key', () => {
    expect(() => resolveTemplate('{{missing}}', {})).toThrow();
  });
});

describe('resolveValue', () => {
  it('returns non-string values unchanged', () => {
    expect(resolveValue(42, {})).toBe(42);
    expect(resolveValue(true, {})).toBe(true);
    expect(resolveValue(null, {})).toBeNull();
  });

  it('resolves template in string values', () => {
    const ctx = { extract: { id: '5' } };
    expect(resolveValue('item-{{id}}', ctx)).toBe('item-5');
  });

  it('returns object values without template unchanged', () => {
    const ctx = { extract: { x: '1' } };
    const obj = { key: 'no-template', num: 99 };
    expect(resolveValue(obj, ctx)).toBe(obj);
  });

  it('returns array unchanged', () => {
    const ctx = { extract: { n: '9' } };
    const arr = ['{{n}}', 42];
    expect(resolveValue(arr, ctx)).toBe(arr);
  });
});
