/**
 * Integration test: axe-core injection pipeline.
 *
 * Smoke #12 finding: 168 UI tests on self-spa + 298 on v24-deferred-bugs emitted
 * 0 a11y BugKinds. Root cause: AXE_INJECT_SCRIPT was never evaluated before
 * AXE_RUN_SCRIPT, so window.axe was always undefined and the scan silently
 * returned { violations: [] }.
 *
 * Fix (#165): inject axe via script-tag evaluate() instead of addInitScript(),
 * bypassing camofox-mcp's 256 KB init_script size limit (axe.min.js is ~564 KB).
 *
 * These tests verify:
 *   1. AXE_INJECT_SCRIPT is a non-empty string containing real axe-core source.
 *   2. The execute phase calls ensureAxeLoaded (via evaluate, not addInitScript)
 *      before the baseline scan.
 *   3. Violations returned by axe flow through to image_missing_alt and
 *      form_input_unlabeled BugKinds in the a11yBaselineDetections output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AXE_INJECT_SCRIPT, AXE_RUN_SCRIPT } from '../../src/classify/accessibility.js';
import { runExecute } from '../../src/phases/execute.js';
import type { ExecuteOptions } from '../../src/phases/execute.js';
import type { BrowserMcpAdapter, TabScope } from '../../src/adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../../src/adapters/surface-mcp.js';
import type { TestCase, RunState } from '../../src/types.js';

const RUN_ID = 'axe-injection-test-run';

// ---------------------------------------------------------------------------
// § 1: AXE_INJECT_SCRIPT is non-empty and contains axe-core
// ---------------------------------------------------------------------------

describe('AXE_INJECT_SCRIPT module export', () => {
  it('is a non-empty string', () => {
    expect(typeof AXE_INJECT_SCRIPT).toBe('string');
    expect(AXE_INJECT_SCRIPT.length).toBeGreaterThan(1000);
  });

  it('wraps window.axe guard so double-inject is safe', () => {
    expect(AXE_INJECT_SCRIPT).toContain('window.axe');
  });

  it('contains axe-core source (axe.run signature)', () => {
    // axe.min.js defines axe.run — presence confirms the source was bundled
    expect(AXE_INJECT_SCRIPT).toContain('axe.run');
  });
});

describe('AXE_RUN_SCRIPT', () => {
  it('checks window.axe before running', () => {
    expect(AXE_RUN_SCRIPT).toContain('window.axe');
  });
});

// ---------------------------------------------------------------------------
// Helpers matching the pattern in execute.v24.test.ts
// ---------------------------------------------------------------------------

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
    surface_list_pages: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_describe_self: vi.fn(),
    surface_describe_auth: vi.fn(),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

function makeTestCase(page = '/a11y-test'): TestCase {
  return {
    id: 'tc-axe',
    runId: RUN_ID,
    role: 'anonymous',
    page,
    action: {
      kind: 'navigate',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: page,
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

/**
 * Build a scope mock where axe is not pre-loaded.
 * The presence check returns false on first call, then axe run returns violations.
 * This simulates the real scenario where addInitScript failed silently.
 */
function makeScopeAxeAbsent(violations: unknown[]): {
  scope: TabScope;
  evaluateCalls: string[];
} {
  const evaluateCalls: string[] = [];

  const scope: TabScope = {
    tabId: 'axe-test-tab',
    navigate: vi.fn().mockResolvedValue({ url: 'http://localhost:3100/a11y-test', title: 'Test' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'a', role: null }),
    evaluate: vi.fn().mockImplementation((script: string) => {
      evaluateCalls.push(script.slice(0, 80));
      // ensureAxeLoaded uses bracket notation window['axe'] to avoid matching axe-run scripts
      if (script.includes("window['axe']")) return Promise.resolve({ value: false });
      // ensureAxeLoaded: script-tag injection
      if (script.includes('document.createElement')) return Promise.resolve({ value: null });
      // AXE_RUN_SCRIPT / AXE_RUN_SCRIPT_MOBILE (use dot notation window.axe)
      if (script.includes('window.axe')) return Promise.resolve({ value: { violations } });
      if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
      if (script.includes('durationMs') || script.includes('__bhMutStop')) return Promise.resolve({ value: { durationMs: 5 } });
      if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
      if (script.includes('__bh_xss')) return Promise.resolve({ value: [] });
      return Promise.resolve({ value: null });
    }),
  } as unknown as TabScope;

  return { scope, evaluateCalls };
}

