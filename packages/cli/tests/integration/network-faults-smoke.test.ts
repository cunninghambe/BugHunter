// Integration smoke tests for v0.20 network-fault detectors.
// Proves that detectInfiniteLoading and detectOptimisticNoRevert fire end-to-end
// through runExecute when real spinner / optimistic-snapshot signals are wired.
// No live browser required — uses mocked TabScope.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from '../../src/phases/execute.js';
import type { ExecuteOptions } from '../../src/phases/execute.js';
import type { SurfaceMcpAdapter } from '../../src/adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../../src/adapters/browser-mcp.js';
import type { TestCase, RunState, NetworkFaultSpec } from '../../src/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'network-faults-smoke-run';
const OFFLINE_FAULT: NetworkFaultSpec = { kind: 'offline' };

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

function makeFaultTestCase(fault: NetworkFaultSpec = OFFLINE_FAULT): TestCase {
  return {
    id: 'tc-fault-1',
    runId: RUN_ID,
    role: 'user',
    page: '/todos',
    action: {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: 'button#submit',
    },
    expectedOutcome: 'success',
    palette: 'happy',
    faultInjected: fault,
  };
}

/**
 * Build a scope where CHECK_LOADING_SCRIPT returns spinnerValue.
 * snapshot() returns snapshotHtml.
 * All other evaluate scripts return safe defaults.
 */
