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

// ---- v0.22 nav-state test generation (§8 acceptance criteria) ----

function makeNavSurface() {
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

/** A url-kind page with one click button and one POST form. */
const navPageWithMutation: import('../types.js').DiscoveredPage = {
  route: '/orders',
  elements: [{ tag: 'button', selector: '#submit-btn', ancestorStack: '', disabled: false }],
  forms: [{ formSelector: '#order-form', method: 'POST', fields: [{ name: 'qty', type: 'number', required: true }] }],
  links: [],
  kind: 'url',
};

/** A state-kind page with one click button. */
const navStatePage: import('../types.js').DiscoveredPage = {
  route: '/?setTab=orders',
  elements: [{ tag: 'button', selector: '#tab-order-btn', ancestorStack: '', disabled: false }],
  forms: [],
  links: [],
  kind: 'state',
  stateContext: { baseRoute: '/', stateVar: 'setTab', stateValue: 'orders', triggerHint: { text: 'Orders' } },
};

describe('runPlan v0.22 — nav-state: disabled by default', () => {
  it('produces zero nav_transition TestCases when enableNavState is not set', async () => {
    const config: BugHunterConfig = { projectName: 'test', surfaceMcpUrl: 'http://localhost:3105' };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    expect(testCases.filter(tc => tc.action.kind === 'nav_transition')).toHaveLength(0);
  });
});

describe('runPlan v0.22 — nav-state: enabled', () => {
  const navConfig: BugHunterConfig = {
    projectName: 'test',
    surfaceMcpUrl: 'http://localhost:3105',
    enableNavState: true,
  };

  it('emits back + back_then_forward for each mutating click/submit seed on a url-kind page', async () => {
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, navConfig, ['user'], makeNavSurface() as never);
    const navCases = testCases.filter(tc => tc.action.kind === 'nav_transition');

    // back-after-mutation tests
    const backCases = navCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'back' &&
      tc.action.navSeed !== undefined && !tc.action.navSeed.fillOnly
    );
    // back_then_forward tests
    const fwdCases = navCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'back_then_forward'
    );

    expect(backCases.length).toBeGreaterThan(0);
    expect(fwdCases.length).toBeGreaterThan(0);
    expect(fwdCases.length).toBe(backCases.length); // always paired
  });

  it('emits back-after-form-fill (fillOnly seed) for form pages', async () => {
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, navConfig, ['user'], makeNavSurface() as never);
    const navCases = testCases.filter(tc => tc.action.kind === 'nav_transition');

    const fillOnlyCases = navCases.filter(tc =>
      tc.action.kind === 'nav_transition' &&
      tc.action.transition?.kind === 'back' &&
      tc.action.navSeed?.fillOnly === true
    );
    expect(fillOnlyCases.length).toBeGreaterThan(0);
  });

  it('does not emit back + back_then_forward for state-kind page seeds', async () => {
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navStatePage], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, navConfig, ['user'], makeNavSurface() as never);
    const navCases = testCases.filter(tc => tc.action.kind === 'nav_transition');

    // State pages should not produce back-after-mutation (button on state page is not a mutating happy click seed)
    // The state-page button may produce a click test, but the back/back_then_forward should not pair with it
    const backThenFwdCases = navCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'back_then_forward'
    );
    expect(backThenFwdCases).toHaveLength(0);
  });

  it('emits deep-link-no-auth for non-public roles on url-kind pages within depth cap', async () => {
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, navConfig, ['owner'], makeNavSurface() as never);
    const deepLinkCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'deep_link_no_auth'
    );
    expect(deepLinkCases.length).toBeGreaterThan(0);
  });

  it('does not emit deep-link-no-auth for public role', async () => {
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, navConfig, ['public'], makeNavSurface() as never);
    const deepLinkCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'deep_link_no_auth'
    );
    expect(deepLinkCases).toHaveLength(0);
  });

  it('respects navStateSkipRoutes: skipped route produces zero nav_transition tests', async () => {
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavState: true,
      navStateSkipRoutes: ['/orders'],
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    expect(testCases.filter(tc => tc.action.kind === 'nav_transition')).toHaveLength(0);
  });

  it('respects navStateDeepLinkMaxDepth: deep route beyond cap emits no deep-link test', async () => {
    const deepPage: import('../types.js').DiscoveredPage = {
      route: '/a/b/c/d', // depth=4 segments
      elements: [],
      forms: [],
      links: [],
      kind: 'url',
    };
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavState: true,
      navStateDeepLinkMaxDepth: 2, // only routes with <= 2 segments
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [deepPage], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['owner'], makeNavSurface() as never);
    const deepLinkCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'deep_link_no_auth'
    );
    expect(deepLinkCases).toHaveLength(0);
  });
});

describe('runPlan v0.22 — nav-state: refresh-race flag', () => {
  it('does not emit refresh tests when enableNavStateRefreshRace is false', async () => {
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavState: true,
      enableNavStateRefreshRace: false,
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    const refreshCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'refresh'
    );
    expect(refreshCases).toHaveLength(0);
  });

  it('emits refresh tests for each mutating seed when enableNavStateRefreshRace is true', async () => {
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavStateRefreshRace: true, // implies enableNavState
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    const refreshCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'refresh'
    );
    expect(refreshCases.length).toBeGreaterThan(0);
  });

  it('state-page seeds still emit refresh when enableNavStateRefreshRace is true', async () => {
    // State pages do not block refresh — only back/forward are skipped.
    const statePageWithButton: import('../types.js').DiscoveredPage = {
      route: '/?setTab=trade',
      elements: [{ tag: 'button', selector: '#submit-trade', ancestorStack: '', disabled: false }],
      forms: [],
      links: [],
      kind: 'state',
      stateContext: { baseRoute: '/', stateVar: 'setTab', stateValue: 'trade', triggerHint: { text: 'Trade' } },
    };
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavStateRefreshRace: true,
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [statePageWithButton], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    // The click on the state-page button generates a click test with expectedOutcome:'success' and palette:'happy'
    // It should then get a refresh nav-state pair.
    const refreshCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'refresh'
    );
    expect(refreshCases.length).toBeGreaterThan(0);
  });
});

describe('runPlan v0.22 — nav-state: history corruption flag', () => {
  it('emits history_corrupt tests when enableHistoryCorruption is true', async () => {
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableHistoryCorruption: true, // implies enableNavState
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    const corruptCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'history_corrupt'
    );
    expect(corruptCases.length).toBeGreaterThan(0);
    // Verify pushStates are included
    for (const tc of corruptCases) {
      if (tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'history_corrupt') {
        expect(tc.action.transition.pushStates.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('does not emit history_corrupt tests when flag is off', async () => {
    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3105',
      enableNavState: true,
      enableHistoryCorruption: false,
    };
    const discovery: import('../types.js').DiscoveryOutput = { pages: [navPageWithMutation], apiTools: [], skipList: [] };
    const { testCases } = await runPlan('run1', discovery, config, ['user'], makeNavSurface() as never);
    const corruptCases = testCases.filter(tc =>
      tc.action.kind === 'nav_transition' && tc.action.transition?.kind === 'history_corrupt'
    );
    expect(corruptCases).toHaveLength(0);
  });
});