/** Build a scope mock that simulates axe already loaded (SPA reuse path). */
function makeScopeAxePresent(violations: unknown[]): {
  scope: TabScope;
  evaluateCalls: string[];
} {
  const evaluateCalls: string[] = [];

  const scope: TabScope = {
    tabId: 'axe-test-tab',
    navigate: vi.fn().mockResolvedValue({ url: 'http://localhost:3100/a11y-test', title: 'Test' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'a', role: null }),
    evaluate: vi.fn().mockImplementation((script: string) => {
      evaluateCalls.push(script.slice(0, 80));
      // ensureAxeLoaded uses bracket notation — axe is already there, short-circuit
      if (script.includes("window['axe']")) return Promise.resolve({ value: true });
      // AXE_RUN_SCRIPT / AXE_RUN_SCRIPT_MOBILE
      if (script.includes('window.axe')) return Promise.resolve({ value: { violations } });
      if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
      if (script.includes('durationMs') || script.includes('__bhMutStop')) return Promise.resolve({ value: { durationMs: 5 } });
      if (script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
      if (script.includes('__bh_xss')) return Promise.resolve({ value: [] });
      return Promise.resolve({ value: null });
    }),
  } as unknown as TabScope;

  return { scope, evaluateCalls };
}

function makeBrowser(scope: TabScope): BrowserMcpAdapter {
  return {
    withTab: vi.fn().mockImplementation(
      (_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(scope),
    ),
    addInitScript: vi.fn().mockResolvedValue({ applied: true }),
  } as unknown as BrowserMcpAdapter;
}

// ---------------------------------------------------------------------------
// § 2: Execute phase injects axe via evaluate() and emits a11y BugKinds
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-axe-inject-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network', 'perf']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const IMG_ALT_VIOLATION = {
  id: 'image-alt',
  impact: 'critical',
  description: 'Images must have alternate text',
  nodes: [
    { target: ['img.logo'], html: '<img src="/logo.png" class="logo">' },
    { target: ['img:nth-child(2)'], html: '<img src="/banner.jpg">' },
  ],
};

const LABEL_VIOLATION = {
  id: 'label',
  impact: 'critical',
  description: 'Form elements must have labels',
  nodes: [
    { target: ['input[name="search"]'], html: '<input type="text" name="search">' },
    { target: ['select[name="filter"]'], html: '<select name="filter"></select>' },
  ],
};

describe('execute phase: axe injection fires before baseline scan', () => {
  it('calls scope.evaluate with script-tag injection when enableA11y is true and axe is absent', async () => {
    const { scope, evaluateCalls } = makeScopeAxeAbsent([]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    await runExecute(opts);

    // evaluate must have been called with the presence check (bracket notation)
    expect(evaluateCalls.some(c => c.includes("window['axe']"))).toBe(true);
    // evaluate must have been called with the script-tag injection (axe absent → inject)
    expect(evaluateCalls.some(c => c.includes('document.createElement'))).toBe(true);
    // addInitScript must NOT be called (bypassed for size limit fix)
    expect(browser.addInitScript).not.toHaveBeenCalled();
  });

  it('does NOT call evaluate with script-tag injection when axe is already present', async () => {
    const { scope, evaluateCalls } = makeScopeAxePresent([]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    await runExecute(opts);

    // presence check is called (bracket notation)
    expect(evaluateCalls.some(c => c.includes("window['axe']"))).toBe(true);
    // script-tag injection is skipped (axe already present)
    expect(evaluateCalls.some(c => c.includes('document.createElement'))).toBe(false);
  });

  it('does NOT call evaluate with axe injection when enableA11y is false', async () => {
    const { scope, evaluateCalls } = makeScopeAxeAbsent([]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: false,
    };

    await runExecute(opts);
    expect(evaluateCalls.some(c => c.includes("window['axe']"))).toBe(false);
    expect(evaluateCalls.some(c => c.includes('document.createElement'))).toBe(false);
  });

  it('emits image_missing_alt when img-without-alt violations are returned', async () => {
    const { scope } = makeScopeAxeAbsent([IMG_ALT_VIOLATION]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    const out = await runExecute(opts);
    const baseline = out.a11yBaselineDetections ?? [];
    const imgBugs = baseline.filter(d => d.kind === 'image_missing_alt');
    expect(imgBugs.length).toBeGreaterThanOrEqual(1);
    expect(imgBugs[0].pageRoute).toBe('/a11y-test');
  });

  it('emits form_input_unlabeled when label violations are returned', async () => {
    const { scope } = makeScopeAxeAbsent([LABEL_VIOLATION]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    const out = await runExecute(opts);
    const baseline = out.a11yBaselineDetections ?? [];
    const labelBugs = baseline.filter(d => d.kind === 'form_input_unlabeled');
    expect(labelBugs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits both image_missing_alt and form_input_unlabeled on a page with both violations', async () => {
    const { scope } = makeScopeAxeAbsent([IMG_ALT_VIOLATION, LABEL_VIOLATION]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: true,
    };

    const out = await runExecute(opts);
    const baseline = out.a11yBaselineDetections ?? [];
    const kinds = new Set(baseline.map(d => d.kind));
    expect(kinds.has('image_missing_alt')).toBe(true);
    expect(kinds.has('form_input_unlabeled')).toBe(true);
  });

  it('emits zero a11y baseline detections when enableA11y is false', async () => {
    const { scope } = makeScopeAxeAbsent([IMG_ALT_VIOLATION, LABEL_VIOLATION]);
    const browser = makeBrowser(scope);

    const opts: ExecuteOptions = {
      testCases: [makeTestCase('/a11y-test')],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 30000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      enableA11y: false,
    };

    const out = await runExecute(opts);
    const baseline = out.a11yBaselineDetections ?? [];
    expect(baseline.filter(d => d.kind === 'image_missing_alt')).toHaveLength(0);
    expect(baseline.filter(d => d.kind === 'form_input_unlabeled')).toHaveLength(0);
  });
});
