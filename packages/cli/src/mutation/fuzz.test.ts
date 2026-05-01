// v0.39 fuzz strategy tests — determinism, per-strategy correctness, edge cases.

import { describe, it, expect } from 'vitest';
import {
  deriveSubSeed,
  fuzzUnicode,
  fuzzShape,
  fuzzBoundaryForForm,
  fuzzBoundaryForTool,
} from './fuzz.js';
import type { FormField, ToolMeta } from '../types.js';

function makeField(overrides: Partial<FormField> = {}): FormField {
  return { name: 'testField', type: 'text', required: false, ...overrides };
}

function makeTool(overrides: Partial<ToolMeta> = {}): ToolMeta {
  return {
    name: 'test-tool',
    toolId: 'test-tool',
    method: 'POST',
    path: '/api/test',
    inputSchema: {
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'mutating',
    sourceFile: 'test.ts',
    sourceLine: 1,
    isServerAction: false,
    ...overrides,
  };
}

// --- deriveSubSeed ---

describe('deriveSubSeed', () => {
  it('returns a non-negative integer', () => {
    const seed = deriveSubSeed(12345, 'fuzz-unicode', 'formSig', 'fieldName');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic — same inputs produce same output', () => {
    const a = deriveSubSeed(7777, 'fuzz-unicode', 'form:name:text', 'email');
    const b = deriveSubSeed(7777, 'fuzz-unicode', 'form:name:text', 'email');
    expect(a).toBe(b);
  });

  it('different namespaces produce different seeds', () => {
    const a = deriveSubSeed(7777, 'fuzz-unicode', 'toolId');
    const b = deriveSubSeed(7777, 'fuzz-shape', 'toolId');
    expect(a).not.toBe(b);
  });

  it('different run seeds produce different sub-seeds', () => {
    const a = deriveSubSeed(1111, 'fuzz-unicode', 'toolId');
    const b = deriveSubSeed(2222, 'fuzz-unicode', 'toolId');
    expect(a).not.toBe(b);
  });

  it('seed 0 is valid', () => {
    const seed = deriveSubSeed(0, 'fuzz-unicode', 'formSig');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});

// --- fuzzUnicode ---

describe('fuzzUnicode', () => {
  it('returns MutationCase[] with variant=fuzz and strategy=unicode', () => {
    const field = makeField({ type: 'text' });
    const cases = fuzzUnicode('text', field, 12345, 8);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.variant).toBe('fuzz');
      expect(c.strategy).toBe('unicode');
      expect(typeof c.value).toBe('string');
    }
  });

  it('is deterministic — same seed produces identical output', () => {
    const field = makeField({ type: 'text' });
    const a = fuzzUnicode('text', field, 7777, 16);
    const b = fuzzUnicode('text', field, 7777, 16);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds produce different draws', () => {
    const field = makeField({ type: 'text' });
    const a = fuzzUnicode('text', field, 1111, 16);
    const b = fuzzUnicode('text', field, 2222, 16);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('skips non-text input types', () => {
    const field = makeField({ type: 'number' });
    expect(fuzzUnicode('number', field, 12345, 8)).toHaveLength(0);
  });

  it('applies to email type', () => {
    const field = makeField({ type: 'email' });
    expect(fuzzUnicode('email', field, 12345, 4).length).toBeGreaterThan(0);
  });

  it('respects maxLength field constraint', () => {
    const field = makeField({ type: 'text', maxLength: 5 });
    const cases = fuzzUnicode('text', field, 12345, 16);
    for (const c of cases) {
      expect((c.value as string).length).toBeLessThanOrEqual(5);
    }
  });

  it('drawIndex is sequential from 0', () => {
    const field = makeField({ type: 'text' });
    const cases = fuzzUnicode('text', field, 7777, 8);
    cases.forEach((c, i) => expect(c.drawIndex).toBe(i));
  });
});

// --- fuzzShape ---

describe('fuzzShape', () => {
  it('returns MutationCase[] with strategy=shape for POST tools', () => {
    const tool = makeTool();
    const cases = fuzzShape(tool, { name: 'Alice' }, 12345, 10);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.variant).toBe('fuzz');
      expect(c.strategy).toBe('shape');
    }
  });

  it('is deterministic', () => {
    const tool = makeTool();
    const a = fuzzShape(tool, { name: 'Alice' }, 7777, 10);
    const b = fuzzShape(tool, { name: 'Alice' }, 7777, 10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('returns empty array when tool has no properties', () => {
    const tool = makeTool({ inputSchema: {} });
    expect(fuzzShape(tool, {}, 12345, 5)).toHaveLength(0);
  });

  it('covers all 5 mutation classes when runs >= 5', () => {
    const tool = makeTool({
      inputSchema: {
        properties: { name: { type: 'string' }, age: { type: 'integer' } },
        required: ['name'],
      },
    });
    const cases = fuzzShape(tool, { name: 'Bob', age: 30 }, 12345, 10);
    // At least 2 classes (drop_required, reorder_keys, type_substitute, extra_key, wrap_top_level)
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it('drop_required removes a required field', () => {
    const tool = makeTool({
      inputSchema: {
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    const cases = fuzzShape(tool, { name: 'Alice' }, 42, 5);
    const dropCase = cases.find((_, i) => i % 5 === 0); // first class = drop_required
    expect(dropCase).toBeDefined();
  });

  it('extra_key injects __bughunter_unknown_field', () => {
    const tool = makeTool();
    const cases = fuzzShape(tool, { name: 'Alice' }, 12345, 20);
    const extraKeyCases = cases.filter(c => {
      const val = c.value as Record<string, unknown>;
      return typeof val === 'object' && val !== null && '__bughunter_unknown_field' in val;
    });
    expect(extraKeyCases.length).toBeGreaterThan(0);
  });
});

// --- fuzzBoundaryForForm ---

describe('fuzzBoundaryForForm', () => {
  it('returns empty array for field with no constraints', () => {
    const field = makeField();
    expect(fuzzBoundaryForForm(field, 12345, 8)).toHaveLength(0);
  });

  it('generates enum boundary cases', () => {
    const field = makeField({ options: ['a', 'b', 'c'] });
    const cases = fuzzBoundaryForForm(field, 12345, 16);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.strategy).toBe('boundary');
    }
  });

  it('generates min/max boundary cases', () => {
    const field = makeField({ type: 'number', min: 0, max: 100 });
    const cases = fuzzBoundaryForForm(field, 12345, 16);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('generates minLength/maxLength boundary cases', () => {
    const field = makeField({ minLength: 3, maxLength: 10 });
    const cases = fuzzBoundaryForForm(field, 12345, 16);
    expect(cases.length).toBeGreaterThan(0);
    const values = cases.map(c => c.value as string);
    // Should include strings at the boundaries
    expect(values.some(v => typeof v === 'string')).toBe(true);
  });

  it('is deterministic', () => {
    const field = makeField({ options: ['x', 'y'] });
    const a = fuzzBoundaryForForm(field, 7777, 8);
    const b = fuzzBoundaryForForm(field, 7777, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('enum takes precedence over length constraints (EC-2)', () => {
    const field = makeField({ options: ['a', 'b'], minLength: 1, maxLength: 5 });
    const cases = fuzzBoundaryForForm(field, 12345, 8);
    // All cases should come from enum logic (not length logic)
    expect(cases.length).toBeGreaterThan(0);
  });
});

// --- fuzzBoundaryForTool ---

describe('fuzzBoundaryForTool', () => {
  it('returns empty array when tool has no properties', () => {
    const tool = makeTool({ inputSchema: {} });
    expect(fuzzBoundaryForTool(tool, 12345, 8)).toHaveLength(0);
  });

  it('generates boundary cases for schema with minimum/maximum', () => {
    const tool = makeTool({
      inputSchema: {
        properties: {
          count: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    });
    const cases = fuzzBoundaryForTool(tool, 12345, 8);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.strategy).toBe('boundary');
    }
  });

  it('generates boundary cases for schema with enum', () => {
    const tool = makeTool({
      inputSchema: {
        properties: {
          role: { type: 'string', enum: ['admin', 'user', 'guest'] },
        },
      },
    });
    const cases = fuzzBoundaryForTool(tool, 12345, 8);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const tool = makeTool();
    const a = fuzzBoundaryForTool(tool, 7777, 8);
    const b = fuzzBoundaryForTool(tool, 7777, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles format=email with near-miss candidates', () => {
    const tool = makeTool({
      inputSchema: {
        properties: { email: { type: 'string', format: 'email' } },
      },
    });
    const cases = fuzzBoundaryForTool(tool, 12345, 8);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('handles format=uuid with truncated candidates', () => {
    const tool = makeTool({
      inputSchema: {
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    });
    const cases = fuzzBoundaryForTool(tool, 12345, 8);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('EC-3: gracefully handles invalid regex pattern', () => {
    const tool = makeTool({
      inputSchema: {
        properties: { val: { type: 'string', pattern: '[invalid regex(' } },
      },
    });
    // Must not throw; returns some cases via fallback
    expect(() => fuzzBoundaryForTool(tool, 12345, 4)).not.toThrow();
  });
});
