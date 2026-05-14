import { describe, expect, it } from 'vitest';
import { buildApiInput } from './apply.js';
import type { ToolMeta } from '../types.js';

function tool(properties: Record<string, unknown>, required: string[] = []): ToolMeta {
  return {
    toolId: 't1',
    name: 'test_tool',
    method: 'POST',
    path: '/test',
    inputSchema: { type: 'object', properties, required },
  } as unknown as ToolMeta;
}

describe('schemaToInputType (via buildApiInput)', () => {
  it('routes enum schema to select palette and emits the first enum member as happy', () => {
    const t = tool({
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    });
    const input = buildApiInput(t, 'happy', undefined) as Record<string, unknown>;
    expect(input.priority).toBe('low');
  });

  it('routes enum schema to last enum member on edge variant', () => {
    const t = tool({
      role: { type: 'string', enum: ['ADMIN', 'MEMBER', 'OWNER'] },
    });
    const input = buildApiInput(t, 'edge', undefined) as Record<string, unknown>;
    expect(input.role).toBe('OWNER');
  });

  it('routes date-time format to datetime palette and emits a full ISO string', () => {
    const t = tool({
      startDate: { type: 'string', format: 'date-time' },
    });
    const input = buildApiInput(t, 'happy', undefined) as Record<string, unknown>;
    expect(input.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('preserves date-only format → date palette → YYYY-MM-DD shape', () => {
    const t = tool({
      birthday: { type: 'string', format: 'date' },
    });
    const input = buildApiInput(t, 'happy', undefined) as Record<string, unknown>;
    expect(input.birthday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls through to text palette when no enum and no recognized format', () => {
    const t = tool({
      name: { type: 'string' },
    });
    const input = buildApiInput(t, 'happy', undefined) as Record<string, unknown>;
    expect(input.name).toBe('test value');
  });
});
