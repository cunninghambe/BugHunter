// Tests for mid-run session-expiry detection and recovery in runExecute.
//
// When a browser tab navigates to a protected page but the session has expired,
// the app redirects to /login. executeUiTest detects this via location.href evaluation
// and returns a sentinel infrastructureFailure. runExecute strips the infra failure,
// records a 'session_expired' skip reason, and triggers re-login (once per role).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter, DescribeAuthResult } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { TestCase, RunState } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'session-recovery-test-run';

function makeRunState(projectDir: string, appBaseUrl = 'http://localhost:3002'): RunState {
  return {
    runId: RUN_ID,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
      appBaseUrl,
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeSurface(loginResult: DescribeAuthResult = { authKind: 'none', reason: 'no_auth_configured' }): SurfaceMcpAdapter {
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
    surface_describe_auth: vi.fn().mockResolvedValue(loginResult),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

function makeTestCase(page = '/dashboard'): TestCase {
  return {
    id: 'tc-session-1',
    runId: RUN_ID,
    role: 'owner',
    page,
    action: {
      kind: 'click',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      selector: 'button[data-testid="action"]',
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

/**
 * Make a TabScope where location.href returns the given url.
 * All evaluate calls not explicitly mocked return null.
 */
function makeScope(landedUrl: string): TabScope {
  return {
    tabId: 'test-tab',
    navigate: vi.fn().mockResolvedValue({ url: landedUrl }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    clickWithObservation: vi.fn().mockResolvedValue({ ok: true, accessibleNameAbsent: false }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html><body></body></html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '', data: '' }),
    clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script === 'location.href') return Promise.resolve({ value: landedUrl });
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
    navigate: vi.fn().mockResolvedValue({ url: '' }),
    cookies: vi.fn().mockResolvedValue({ tabId: 'test', cookies: [] }),
    evaluate: vi.fn().mockResolvedValue({ value: null }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '' }),
  } as unknown as BrowserMcpAdapter;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-session-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-expiry recovery', () => {
  it('detects session expiry when tab lands on /login instead of the test page', async () => {
    const scope = makeScope('http://localhost:3002/login');
    const browser = makeBrowser(scope);
    const tc = makeTestCase('/dashboard');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);

    // Must record a session_expired skip reason.
    const sessionExpiredReason = result.skipReasons.find(r => r.reason === 'session_expired');
    expect(sessionExpiredReason).toBeDefined();
    expect(sessionExpiredReason?.count).toBe(1);
  });

  it('does not increment consecutiveInfraFailures for session-expiry skips', async () => {
    const scope = makeScope('http://localhost:3002/login');
    const browser = makeBrowser(scope);
    const tc = makeTestCase('/dashboard');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);

    // The session-expired result must not have an infrastructureFailure (stripped by recovery handler).
    for (const r of result.results) {
      expect(r.infrastructureFailure).toBeUndefined();
    }
  });

  it('does not trigger re-login for a second test with the same expired role', async () => {
    const scope = makeScope('http://localhost:3002/login');
    const browser = makeBrowser(scope);
    const surface = makeSurface();
    const tc1 = makeTestCase('/dashboard');
    const tc2 = { ...makeTestCase('/settings'), id: 'tc-session-2' };

    const opts: ExecuteOptions = {
      testCases: [tc1, tc2],
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

    // Both tests get session_expired skipped.
    const sessionExpiredReason = result.skipReasons.find(r => r.reason === 'session_expired');
    expect(sessionExpiredReason?.count).toBe(2);

    // surface_describe_auth is called at most once (for the re-login attempt, not once per test).
    const describeCalls = (surface.surface_describe_auth as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(describeCalls).toBeLessThanOrEqual(1);
  });

  it('does not flag session expiry when the test page itself is /login', async () => {
    const scope = makeScope('http://localhost:3002/login');
    const browser = makeBrowser(scope);
    const tc = makeTestCase('/login');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);

    // No session_expired skip reason.
    const sessionExpiredReason = result.skipReasons.find(r => r.reason === 'session_expired');
    expect(sessionExpiredReason).toBeUndefined();
  });

  it('does not flag session expiry when the landed URL is the expected page', async () => {
    const scope = makeScope('http://localhost:3002/dashboard');
    const browser = makeBrowser(scope);
    const tc = makeTestCase('/dashboard');

    const opts: ExecuteOptions = {
      testCases: [tc],
      runState: makeRunState(tmpDir),
      surface: makeSurface(),
      browser,
      maxBugs: 50,
      maxRuntimeMs: 60000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);

    const sessionExpiredReason = result.skipReasons.find(r => r.reason === 'session_expired');
    expect(sessionExpiredReason).toBeUndefined();
  });
});
