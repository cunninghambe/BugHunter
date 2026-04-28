// Tests for mutation helpers — xssFormTestCases and xssApiTestCases (v0.7 Task X2).

import { describe, it, expect } from 'vitest';
import { xssFormTestCases, xssApiTestCases } from './apply.js';
import type { DiscoveredForm, ToolMeta } from '../types.js';

function makeForm(fields: Array<{ name: string; type: DiscoveredForm['fields'][number]['type'] }>): DiscoveredForm {
  return {
    formSelector: 'form',
    method: 'POST',
    fields: fields.map(f => ({ name: f.name, type: f.type, required: false })),
  };
}

function makeTool(properties: Record<string, { type?: string }>): ToolMeta {
  return {
    name: 'test-tool',
    toolId: 'test-tool',
    method: 'POST',
    path: '/api/test',
    inputSchema: { properties },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'test.ts',
    sourceLine: 1,
    isServerAction: false,
  };
}

describe('xssFormTestCases', () => {
  it('returns empty array for form with no text-injectable fields', () => {
    const form = makeForm([{ name: 'count', type: 'number' }, { name: 'checked', type: 'checkbox' }]);
    expect(xssFormTestCases('run1', 'user', '/page', form)).toHaveLength(0);
  });

  it('produces N test cases for a form with N text fields × |minimal palette|', () => {
    const form = makeForm([{ name: 'title', type: 'text' }, { name: 'body', type: 'text' }]);
    // 2 fields × 5 minimal canaries = 10
    const cases = xssFormTestCases('run1', 'user', '/page', form);
    expect(cases).toHaveLength(10);
  });

  it('produces more test cases with full palette', () => {
    const form = makeForm([{ name: 'title', type: 'text' }]);
    const minimal = xssFormTestCases('run1', 'user', '/page', form, 'minimal');
    const full = xssFormTestCases('run1', 'user', '/page', form, 'full');
    expect(full.length).toBeGreaterThan(minimal.length);
    expect(minimal).toHaveLength(5);
    expect(full).toHaveLength(12);
  });

  it('each test case has injectionNonce set', () => {
    const form = makeForm([{ name: 'name', type: 'text' }]);
    for (const tc of xssFormTestCases('run1', 'user', '/page', form)) {
      expect(tc.action.injectionNonce).toBeDefined();
      expect(tc.action.injectionNonce?.length).toBe(16);
    }
  });

  it('each test case input value contains the nonce', () => {
    const form = makeForm([{ name: 'name', type: 'text' }]);
    for (const tc of xssFormTestCases('run1', 'user', '/page', form)) {
      const input = tc.action.input as Record<string, string>;
      const nonce = tc.action.injectionNonce ?? '';
      expect(input['name']).toContain(nonce);
    }
  });

  it('sets palette to xss_inject', () => {
    const form = makeForm([{ name: 'q', type: 'text' }]);
    for (const tc of xssFormTestCases('run1', 'user', '/page', form)) {
      expect(tc.action.palette).toBe('xss_inject');
    }
  });

  it('includes email and url fields as injectable', () => {
    const form = makeForm([{ name: 'email', type: 'email' }, { name: 'site', type: 'url' }]);
    const cases = xssFormTestCases('run1', 'user', '/page', form);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('excludes number and checkbox fields', () => {
    const form = makeForm([
      { name: 'amount', type: 'number' },
      { name: 'agree', type: 'checkbox' },
      { name: 'comment', type: 'text' },
    ]);
    // Only 'comment' is injectable → 5 cases
    expect(xssFormTestCases('run1', 'user', '/page', form)).toHaveLength(5);
  });
});

describe('xssApiTestCases', () => {
  it('returns empty array when tool has no properties', () => {
    const tool = makeTool({});
    expect(xssApiTestCases('run1', 'user', tool)).toHaveLength(0);
  });

  it('produces N test cases for N string fields × |palette|', () => {
    const tool = makeTool({ title: { type: 'string' }, body: { type: 'string' } });
    // 2 fields × 5 minimal canaries = 10
    expect(xssApiTestCases('run1', 'user', tool)).toHaveLength(10);
  });

  it('each test case has injectionNonce set', () => {
    const tool = makeTool({ q: { type: 'string' } });
    for (const tc of xssApiTestCases('run1', 'user', tool)) {
      expect(tc.action.injectionNonce).toBeDefined();
      expect(tc.action.injectionNonce?.length).toBe(16);
    }
  });

  it('each test case input value contains the nonce', () => {
    const tool = makeTool({ q: { type: 'string' } });
    for (const tc of xssApiTestCases('run1', 'user', tool)) {
      const input = tc.action.input as Record<string, string>;
      const nonce = tc.action.injectionNonce ?? '';
      expect(input['q']).toContain(nonce);
    }
  });

  it('sets toolId on the action', () => {
    const tool = makeTool({ q: { type: 'string' } });
    for (const tc of xssApiTestCases('run1', 'user', tool)) {
      expect(tc.action.toolId).toBe('test-tool');
    }
  });

  it('respects mutateJsonBodies=false by returning empty array', () => {
    const tool = makeTool({ q: { type: 'string' } });
    expect(xssApiTestCases('run1', 'user', tool, 'minimal', false)).toHaveLength(0);
  });

  it('skips non-string schema types', () => {
    const tool = makeTool({ count: { type: 'integer' }, name: { type: 'string' } });
    // Only 'name' is injectable → 5 cases
    expect(xssApiTestCases('run1', 'user', tool)).toHaveLength(5);
  });
});
