// V24 plumbing tests — verify that each deferred detector wires through to result.bugs
// when the corresponding flags and inputs are provided via mocked TabScope + PerfCollector.
// One test per BugKind; mirrors the pattern in execute-click.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { TestCase, RunState, PerfArtifacts } from '../types.js';
import type { PerfCollector } from '../perf/perf-collector.js';
import type { HarLog } from '../adapters/har-writer.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'v24-plumbing-run';

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

function makeTestCase(page = '/test'): TestCase {
  return {
    id: 'tc-v24',
    runId: RUN_ID,
    role: 'user',
    page,
    action: {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: 'button#action',
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

/**
 * Build a TabScope mock whose evaluate() resolves based on the script content.
 * evaluateOverrides: map of script substring → return value.
 */
function makeScope(evaluateOverrides: Record<string, unknown> = {}): TabScope {
  return {
    tabId: 'v24-tab',
    navigate: vi.fn().mockResolvedValue({ url: 'http://test', title: 'Test' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'button', role: null }),
    evaluate: vi.fn().mockImplementation((script: string) => {
      // Check each override in insertion order; first match wins.
      for (const [key, val] of Object.entries(evaluateOverrides)) {
        if (script.includes(key)) return Promise.resolve({ value: val });
      }
      // Defaults for scripts that executeUiTestInner always calls.
      if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
      if (script.includes('durationMs') || script.includes('__bhMutStop')) return Promise.resolve({ value: { durationMs: 5 } });
      if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
      if (script.includes('__bh_xss')) return Promise.resolve({ value: [] });
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

function makePerfCollector(perf: Partial<PerfArtifacts> = {}, har: HarLog = { log: { version: '1.2', creator: { name: 'bughunter', version: '0.6' }, entries: [] } }): PerfCollector {
  const fullPerf: PerfArtifacts = {
    occurrenceId: 'occ-v24',
    webVitals: [],
    longTasks: [],
    heapSamples: [],
    renderEvents: [],
    navigationEvents: [],
    ...perf,
  };
  return {
    observe: vi.fn().mockResolvedValue(undefined),
    tick: vi.fn(),
    drain: vi.fn().mockResolvedValue({ perf: fullPerf, har }),
  } as PerfCollector;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-v24-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network', 'perf']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3.1 request_cancellation_missing
// ---------------------------------------------------------------------------
describe('V24 plumbing — request_cancellation_missing', () => {
  it('emits request_cancellation_missing when HAR has an in-flight request spanning a navigation', async () => {
    // Two navigation events: first at t=1000, second at t=2000.
    // A request started at t=1500 (between navigations) and completed at t=2500 (after nav 2).
    const navEvents = [
      { url: 'http://localhost/page-a', timestamp: 1000 },
      { url: 'http://localhost/page-b', timestamp: 2000 },
    ];
    const harEntry = {
      startedDateTime: new Date(1500).toISOString(),
      time: 1001,  // ends at t=2501 > navTimeMs=2000
      request: { method: 'GET', url: 'http://localhost/api/data', httpVersion: 'HTTP/1.1', cookies: [], headers: [], headersSize: 0, bodySize: 0, queryString: [] },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], headers: [], bodySize: 0, headersSize: 0, content: { size: 0, mimeType: '' }, redirectURL: '' },
      timings: { send: 0, wait: 1000, receive: 1 },
      _bughunter: { actionWindowId: 'occ-v24', cdpSessionRole: 'observer' as const, requestId: 'req-1' },
    };
    const har: HarLog = { log: { version: '1.2', creator: { name: 'bughunter', version: '0.6' }, entries: [harEntry] } };
    const perfCollector = makePerfCollector({ navigationEvents: navEvents }, har);

    const scope = makeScope();
    const browser = makeBrowser(scope);
    const tc = makeTestCase('/page-a');

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
      perfCollector,
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'request_cancellation_missing');
    expect(detected).toHaveLength(1);
    expect(detected[0].endpoint).toContain('GET');
  });

  it('does not emit request_cancellation_missing when only one navigation event occurred', async () => {
    const navEvents = [{ url: 'http://localhost/page-a', timestamp: 1000 }];
    const perfCollector = makePerfCollector({ navigationEvents: navEvents });
    const scope = makeScope();
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase()],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      perfCollector,
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'request_cancellation_missing');
    expect(detected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3.2 unbounded_list_render
// ---------------------------------------------------------------------------
describe('V24 plumbing — unbounded_list_render', () => {
  it('emits unbounded_list_render when outerHTML contains 150 <tr> rows and enablePerf is on', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join('');
    const bigHtml = `<html><body><table><tbody>${rows}</tbody></table></body></html>`;

    // Map the outerHTML script substring to our big HTML
    const scope = makeScope({ 'document.documentElement.outerHTML': bigHtml });
    const browser = makeBrowser(scope);
    const perfCollector = makePerfCollector();

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/long-list')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      perfCollector,  // presence signals enablePerf=true to executeUiTest
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'unbounded_list_render');
    expect(detected).toHaveLength(1);
    expect((detected[0].evidence as { rowCount: number } | undefined)?.rowCount).toBe(150);
  });

  it('does not emit unbounded_list_render when perfCollector is absent', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join('');
    const bigHtml = `<html><body><table><tbody>${rows}</tbody></table></body></html>`;

    const scope = makeScope({ 'document.documentElement.outerHTML': bigHtml });
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/long-list')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      // No perfCollector → enablePerf=false → outerHTML not captured → no detection
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'unbounded_list_render');
    expect(detected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3.3 dom_error_text
// ---------------------------------------------------------------------------
describe('V24 plumbing — dom_error_text', () => {
  it('emits dom_error_text when error text appears post-action but not pre-action', async () => {
    let callCount = 0;
    const scope = {
      tabId: 'v24-tab',
      navigate: vi.fn().mockResolvedValue({ url: 'http://test', title: 'Test' }),
      click: vi.fn().mockResolvedValue({ clicked: true }),
      type: vi.fn().mockResolvedValue({ typed: true }),
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
      screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
      clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'button', role: null }),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('createTreeWalker')) {
          // First call (pre-action): no error text; second call (post-action): error text present
          callCount++;
          if (callCount === 1) return Promise.resolve({ value: { found: false } });
          return Promise.resolve({ value: { found: true, text: 'Something went wrong' } });
        }
        if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
        if (script.includes('durationMs') || script.includes('__bhMutStop')) return Promise.resolve({ value: { durationMs: 5 } });
        if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
        return Promise.resolve({ value: null });
      }),
    } as unknown as TabScope;

    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/error-toast')],
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
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'dom_error_text');
    expect(detected).toHaveLength(1);
    expect(detected[0].rootCause).toContain('Something went wrong');
  });

  it('does NOT emit dom_error_text when error text was already present pre-action', async () => {
    // Both pre and post return found:true → not the action's fault
    const scope = makeScope({ 'createTreeWalker': { found: true, text: 'Something went wrong' } });
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/static-error')],
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
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'dom_error_text');
    expect(detected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3.4 hydration_mismatch
// ---------------------------------------------------------------------------
describe('V24 plumbing — hydration_mismatch', () => {
  it('emits hydration_mismatch when __bhConsoleErrors contains a hydration error', async () => {
    const scope = makeScope({
      '__bhConsoleErrors': [{ level: 'error', text: 'Hydration failed because the initial UI does not match', stack: undefined }],
    });
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/hydration')],
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
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'hydration_mismatch');
    expect(detected).toHaveLength(1);
    expect(detected[0].pageRoute).toBe('/hydration');
  });

  it('emits console_error (not hydration_mismatch) for a plain non-React error', async () => {
    const scope = makeScope({
      '__bhConsoleErrors': [{ level: 'error', text: 'TypeError: Cannot read property of undefined', stack: undefined }],
    });
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/page')],
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
    const bugs = result.results.flatMap(r => r.bugs);
    expect(bugs.some(b => b.kind === 'console_error')).toBe(true);
    expect(bugs.some(b => b.kind === 'hydration_mismatch')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3.5 accessibility_critical delta
// ---------------------------------------------------------------------------
describe('V24 plumbing — accessibility_critical (delta path)', () => {
  it('emits accessibility_critical when a new critical violation appears post-action', async () => {
    let axeCallCount = 0;
    const scope = {
      tabId: 'v24-tab',
      navigate: vi.fn().mockResolvedValue({ url: 'http://test', title: 'Test' }),
      click: vi.fn().mockResolvedValue({ clicked: true }),
      type: vi.fn().mockResolvedValue({ typed: true }),
      scroll: vi.fn().mockResolvedValue({ scrolled: true }),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
      screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
      clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'button', role: null }),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('window.axe')) {
          axeCallCount++;
          if (axeCallCount === 1) {
            // onPageBaseline call: return existing violations
            return Promise.resolve({ value: { violations: [] } });
          }
          if (axeCallCount === 2) {
            // V24 pre-action axe: no violations
            return Promise.resolve({ value: { violations: [] } });
          }
          // V24 post-action axe: new critical violation
          return Promise.resolve({ value: { violations: [{ id: 'aria-name', impact: 'critical', description: 'Missing aria-name', nodes: [] }] } });
        }
        if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
        if (script.includes('durationMs') || script.includes('__bhMutStop')) return Promise.resolve({ value: { durationMs: 5 } });
        if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
        return Promise.resolve({ value: null });
      }),
    } as unknown as TabScope;

    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'accessibility_critical');
    expect(detected).toHaveLength(1);
    expect(detected[0].selectorClass).toBe('aria-name');
  });

  it('does NOT emit accessibility_critical when enableA11y is false', async () => {
    const scope = makeScope({ 'window.axe': { violations: [{ id: 'aria-name', impact: 'critical', description: 'Missing', nodes: [] }] } });
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      // enableA11y not set → delta does not run
    };

    const result = await runExecute(opts);
    const detected = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'accessibility_critical');
    expect(detected).toHaveLength(0);
  });
});
