import { describe, it, expect } from 'vitest';
import { generatePaletteCases } from '../src/mutation/palette.js';
import type { FormField } from '../src/types.js';

const RUN_ID = 'test-run-123';

function field(type: FormField['type'], overrides: Partial<FormField> = {}): FormField {
  return { name: 'field', type, required: false, ...overrides };
}

describe('mutation palette', () => {
  it('text — null is empty string, edge is maxLength chars', () => {
    const cases = generatePaletteCases('text', RUN_ID, field('text', { maxLength: 10 }));
    const nullCase = cases.find(c => c.variant === 'null');
    const edgeCase = cases.find(c => c.variant === 'edge');
    expect(nullCase?.value).toBe('');
    expect(String(edgeCase?.value)).toHaveLength(10);
  });

  it('text — out_of_bounds exceeds maxLength and includes XSS', () => {
    const cases = generatePaletteCases('text', RUN_ID, field('text', { maxLength: 5 }));
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.some(c => String(c.value).length > 5)).toBe(true);
    expect(oob.some(c => String(c.value).includes('<script>'))).toBe(true);
  });

  it('email — happy uses bughunter+runId@test.local, out_of_bounds is not-an-email', () => {
    const cases = generatePaletteCases('email', RUN_ID, field('email'));
    const happy = cases.find(c => c.variant === 'happy');
    const oob = cases.find(c => c.variant === 'out_of_bounds');
    expect(happy?.value).toBe(`bughunter+${RUN_ID}@test.local`);
    expect(oob?.value).toBe('not-an-email');
  });

  it('number — null is undefined, out_of_bounds includes MAX_SAFE_INTEGER+1 and NaN', () => {
    const cases = generatePaletteCases('number', RUN_ID, field('number'));
    const nullCase = cases.find(c => c.variant === 'null');
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(nullCase?.value).toBeUndefined();
    expect(oob.some(c => c.value === Number.MAX_SAFE_INTEGER + 1)).toBe(true);
    expect(oob.some(c => Number.isNaN(c.value))).toBe(true);
  });

  it('date — null is null, edge includes 1900-01-01 and 2100-12-31', () => {
    const cases = generatePaletteCases('date', RUN_ID, field('date'));
    const nullCase = cases.find(c => c.variant === 'null');
    const edge = cases.filter(c => c.variant === 'edge');
    expect(nullCase?.value).toBeNull();
    expect(edge.some(c => c.value === '1900-01-01')).toBe(true);
    expect(edge.some(c => c.value === '2100-12-31')).toBe(true);
  });

  it('select — null is null, out_of_bounds is unlisted value', () => {
    const cases = generatePaletteCases('select', RUN_ID, field('select', { options: ['a', 'b', 'c'] }));
    const nullCase = cases.find(c => c.variant === 'null');
    const happy = cases.find(c => c.variant === 'happy');
    const edge = cases.find(c => c.variant === 'edge');
    const oob = cases.find(c => c.variant === 'out_of_bounds');
    expect(nullCase?.value).toBeNull();
    expect(happy?.value).toBe('a');
    expect(edge?.value).toBe('c');
    expect(oob?.value).toBe('__bughunter_unlisted_value__');
  });

  it('checkbox — null is false, happy is true', () => {
    const cases = generatePaletteCases('checkbox', RUN_ID, field('checkbox'));
    expect(cases.find(c => c.variant === 'null')?.value).toBe(false);
    expect(cases.find(c => c.variant === 'happy')?.value).toBe(true);
  });

  it('tel — happy is +15555550100, out_of_bounds has non-numeric', () => {
    const cases = generatePaletteCases('tel', RUN_ID, field('tel'));
    expect(cases.find(c => c.variant === 'happy')?.value).toBe('+15555550100');
    const oob = cases.find(c => c.variant === 'out_of_bounds');
    expect(typeof oob?.value).toBe('string');
    expect(String(oob?.value)).toMatch(/[^0-9+]/);
  });

  it('url — happy is https://test.local/x, out_of_bounds includes not-a-url', () => {
    const cases = generatePaletteCases('url', RUN_ID, field('url'));
    expect(cases.find(c => c.variant === 'happy')?.value).toBe('https://test.local/x');
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.some(c => c.value === 'not-a-url')).toBe(true);
  });

  it('password — null is empty, out_of_bounds is 10000 chars', () => {
    const cases = generatePaletteCases('password', RUN_ID, field('password', { minLength: 8 }));
    expect(cases.find(c => c.variant === 'null')?.value).toBe('');
    const oob = cases.find(c => c.variant === 'out_of_bounds');
    expect(String(oob?.value)).toHaveLength(10_000);
  });

  it('color — happy is #000000, edge is #ffffff, out_of_bounds includes invalid', () => {
    const cases = generatePaletteCases('color', RUN_ID, field('color'));
    expect(cases.find(c => c.variant === 'happy')?.value).toBe('#000000');
    expect(cases.find(c => c.variant === 'edge')?.value).toBe('#ffffff');
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.some(c => c.value === 'red')).toBe(true);
  });

  it('range — null is min, happy is midpoint, out_of_bounds exceeds max', () => {
    const cases = generatePaletteCases('range', RUN_ID, field('range', { min: 0, max: 100 }));
    expect(cases.find(c => c.variant === 'null')?.value).toBe(0);
    expect(cases.find(c => c.variant === 'happy')?.value).toBe(50);
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.some(c => c.value === 101)).toBe(true);
    expect(oob.some(c => c.value === -1)).toBe(true);
  });

  it('slug — null is empty, out_of_bounds includes spaces', () => {
    const cases = generatePaletteCases('slug', RUN_ID, field('slug'), undefined, { slug: ['my-product'] });
    expect(cases.find(c => c.variant === 'null')?.value).toBe('');
    expect(cases.find(c => c.variant === 'happy')?.value).toBe('my-product');
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.some(c => String(c.value).includes(' '))).toBe(true);
  });

  it('foreign_id — null is null, happy from domainHints, out_of_bounds is wrong type', () => {
    const cases = generatePaletteCases('foreign_id', RUN_ID, field('foreign_id'), undefined, { foreign_id: ['123'] });
    expect(cases.find(c => c.variant === 'null')?.value).toBeNull();
    expect(cases.find(c => c.variant === 'happy')?.value).toBe('123');
    const oob = cases.filter(c => c.variant === 'out_of_bounds');
    expect(oob.length).toBeGreaterThan(0);
  });

  it('boolean — null is null, happy is true', () => {
    const cases = generatePaletteCases('boolean', RUN_ID, field('boolean'));
    expect(cases.find(c => c.variant === 'null')?.value).toBeNull();
    expect(cases.find(c => c.variant === 'happy')?.value).toBe(true);
  });

  it('array — null is empty array, out_of_bounds has non-existent items', () => {
    const cases = generatePaletteCases('array', RUN_ID, field('array'));
    expect(Array.isArray(cases.find(c => c.variant === 'null')?.value)).toBe(true);
    expect((cases.find(c => c.variant === 'null')?.value as unknown[]).length).toBe(0);
    const oob = cases.find(c => c.variant === 'out_of_bounds');
    expect(Array.isArray(oob?.value)).toBe(true);
  });
});
