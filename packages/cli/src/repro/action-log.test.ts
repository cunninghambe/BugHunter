// Write-side fix: assert that action-logs written by execute.ts contain absolute URLs
// when appBaseUrl is provided and tc.page is relative.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from '../phases/execute.js';
import type { ExecuteOptions } from '../phases/execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { TestCase, RunState } from '../types.js';
import { readActionLog } from './action-log.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'action-log-url-test-run';
const APP_BASE_URL = 'http://localhost:3010';

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
    surface_call: vi.fn().mockResolvedValue({ ok: true, status: 200, body: {} }),
    surface_list_tools: vi.fn().mockResolvedValue({ tools: [] }),
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

function makeScope(): TabScope {
  return {
    tabId: 'test-tab',
    navigate: vi.fn().mockResolvedValue({ url: `${APP_BASE_URL}/login`, title: 'Login' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false, ariaLabelSource: null, tagName: 'a', role: null }),
    evaluate: vi.fn().mockImplementation((script: string) => {
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

function makeUiTestCase(page: string): TestCase {
  return {
    id: 'tc-url-1',
    runId: RUN_ID,
    role: 'user',
    page,
    action: {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: 'button',
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function makeApiTestCase(page: string): TestCase {
  return {
    id: 'tc-api-url-1',
    runId: RUN_ID,
    role: 'user',
    page,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'success',
      palette: 'happy',
      toolId: 'some_tool',
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-action-log-url-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('write-side: action-log records absolute URLs when appBaseUrl is set', () => {
  it('UI test: written action-log page and actions[0].url are absolute when tc.page is relative', async () => {
    const scope = makeScope();
    const browser = makeBrowser(scope);
    const tc = makeUiTestCase('/login');

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
      appBaseUrl: APP_BASE_URL,
    };

    const execResult = await runExecute(opts);
    const occurrenceId = execResult.results[0]?.occurrenceId;
    expect(occurrenceId).toBeDefined();

    const actionLogsDir = path.join(tmpDir, '.bughunter', 'runs', RUN_ID, 'action-logs');
    const written = readActionLog(actionLogsDir, occurrenceId!);

    expect(written.page).toBe(`${APP_BASE_URL}/login`);
    expect(written.baseUrl).toBe(`${APP_BASE_URL}/login`);
    expect(written.actions[0]?.url).toBe(`${APP_BASE_URL}/login`);
  });

  it('UI test: written action-log retains absolute URL unchanged when tc.page is already absolute', async () => {
    const scope = makeScope();
    const browser = makeBrowser(scope);
    const tc = makeUiTestCase(`${APP_BASE_URL}/dashboard`);

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
      appBaseUrl: APP_BASE_URL,
    };

    const execResult = await runExecute(opts);
    const occurrenceId = execResult.results[0]?.occurrenceId;
    expect(occurrenceId).toBeDefined();

    const actionLogsDir = path.join(tmpDir, '.bughunter', 'runs', RUN_ID, 'action-logs');
    const written = readActionLog(actionLogsDir, occurrenceId!);

    expect(written.page).toBe(`${APP_BASE_URL}/dashboard`);
    expect(written.actions[0]?.url).toBe(`${APP_BASE_URL}/dashboard`);
  });

  it('API test: written action-log page and actions[0].url are absolute when tc.page is relative', async () => {
    const tc = makeApiTestCase('/api/items');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeMinimalSurface(),
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      appBaseUrl: APP_BASE_URL,
    };

    const execResult = await runExecute(opts);
    const occurrenceId = execResult.results[0]?.occurrenceId;
    expect(occurrenceId).toBeDefined();

    const actionLogsDir = path.join(tmpDir, '.bughunter', 'runs', RUN_ID, 'action-logs');
    const written = readActionLog(actionLogsDir, occurrenceId!);

    expect(written.page).toBe(`${APP_BASE_URL}/api/items`);
    expect(written.actions[0]?.url).toBe(`${APP_BASE_URL}/api/items`);
  });
});
