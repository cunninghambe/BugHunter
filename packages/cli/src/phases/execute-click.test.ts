// Tests for case 'click' in executeUiTestInner — v0.12 clickWithObservation emission.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { TestCase, RunState } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'click-test-run';

function makeRunState(projectDir: string): RunState {
  return {
    runId: RUN_ID,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: { projectName: 'test', surfaceMcpUrl: 'http://localhost:3100' },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeMinimalSurface(): SurfaceMcpAdapter {
  return {
    surface_call: vi.fn(),
    surface_list_tools: vi.fn(),
    surface_describe_tool: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn(),
    surface_describe_self: vi.fn(),
    surface_describe_auth: vi.fn(),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

function makeClickTestCase(selector: string): TestCase {
  return {
    id: 'tc-click-1',
    runId: RUN_ID,
    role: 'user',
    page: '/dashboard',
    action: {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector,
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function makeScope(clickWithObservationResult: unknown): TabScope {
  return {
    tabId: 'test-tab',
    navigate: vi.fn().mockResolvedValue({ url: 'http://test', title: 'Test' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue(clickWithObservationResult),
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
      if (script.includes('__bhMutStop') || script.includes('durationMs')) return Promise.resolve({ value: { durationMs: 5 } });
      if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
      if (script.includes('__bh_xss')) return Promise.resolve({ value: [] });
      if (script.includes('document.activeElement')) return Promise.resolve({ value: null });
      return Promise.resolve({ value: null });
    }),
  } as unknown as TabScope;
}

function makeBrowser(scope: TabScope): BrowserMcpAdapter {
  return {
    withTab: vi.fn().mockImplementation(
      (_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(scope),
    ),
  } as unknown as BrowserMcpAdapter;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-click-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('case click — interactive_element_missing_accessible_name emission', () => {
  it('emits BugDetection when clickWithObservation returns accessibleNameAbsent:true', async () => {
    const observationResult = { ok: true, accessibleNameAbsent: true, ariaLabelSource: null, tagName: 'button', role: null };
    const scope = makeScope(observationResult);
    const browser = makeBrowser(scope);
    const tc = makeClickTestCase('button:nth-of-type(3)');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const detections = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'interactive_element_missing_accessible_name');
    expect(detections).toHaveLength(1);
  });

  it('emitted BugDetection has correct pageRoute, selectorClass, and a11yContext', async () => {
    const observationResult = { ok: true, accessibleNameAbsent: true, ariaLabelSource: null, tagName: 'button', role: null };
    const scope = makeScope(observationResult);
    const browser = makeBrowser(scope);
    const tc = makeClickTestCase('button:nth-of-type(3)');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const d = result.results.flatMap(r => r.bugs).find(b => b.kind === 'interactive_element_missing_accessible_name');
    expect(d?.pageRoute).toBe('/dashboard');
    expect(d?.selectorClass).toBe('button:nth-of-type(3)');
    expect(d?.a11yContext?.triggeringSelector).toBe('button:nth-of-type(3)');
  });

  it('does not emit BugDetection when clickWithObservation returns accessibleNameAbsent:false', async () => {
    const observationResult = { ok: true, accessibleNameAbsent: false, ariaLabelSource: 'aria-label', tagName: 'button', role: null };
    const scope = makeScope(observationResult);
    const browser = makeBrowser(scope);
    const tc = makeClickTestCase('button[aria-label="Open navigation"]');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const detections = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'interactive_element_missing_accessible_name');
    expect(detections).toHaveLength(0);
  });

  it('converts BrowserMcpError(element_not_found) to InfrastructureFailure when clickWithObservation throws', async () => {
    const { BrowserMcpError } = await import('../adapters/browser-mcp-error.js');
    const err = new BrowserMcpError('element_not_found', 'click: element_not_in_dom (selector=button)', 'button');
    const scope = {
      tabId: 'test-tab',
      navigate: vi.fn().mockResolvedValue({ url: 'http://test', title: 'Test' }),
      click: vi.fn().mockResolvedValue({ clicked: true }),
      type: vi.fn().mockResolvedValue({ typed: true }),
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html></html>' }),
      screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
      clickWithObservation: vi.fn().mockRejectedValue(err),
      evaluate: vi.fn().mockResolvedValue({ value: null }),
    } as unknown as TabScope;
    const browser = makeBrowser(scope);
    const tc = makeClickTestCase('button:nth-of-type(99)');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const infraFails = result.results.filter(r => r.infrastructureFailure !== undefined);
    expect(infraFails).toHaveLength(1);
    expect(infraFails[0]?.infrastructureFailure?.kind).toBe('browser_element_not_found');
  });

  it('emits the BugDetection without enableA11y flag set (fires unconditionally)', async () => {
    const observationResult = { ok: true, accessibleNameAbsent: true, ariaLabelSource: null, tagName: 'button', role: null };
    const scope = makeScope(observationResult);
    const browser = makeBrowser(scope);
    const tc = makeClickTestCase('button:nth-of-type(1)');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      // Explicitly no enableA11y or a11yStrict
    };

    const result = await runExecute(opts);
    const detections = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'interactive_element_missing_accessible_name');
    expect(detections).toHaveLength(1);
  });
});
