// Tests for plan phase — stateContext propagation (v0.9 T2).

import { describe, it, expect, vi } from 'vitest';
import { runPlan } from './plan.js';
import type { DiscoveryOutput, BugHunterConfig } from '../types.js';

function makeSurface() {
  return {
    surface_describe_self: vi.fn().mockResolvedValue({ capabilities: { listNavigations: false, enumerateRoutesRuntime: false } }),
    surface_list_navigations: vi.fn().mockResolvedValue({ navigations: [] }),
    surface_sample_inputs: vi.fn().mockResolvedValue({ samples: [] }),
    surface_probe: vi.fn().mockResolvedValue(null),
    surface_call: vi.fn().mockResolvedValue({ ok: true, status: 200, body: {}, durationMs: 0 }),
    surface_list_routes: vi.fn().mockResolvedValue({ routes: [] }),
    surface_postprocess_runtime_routes: vi.fn().mockResolvedValue({ routes: [], summary: { dedupedRoutes: 0, detectedRouters: [] } }),
    surface_enumerate_routes_runtime: vi.fn().mockResolvedValue({ script: '', timeoutMs: 1000 }),
  };
}

const baseConfig: BugHunterConfig = {
  projectName: 'test',
  surfaceMcpUrl: 'http://localhost:3105',
  xss: { enabled: false },
};

describe('runPlan (v0.9 stateContext)', () => {
  it('url-kind page produces TestCases with stateContext undefined', async () => {
    const discovery: DiscoveryOutput = {
      pages: [{
        route: '/home',
        elements: [],
        forms: [],
        links: [],
        kind: 'url',
      }],
      apiTools: [],
      skipList: [],
    };
    const surface = makeSurface();
    const { testCases } = await runPlan('run1', discovery, baseConfig, ['user'], surface as never);
    for (const tc of testCases) {
      expect(tc.stateContext).toBeUndefined();
    }
  });

  it('state-kind page produces TestCases with stateContext populated', async () => {
    const stateCtx = {
      baseRoute: '/',
      stateVar: 'setTab',
      stateValue: 'trades',
      triggerHint: { text: 'Trades' },
    };
    const discovery: DiscoveryOutput = {
      pages: [{
        route: '/?setTab=trades',
        elements: [{ tag: 'button', selector: '#buy-btn', ancestorStack: '', disabled: false }],
        forms: [],
        links: ['/trade/123'],
        kind: 'state',
        stateContext: stateCtx,
      }],
      apiTools: [],
      skipList: [],
    };
    const surface = makeSurface();
    const { testCases } = await runPlan('run1', discovery, baseConfig, ['user'], surface as never);
    expect(testCases.length).toBeGreaterThan(0);
    for (const tc of testCases) {
      expect(tc.stateContext).toEqual(stateCtx);
    }
  });

  it('render, navigate, click test cases all carry stateContext from state page', async () => {
    const stateCtx = {
      baseRoute: '/',
      stateVar: 'setTab',
      stateValue: 'import',
      triggerHint: { ariaLabel: 'Import' },
    };
    const discovery: DiscoveryOutput = {
      pages: [{
        route: '/?setTab=import',
        elements: [{ tag: 'button', selector: '#import-btn', ancestorStack: '', disabled: false }],
        forms: [],
        links: ['/import/guide'],
        kind: 'state',
        stateContext: stateCtx,
      }],
      apiTools: [],
      skipList: [],
    };
    const surface = makeSurface();
    const { testCases } = await runPlan('run1', discovery, baseConfig, ['user'], surface as never);

    const renderCase = testCases.find(tc => tc.action.kind === 'render');
    const navigateCase = testCases.find(tc => tc.action.kind === 'navigate');
    const clickCase = testCases.find(tc => tc.action.kind === 'click');

    expect(renderCase?.stateContext).toEqual(stateCtx);
    expect(navigateCase?.stateContext).toEqual(stateCtx);
    expect(clickCase?.stateContext).toEqual(stateCtx);
  });

  it('form test cases on state page carry stateContext', async () => {
    const stateCtx = {
      baseRoute: '/',
      stateVar: 'setTab',
      stateValue: 'profile',
      triggerHint: { text: 'Profile' },
    };
    const discovery: DiscoveryOutput = {
      pages: [{
        route: '/?setTab=profile',
        elements: [],
        forms: [{
          formSelector: '#profile-form',
          method: 'POST',
          fields: [{ name: 'name', type: 'text', required: true }],
        }],
        links: [],
        kind: 'state',
        stateContext: stateCtx,
      }],
      apiTools: [],
      skipList: [],
    };
    const surface = makeSurface();
    const { testCases } = await runPlan('run1', discovery, baseConfig, ['user'], surface as never);
    const submitCases = testCases.filter(tc => tc.action.kind === 'submit');
    expect(submitCases.length).toBeGreaterThan(0);
    for (const tc of submitCases) {
      expect(tc.stateContext).toEqual(stateCtx);
    }
  });

  it('api test cases never carry stateContext', async () => {
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [{
        name: 'create-trade',
        toolId: 'create-trade',
        method: 'POST',
        path: '/api/trades',
        inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
        inputSchemaConfidence: 'introspected',
        sideEffectClass: 'mutating',
        sourceFile: 'trades.ts',
        sourceLine: 1,
        isServerAction: false,
      }],
      skipList: [],
    };
    const surface = makeSurface();
    const { testCases } = await runPlan('run1', discovery, baseConfig, ['user'], surface as never);
    const apiCases = testCases.filter(tc => tc.action.via === 'api');
    expect(apiCases.length).toBeGreaterThan(0);
    for (const tc of apiCases) {
      expect(tc.stateContext).toBeUndefined();
    }
  });
});
