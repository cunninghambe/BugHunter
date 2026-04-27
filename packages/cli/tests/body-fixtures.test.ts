import { describe, it, expect } from 'vitest';
import { apiTestCases, buildApiInput } from '../src/mutation/apply.js';
import type { ToolMeta } from '../src/types.js';
import { ConfigSchema } from '../src/config.js';

const TOOL: ToolMeta = {
  name: 'create_alert',
  toolId: 'tool-abc',
  method: 'POST',
  path: '/api/alerts',
  inputSchema: {
    type: 'object',
    properties: {
      memo: { type: 'string' },
      amount: { type: 'number' },
    },
    required: ['memo'],
  },
  inputSchemaConfidence: 'introspected',
  sideEffectClass: 'mutating',
  sourceFile: 'alerts.ts',
  sourceLine: 1,
  isServerAction: false,
};

const UNKNOWN_TOOL: ToolMeta = {
  ...TOOL,
  toolId: 'tool-unknown',
  inputSchemaConfidence: 'unknown',
};

const PARTIAL_TOOL: ToolMeta = {
  ...TOOL,
  toolId: 'tool-partial',
  inputSchemaConfidence: 'partial',
};

describe('bodyFixtures — apiTestCases (§8)', () => {
  it('happy-palette test for matching role gets fixture fields merged', () => {
    const fixture = { memo: 'seeded', amount: 42 };
    const cases = apiTestCases('run1', 'owner', TOOL, [], undefined, fixture);
    const happy = cases.find(c => c.palette === 'happy');
    expect(happy).toBeDefined();
    const input = happy!.action.input as Record<string, unknown>;
    expect(input['memo']).toBe('seeded');
    expect(input['amount']).toBe(42);
  });

  it('fixture wins over synthesised values on collision', () => {
    const samples = [{ memo: 'original', amount: 1 }];
    const fixture = { memo: 'fixture-wins' };
    const cases = apiTestCases('run1', 'owner', TOOL, samples, undefined, fixture);
    const happy = cases.find(c => c.palette === 'happy');
    const input = happy!.action.input as Record<string, unknown>;
    expect(input['memo']).toBe('fixture-wins');
  });

  it('non-happy palette tests do NOT get fixture fields', () => {
    const fixture = { memo: 'seeded', amount: 42 };
    const cases = apiTestCases('run1', 'owner', TOOL, [], undefined, fixture);
    for (const tc of cases.filter(c => c.palette !== 'happy')) {
      const input = tc.action.input as Record<string, unknown>;
      // Fixture values should not appear in non-happy cases
      expect(input['memo']).not.toBe('seeded');
    }
  });

  it('no fixture applied when fixture is undefined', () => {
    const cases = apiTestCases('run1', 'owner', TOOL, [], undefined, undefined);
    expect(cases.length).toBe(4); // full palette for introspected tool
  });

  it('unknown-confidence tool with fixture: single happy call uses fixture', () => {
    const fixture = { memo: 'seeded', amount: 99 };
    const cases = apiTestCases('run1', 'owner', UNKNOWN_TOOL, [], undefined, fixture);
    expect(cases.length).toBe(1);
    expect(cases[0]!.palette).toBe('happy');
    const input = cases[0]!.action.input as Record<string, unknown>;
    expect(input['memo']).toBe('seeded');
    expect(input['amount']).toBe(99);
  });

  it('partial-confidence tool treated same as unknown (single happy call)', () => {
    const fixture = { memo: 'partial-fixture' };
    const cases = apiTestCases('run1', 'owner', PARTIAL_TOOL, [], undefined, fixture);
    expect(cases.length).toBe(1);
    expect(cases[0]!.palette).toBe('happy');
    const input = cases[0]!.action.input as Record<string, unknown>;
    expect(input['memo']).toBe('partial-fixture');
  });

  it('extra key from fixture (not in schema) is still merged', () => {
    const fixture = { memo: 'seeded', extra_key: 'extra_value' };
    const cases = apiTestCases('run1', 'owner', TOOL, [], undefined, fixture);
    const happy = cases.find(c => c.palette === 'happy');
    const input = happy!.action.input as Record<string, unknown>;
    expect(input['extra_key']).toBe('extra_value');
  });

  it('empty bodyFixtures: {} produces no behaviour change', () => {
    const cases1 = apiTestCases('run1', 'owner', TOOL, [], undefined, undefined);
    const cases2 = apiTestCases('run1', 'owner', TOOL, [], undefined, {});
    // Both should produce 4 cases
    expect(cases1.length).toBe(4);
    expect(cases2.length).toBe(4);
  });
});

describe('bodyFixtures — buildApiInput (§8)', () => {
  it('null palette ignores fixture', () => {
    const input = buildApiInput(TOOL, 'null', undefined, undefined, { memo: 'no' });
    const result = input as Record<string, unknown>;
    expect(result['memo']).not.toBe('no');
  });

  it('edge palette ignores fixture', () => {
    const input = buildApiInput(TOOL, 'edge', undefined, undefined, { memo: 'no' });
    const result = input as Record<string, unknown>;
    expect(result['memo']).not.toBe('no');
  });

  it('out_of_bounds palette ignores fixture', () => {
    const input = buildApiInput(TOOL, 'out_of_bounds', undefined, undefined, { memo: 'no' });
    const result = input as Record<string, unknown>;
    expect(result['memo']).not.toBe('no');
  });
});

describe('ConfigSchema — bodyFixtures Zod validation (§8)', () => {
  it('accepts valid bodyFixtures structure', () => {
    const result = ConfigSchema.safeParse({
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      bodyFixtures: {
        'tool-abc': {
          owner: { memo: 'seeded', amount: 42 },
          '*': { memo: 'wildcard' },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty bodyFixtures', () => {
    const result = ConfigSchema.safeParse({
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      bodyFixtures: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-object value for a role fixture', () => {
    const result = ConfigSchema.safeParse({
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      bodyFixtures: {
        'tool-abc': 'invalid',
      },
    });
    expect(result.success).toBe(false);
  });
});
