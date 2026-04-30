// Tests for plan phase — stateContext propagation (v0.9 T2) + probe filter (v0.11 T3) + HTTP method filter (v0.12 T4).

import { describe, it, expect, vi } from 'vitest';
import { runPlan, shouldEmitSubmitTest } from './plan.js';
import { apiTestCases } from '../mutation/apply.js';
import { probeKey } from './form-reachability-probe.js';
import type { DiscoveryOutput, BugHunterConfig, DiscoveredPage, DiscoveredForm, ToolMeta } from '../types.js';
import type { ProbeResult } from './form-reachability-probe.js';

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

describe('shouldEmitSubmitTest (v0.11 probe filter)', () => {
  const stateCtx = { baseRoute: '/', stateVar: 'setTab', stateValue: 'profile', triggerHint: { text: 'Profile' } };
  const statePage: DiscoveredPage = {
    route: '/?setTab=profile',
    elements: [],
    forms: [],
    links: [],
    kind: 'state',
    stateContext: stateCtx,
  };
  const urlPage: DiscoveredPage = { route: '/login', elements: [], forms: [], links: [], kind: 'url' };
  const form: DiscoveredForm = { formSelector: 'form:nth-of-type(1)', method: 'POST', fields: [] };

  it('emits when probes is undefined (legacy / pre-probe path)', () => {
    const { emit } = shouldEmitSubmitTest('owner', statePage, form, undefined);
    expect(emit).toBe(true);
  });

  it('skips when probe says formPresent:false', () => {
    const probes = new Map<ReturnType<typeof probeKey>, ProbeResult>();
    probes.set(probeKey('anon', '/?setTab=profile', 'form:nth-of-type(1)'), { probed: true, formPresent: false, latencyMs: 2000, reason: 'form_never_rendered' });
    const { emit, skipReason } = shouldEmitSubmitTest('anon', statePage, form, probes);
    expect(emit).toBe(false);
    expect(skipReason).toBe('form_unreachable_for_role');
  });

  it('emits for owner, skips for anon (asymmetric probe results)', () => {
    const probes = new Map<ReturnType<typeof probeKey>, ProbeResult>();
    probes.set(probeKey('owner', '/?setTab=profile', 'form:nth-of-type(1)'), { probed: true, formPresent: true, latencyMs: 150 });
    probes.set(probeKey('anon', '/?setTab=profile', 'form:nth-of-type(1)'), { probed: true, formPresent: false, latencyMs: 2000, reason: 'form_never_rendered' });
    expect(shouldEmitSubmitTest('owner', statePage, form, probes).emit).toBe(true);
    expect(shouldEmitSubmitTest('anon', statePage, form, probes).emit).toBe(false);
  });

  it('emits for url-kind page regardless of probes', () => {
    const probes = new Map<ReturnType<typeof probeKey>, ProbeResult>();
    probes.set(probeKey('owner', '/login', 'form:nth-of-type(1)'), { probed: true, formPresent: false, latencyMs: 2000, reason: 'form_never_rendered' });
    const { emit } = shouldEmitSubmitTest('owner', urlPage, form, probes);
    expect(emit).toBe(true);
  });

  it('emits when probe key not in map (budget exhausted — default to emit)', () => {
    const probes = new Map<ReturnType<typeof probeKey>, ProbeResult>(); // empty — no probe ran for this tuple
    const { emit } = shouldEmitSubmitTest('owner', statePage, form, probes);
    expect(emit).toBe(true);
  });
});

