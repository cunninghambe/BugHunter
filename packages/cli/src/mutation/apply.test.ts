// Tests for mutation helpers — xssFormTestCases, xssApiTestCases, formTestCases (v0.7 + v0.9 + v0.39).

import { describe, it, expect } from 'vitest';
import { xssFormTestCases, xssApiTestCases, formTestCases, apiTestCases } from './apply.js';
import type { DiscoveredForm, ToolMeta, TestCase } from '../types.js';
import type { FuzzOptions } from './fuzz.js';

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

// v0.9 Bug 1: formTestCases selector + stateContext propagation
describe('formTestCases (v0.9)', () => {
  const form: DiscoveredForm = {
    formSelector: '#profile-form',
    method: 'POST',
    fields: [
      { name: 'username', type: 'text', required: true },
      { name: 'email', type: 'email', required: true },
    ],
  };

  const stateCtx: NonNullable<TestCase['stateContext']> = {
    baseRoute: '/',
    stateVar: 'setTab',
    stateValue: 'profile',
    triggerHint: { text: 'Profile' },
  };

  it('sets action.selector to form.formSelector for every palette', () => {
    const cases = formTestCases('run1', 'user', '/?setTab=profile', form, 'run1');
    expect(cases).toHaveLength(4);
    for (const tc of cases) {
      expect(tc.action.selector).toBe('#profile-form');
    }
  });

  it('action.input is a Record keyed by field name', () => {
    const cases = formTestCases('run1', 'user', '/?setTab=profile', form, 'run1');
    for (const tc of cases) {
      expect(typeof tc.action.input).toBe('object');
      expect(tc.action.input).not.toBeNull();
    }
  });

  it('threads stateContext onto each TestCase', () => {
    const cases = formTestCases('run1', 'user', '/?setTab=profile', form, 'run1', undefined, stateCtx);
    for (const tc of cases) {
      expect(tc.stateContext).toEqual(stateCtx);
    }
  });

  it('stateContext is undefined when not passed', () => {
    const cases = formTestCases('run1', 'user', '/', form, 'run1');
    for (const tc of cases) {
      expect(tc.stateContext).toBeUndefined();
    }
  });
});

// v0.9 Bug 1 + Bug 2: xssFormTestCases selector + stateContext propagation
describe('xssFormTestCases (v0.9)', () => {
  const form: DiscoveredForm = {
    formSelector: '#xss-form',
    method: 'POST',
    fields: [{ name: 'query', type: 'text', required: false }],
  };

  const stateCtx: NonNullable<TestCase['stateContext']> = {
    baseRoute: '/',
    stateVar: 'tab',
    stateValue: 'search',
    triggerHint: { ariaLabel: 'Search' },
  };

  it('sets action.selector to form.formSelector for every canary case', () => {
    const cases = xssFormTestCases('run1', 'user', '/page', form);
    expect(cases.length).toBeGreaterThan(0);
    for (const tc of cases) {
      expect(tc.action.selector).toBe('#xss-form');
    }
  });

  it('threads stateContext onto each XSS canary TestCase', () => {
    const cases = xssFormTestCases('run1', 'user', '/page', form, 'minimal', stateCtx);
    for (const tc of cases) {
      expect(tc.stateContext).toEqual(stateCtx);
    }
  });

  it('stateContext is undefined when not passed', () => {
    const cases = xssFormTestCases('run1', 'user', '/page', form);
    for (const tc of cases) {
      expect(tc.stateContext).toBeUndefined();
    }
  });
});

// v0.39 — fuzz threading tests
const fuzzOpts: FuzzOptions = {
  strategies: ['unicode'],
  runs: 4,
  subSeedBase: 7777,
  shrink: false,
  maxTotalDraws: 25_000,
};

describe('formTestCases — fuzz threading', () => {
  const form: DiscoveredForm = {
    formSelector: '#form',
    method: 'POST',
    fields: [{ name: 'username', type: 'text', required: true }],
  };

  it('without fuzzOpts returns only 4 fixed palette cases', () => {
    const cases = formTestCases('run1', 'user', '/page', form, 'run1');
    expect(cases).toHaveLength(4);
    expect(cases.every(tc => tc.palette !== 'fuzz')).toBe(true);
  });

  it('with fuzzOpts appends fuzz cases after fixed palette', () => {
    const cases = formTestCases('run1', 'user', '/page', form, 'run1', undefined, undefined, fuzzOpts);
    const fixedCases = cases.filter(tc => tc.palette !== 'fuzz');
    const fuzzCases = cases.filter(tc => tc.palette === 'fuzz');
    expect(fixedCases).toHaveLength(4);
    expect(fuzzCases.length).toBeGreaterThan(0);
  });

  it('fuzz cases have fuzzMeta set', () => {
    const cases = formTestCases('run1', 'user', '/page', form, 'run1', undefined, undefined, fuzzOpts);
    const fuzzCases = cases.filter(tc => tc.palette === 'fuzz');
    for (const tc of fuzzCases) {
      expect(tc.fuzzMeta).toBeDefined();
      expect(tc.fuzzMeta?.strategy).toBe('unicode');
    }
  });

  it('fixed palette is unchanged when fuzzOpts is passed', () => {
    const withoutFuzz = formTestCases('run1', 'user', '/page', form, 'run1');
    const withFuzz = formTestCases('run1', 'user', '/page', form, 'run1', undefined, undefined, fuzzOpts);
    const fixedPalettes = withFuzz.filter(tc => tc.palette !== 'fuzz').map(tc => tc.palette);
    const expected = withoutFuzz.map(tc => tc.palette);
    expect(fixedPalettes).toEqual(expected);
  });
});

describe('apiTestCases — fuzz threading', () => {
  const tool: ToolMeta = {
    name: 'create-user',
    toolId: 'createUser',
    method: 'POST',
    path: '/api/users',
    inputSchema: { properties: { name: { type: 'string' } }, required: ['name'] },
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'mutating',
    sourceFile: 'test.ts',
    sourceLine: 1,
    isServerAction: false,
  };

  it('without fuzzOpts returns only fixed palette cases', () => {
    const cases = apiTestCases('run1', 'user', tool, []);
    expect(cases.every(tc => tc.palette !== 'fuzz')).toBe(true);
  });

  it('with fuzzOpts appends fuzz cases', () => {
    const cases = apiTestCases('run1', 'user', tool, [], undefined, undefined, fuzzOpts);
    const fuzzCases = cases.filter(tc => tc.palette === 'fuzz');
    expect(fuzzCases.length).toBeGreaterThan(0);
  });

  it('skips fuzz on GET (safe method) tools', () => {
    const getTool: ToolMeta = { ...tool, method: 'GET' };
    const cases = apiTestCases('run1', 'user', getTool, [], undefined, undefined, fuzzOpts);
    expect(cases.every(tc => tc.palette !== 'fuzz')).toBe(true);
  });

  it('fuzz cases on API tools have fuzzMeta', () => {
    const cases = apiTestCases('run1', 'user', tool, [], undefined, undefined, fuzzOpts);
    const fuzzCases = cases.filter(tc => tc.palette === 'fuzz');
    for (const tc of fuzzCases) {
      expect(tc.fuzzMeta).toBeDefined();
    }
  });
});
