// Integration tests for XSS canary detection in executeApiTest and executeUiTestInner (v0.7 Task X3).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { TestCase, RunState } from '../types.js';
import { generateCanaries } from '../security/injection-palette.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeRunState(projectDir: string): RunState {
  return {
    runId: 'xss-test-run',
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

function makeMinimalSurface(callMock: ReturnType<typeof vi.fn>): SurfaceMcpAdapter {
  return {
    surface_call: callMock,
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

function makeApiTestCase(nonce: string, canaryValue: string, runId: string): TestCase {
  return {
    id: 'tc-api-xss',
    runId,
    role: 'user',
    page: '/api/echo',
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'expected_failure',
      palette: 'xss_inject',
      toolId: 'echo-tool',
      input: { q: canaryValue },
      injectionNonce: nonce,
    },
    expectedOutcome: 'expected_failure',
    palette: 'xss_inject',
  };
}

function makeUiTestCase(nonce: string, canaryValue: string, runId: string): TestCase {
  return {
    id: 'tc-ui-xss',
    runId,
    role: 'user',
    page: '/search',
    action: {
      kind: 'submit',
      via: 'ui',
      expectedOutcome: 'expected_failure',
      palette: 'xss_inject',
      selector: 'form button[type=submit]',
      input: { q: canaryValue },
      injectionNonce: nonce,
    },
    expectedOutcome: 'expected_failure',
    palette: 'xss_inject',
  };
}

describe('executeApiTest — XSS reflection detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-xss-test-'));
    for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
      fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', 'xss-test-run', sub), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits xss_reflected when surface_call returns body containing the canary as HTML tag', async () => {
    const [canary] = generateCanaries('minimal');
    // Simulate a vulnerable /echo endpoint: returns <div>${q}</div> unescaped
    const echoBody = `<div>${canary.value}</div>`;
    const callMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: echoBody,
      durationMs: 10,
      revisionAtCall: 1,
    });
    const surface = makeMinimalSurface(callMock);
    const tc = makeApiTestCase(canary.nonce, canary.value, 'xss-test-run');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const xssDetections = result.results
      .flatMap(r => r.bugs)
      .filter(b => b.kind === 'xss_reflected');

    expect(xssDetections.length).toBeGreaterThanOrEqual(1);
    expect(xssDetections[0]?.xssContext?.nonce).toBe(canary.nonce);
  });

  it('does not emit xss_reflected when surface_call returns safely-escaped body', async () => {
    const [canary] = generateCanaries('minimal');
    // HTML-encoded — not executable
    const safeBody = `<div>&lt;script&gt;window.__bh_xss_${canary.nonce}=1&lt;/script&gt;</div>`;
    const callMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: safeBody,
      durationMs: 10,
      revisionAtCall: 1,
    });
    const surface = makeMinimalSurface(callMock);
    const tc = makeApiTestCase(canary.nonce, canary.value, 'xss-test-run');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const xssDetections = result.results
      .flatMap(r => r.bugs)
      .filter(b => b.kind === 'xss_reflected');

    expect(xssDetections).toHaveLength(0);
  });

  it('does not emit xss_reflected when test case has no injectionNonce', async () => {
    const callMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: '<script>window.__bh_xss_someNonce=1</script>',
      durationMs: 10,
      revisionAtCall: 1,
    });
    const surface = makeMinimalSurface(callMock);
    const tc: TestCase = {
      id: 'tc-no-nonce',
      runId: 'xss-test-run',
      role: 'user',
      page: '/api/echo',
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'success',
        palette: 'happy',
        toolId: 'echo-tool',
        input: { q: 'hello' },
        // no injectionNonce
      },
      expectedOutcome: 'success',
      palette: 'happy',
    };

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const xssDetections = result.results
      .flatMap(r => r.bugs)
      .filter(b => b.kind === 'xss_reflected');

    expect(xssDetections).toHaveLength(0);
  });
});

describe('executeUiTestInner — XSS DOM detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-xss-ui-test-'));
    for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
      fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', 'xss-test-run', sub), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits xss_dom when observer drain returns a fired entry', async () => {
    const [canary] = generateCanaries('minimal');
    const scope = {
      tabId: 'test-tab',
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
      screenshot: vi.fn().mockResolvedValue(undefined),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
      evaluate: vi.fn().mockImplementation((script: string) => {
        // Start script: no-op
        if (script.includes('__bh_xss_installed')) return Promise.resolve({ value: undefined });
        // MutationObserver start: no-op
        if (script.includes('MUTATION_OBSERVER') || script.includes('__bhMutStart')) return Promise.resolve({ value: { durationMs: 0 } });
        // MutationObserver stop
        if (script.includes('__bhMutStop') || script.includes('durationMs')) return Promise.resolve({ value: { durationMs: 5 } });
        // Console errors
        if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
        // XSS drain: return fired entry
        if (script.includes('__bh_xss instanceof Map')) {
          return Promise.resolve({ value: [{ nonce: canary.nonce, fired: true, sink: 'dom_inserted' }] });
        }
        return Promise.resolve({ value: null });
      }),
    } as unknown as TabScope;
    const browser: BrowserMcpAdapter = {
      withTab: vi.fn().mockImplementation((_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(scope)),
    } as unknown as BrowserMcpAdapter;

    const tc = makeUiTestCase(canary.nonce, canary.value, 'xss-test-run');
    const surface = makeMinimalSurface(vi.fn());

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface,
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const xdsDom = result.results
      .flatMap(r => r.bugs)
      .filter(b => b.kind === 'xss_dom');

    expect(xdsDom.length).toBeGreaterThanOrEqual(1);
    expect(xdsDom[0]?.xssContext?.nonce).toBe(canary.nonce);
    expect(xdsDom[0]?.xssContext?.sink).toBe('dom_inserted');
  });

  it('emits xss_reflected when post-snapshot HTML contains the canary', async () => {
    const [canary] = generateCanaries('minimal');
    const vulnHtml = `<html><body><div>${canary.value}</div></body></html>`;

    const scope = {
      tabId: 'test-tab',
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ snapshot: vulnHtml }),
      screenshot: vi.fn().mockResolvedValue(undefined),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('__bh_xss_installed')) return Promise.resolve({ value: undefined });
        if (script.includes('__bhConsoleErrors')) return Promise.resolve({ value: [] });
        if (script.includes('__bh_xss instanceof Map')) return Promise.resolve({ value: [] });
        return Promise.resolve({ value: { durationMs: 0 } });
      }),
    } as unknown as TabScope;
    const browser: BrowserMcpAdapter = {
      withTab: vi.fn().mockImplementation((_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(scope)),
    } as unknown as BrowserMcpAdapter;

    const tc = makeUiTestCase(canary.nonce, canary.value, 'xss-test-run');
    const surface = makeMinimalSurface(vi.fn());

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface,
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);
    const xssReflected = result.results
      .flatMap(r => r.bugs)
      .filter(b => b.kind === 'xss_reflected');

    expect(xssReflected.length).toBeGreaterThanOrEqual(1);
    expect(xssReflected[0]?.xssContext?.nonce).toBe(canary.nonce);
  });
});