function makeScope(opts: {
  spinnerValue: boolean;
  snapshotHtml?: string;
}): TabScope {
  const snap = opts.snapshotHtml ?? '<html><body><div class="todo-list"></div></body></html>';
  return {
    tabId: 'fault-tab',
    navigate: vi.fn().mockResolvedValue({ url: 'http://localhost/todos', title: 'Todos' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    // snapshot() is called three times: preSnapshot (ignored), optimistic snapshot, postSnapshot.
    snapshot: vi.fn().mockResolvedValue({ snapshot: snap }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue({
      ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'button', role: null,
    }),
    applyNetworkFault: vi.fn().mockResolvedValue({ applied: true }),
    clearNetworkFault: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((script: string) => {
      // CHECK_LOADING_SCRIPT is identified by its aria-busy selector content.
      if (script.includes('aria-busy')) return Promise.resolve({ value: opts.spinnerValue });
      if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
      if (script.includes('durationMs') || script.includes('__bhMutStop')) {
        return Promise.resolve({ value: { durationMs: 5 } });
      }
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-nf-smoke-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- infinite_loading detector ----

describe('v0.20 execute path — infinite_loading detector', () => {
  it('emits infinite_loading when spinner is absent pre-action and present post-action', async () => {
    // The evaluate mock always returns spinnerValue for aria-busy checks.
    // preHadSpinner = false (no spinner before) / postHasSpinner = true (spinner persists).
    // To simulate pre=false, post=true we use a sequence mock.
    let spinnerCallCount = 0;
    const scope: TabScope = {
      ...makeScope({ spinnerValue: false }),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('aria-busy')) {
          spinnerCallCount += 1;
          // First call: pre-action spinner check → false (no spinner)
          // Second call: post-action spinner check → true (spinner stuck)
          return Promise.resolve({ value: spinnerCallCount === 1 ? false : true });
        }
        if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
        if (script.includes('durationMs') || script.includes('__bhMutStop')) {
          return Promise.resolve({ value: { durationMs: 5 } });
        }
        if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
        if (script.includes('__bh_xss')) return Promise.resolve({ value: [] });
        return Promise.resolve({ value: null });
      }),
      applyNetworkFault: vi.fn().mockResolvedValue({ applied: true }),
      clearNetworkFault: vi.fn().mockResolvedValue(undefined),
    } as unknown as TabScope;

    const browser = makeBrowser(scope);
    const opts: ExecuteOptions = {
      testCases: [makeFaultTestCase()],
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
    const infiniteLoadBugs = bugs.filter(b => b.kind === 'infinite_loading');
    expect(infiniteLoadBugs).toHaveLength(1);
    expect(infiniteLoadBugs[0].networkFaultContext?.faultVariant).toBe('offline');
    expect(infiniteLoadBugs[0].networkFaultContext?.proof).toBe('spinner_persists');
  });

  it('does not emit infinite_loading when spinner was already present pre-action', async () => {
    // Both pre and post spinner = true → preHadSpinner blocks the detection.
    const scope = makeScope({ spinnerValue: true });
    const browser = makeBrowser(scope);
    const opts: ExecuteOptions = {
      testCases: [makeFaultTestCase()],
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
    const infiniteLoadBugs = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'infinite_loading');
    expect(infiniteLoadBugs).toHaveLength(0);
  });

  it('does not emit infinite_loading when no spinner is present post-action', async () => {
    // Both pre and post spinner = false → postHasSpinner=false blocks the detection.
    const scope = makeScope({ spinnerValue: false });
    const browser = makeBrowser(scope);
    const opts: ExecuteOptions = {
      testCases: [makeFaultTestCase()],
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
    const infiniteLoadBugs = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'infinite_loading');
    expect(infiniteLoadBugs).toHaveLength(0);
  });

  it('does not emit infinite_loading when no fault is injected', async () => {
    // Non-fault test case — spinner checks should not run.
    const tc: TestCase = {
      id: 'tc-no-fault',
      runId: RUN_ID,
      role: 'user',
      page: '/todos',
      action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: 'button#submit' },
      expectedOutcome: 'success',
      palette: 'happy',
    };
    const scope = makeScope({ spinnerValue: true });
    const browser = makeBrowser(scope);
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
    const infiniteLoadBugs = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'infinite_loading');
    expect(infiniteLoadBugs).toHaveLength(0);
  });
});

// ---- network_fault_optimistic_no_revert detector ----

describe('v0.20 execute path — network_fault_optimistic_no_revert detector', () => {
  it('emits network_fault_optimistic_no_revert when optimistic snapshot is non-empty and no revert', async () => {
    // snapshot() returns a non-empty HTML — the optimistic capture inside
    // executeUiTestInner will stash it on tc, and detectOptimisticNoRevert will fire.
    const snap = '<html><body><div class="todo-item">New todo</div></body></html>';
    const scope = makeScope({ spinnerValue: false, snapshotHtml: snap });
    const browser = makeBrowser(scope);
    const opts: ExecuteOptions = {
      testCases: [makeFaultTestCase()],
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
    const noRevertBugs = bugs.filter(b => b.kind === 'network_fault_optimistic_no_revert');
    expect(noRevertBugs).toHaveLength(1);
    expect(noRevertBugs[0].networkFaultContext?.faultVariant).toBe('offline');
    expect(noRevertBugs[0].networkFaultContext?.proof).toBe('optimistic_state_persisted');
  });

  it('does not emit network_fault_optimistic_no_revert when snapshot() returns empty', async () => {
    // Empty snapshot → optSnap.snapshot is '' → optimistic snapshot not stashed → null passed to detector.
    const scope = makeScope({ spinnerValue: false, snapshotHtml: '' });
    const browser = makeBrowser(scope);
    const opts: ExecuteOptions = {
      testCases: [makeFaultTestCase()],
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
    const noRevertBugs = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'network_fault_optimistic_no_revert');
    expect(noRevertBugs).toHaveLength(0);
  });

  it('does not emit network_fault_optimistic_no_revert when no fault is injected', async () => {
    const tc: TestCase = {
      id: 'tc-no-fault-2',
      runId: RUN_ID,
      role: 'user',
      page: '/todos',
      action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector: 'button#submit' },
      expectedOutcome: 'success',
      palette: 'happy',
    };
    const snap = '<html><body><div class="todo-item">New todo</div></body></html>';
    const scope = makeScope({ spinnerValue: false, snapshotHtml: snap });
    const browser = makeBrowser(scope);
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
    const noRevertBugs = result.results.flatMap(r => r.bugs).filter(b => b.kind === 'network_fault_optimistic_no_revert');
    expect(noRevertBugs).toHaveLength(0);
  });
});