describe('runPlan v0.11 — probe-filtered submit tests', () => {
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

  const stateCtx = { baseRoute: '/', stateVar: 'setTab', stateValue: 'profile', triggerHint: { text: 'Profile' } };
  const profilePage: DiscoveredPage = {
    route: '/?setTab=profile',
    elements: [],
    forms: [{ formSelector: 'form:nth-of-type(1)', method: 'POST', fields: [{ name: 'name', type: 'text', required: true }] }],
    links: [],
    kind: 'state',
    stateContext: stateCtx,
  };

  it('emits submit tests when probes not provided', async () => {
    const discovery: DiscoveryOutput = { pages: [profilePage], apiTools: [], skipList: [] };
    const { testCases, skipReasons } = await runPlan('run1', discovery, baseConfig, ['owner', 'anon'], makeSurface() as never);
    const submitCases = testCases.filter(tc => tc.action.kind === 'submit');
    expect(submitCases.length).toBeGreaterThan(0);
    expect(skipReasons).toHaveLength(0);
  });

  it('skips anon submit tests when probe says formPresent:false for anon', async () => {
    const probes = new Map<ReturnType<typeof probeKey>, ProbeResult>();
    probes.set(probeKey('owner', '/?setTab=profile', 'form:nth-of-type(1)'), { probed: true, formPresent: true, latencyMs: 100 });
    probes.set(probeKey('anon', '/?setTab=profile', 'form:nth-of-type(1)'), { probed: true, formPresent: false, latencyMs: 2000, reason: 'form_never_rendered' });

    const discovery: DiscoveryOutput = { pages: [profilePage], apiTools: [], skipList: [] };
    const { testCases, skipReasons } = await runPlan('run1', discovery, baseConfig, ['owner', 'anon'], makeSurface() as never, probes);
    const anonSubmits = testCases.filter(tc => tc.action.kind === 'submit' && tc.role === 'anon');
    const ownerSubmits = testCases.filter(tc => tc.action.kind === 'submit' && tc.role === 'owner');
    expect(ownerSubmits.length).toBeGreaterThan(0);
    expect(anonSubmits).toHaveLength(0);
    const unreachableSkip = skipReasons.find(r => r.reason === 'form_unreachable_for_role');
    expect(unreachableSkip).toBeDefined();
    expect(unreachableSkip?.count).toBeGreaterThan(0);
  });
});

describe('HTTP method filter (v0.12 T4) — apiTestCases', () => {
  const MUTATING_PALETTES = new Set(['null', 'xss_inject', 'out_of_bounds']);

  function makeTool(method: string | undefined): ToolMeta {
    return {
      name: 'test-tool',
      toolId: 'tool-1',
      method: method ?? 'GET',
      path: '/api/test',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
      inputSchemaConfidence: 'introspected',
      sideEffectClass: 'safe',
      sourceFile: 'test.ts',
      sourceLine: 1,
      isServerAction: false,
    };
  }

  it('GET tool produces only happy and edge palettes', () => {
    const cases = apiTestCases('run1', 'user', makeTool('GET'), []);
    const palettes = cases.map(c => c.palette);
    expect(palettes).toContain('happy');
    expect(palettes).toContain('edge');
    for (const p of palettes) {
      expect(MUTATING_PALETTES.has(p)).toBe(false);
    }
  });

  it('POST tool produces all palette variants including mutating ones', () => {
    const cases = apiTestCases('run1', 'user', makeTool('POST'), []);
    const palettes = new Set(cases.map(c => c.palette));
    expect(palettes.has('happy')).toBe(true);
    expect(palettes.has('edge')).toBe(true);
    expect(palettes.has('null')).toBe(true);
    expect(palettes.has('out_of_bounds')).toBe(true);
  });

  it('HEAD tool produces only happy and edge palettes (safe method)', () => {
    const cases = apiTestCases('run1', 'user', makeTool('HEAD'), []);
    const palettes = cases.map(c => c.palette);
    expect(palettes).toContain('happy');
    expect(palettes).toContain('edge');
    for (const p of palettes) {
      expect(MUTATING_PALETTES.has(p)).toBe(false);
    }
  });

  it('OPTIONS tool produces only happy and edge palettes (safe method)', () => {
    const cases = apiTestCases('run1', 'user', makeTool('OPTIONS'), []);
    const palettes = cases.map(c => c.palette);
    expect(palettes).toContain('happy');
    expect(palettes).toContain('edge');
    for (const p of palettes) {
      expect(MUTATING_PALETTES.has(p)).toBe(false);
    }
  });

  it('undefined method falls back to mutation-allowed (all palettes)', () => {
    // Tool with undefined method: build manually to bypass ToolMeta's required method field
    const tool = { ...makeTool('GET'), method: undefined } as unknown as ToolMeta;
    const cases = apiTestCases('run1', 'user', tool, []);
    const palettes = new Set(cases.map(c => c.palette));
    expect(palettes.has('null')).toBe(true);
    expect(palettes.has('out_of_bounds')).toBe(true);
  });
});
