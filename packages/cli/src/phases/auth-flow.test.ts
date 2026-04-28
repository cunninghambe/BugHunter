// Unit tests for auth-flow phase (v0.7 Task A2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAuthFlow, extractResetToken } from './auth-flow.js';
import type { AuthFlowOptions } from './auth-flow.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter, TabScope } from '../adapters/browser-mcp.js';
import type { RunState } from '../types.js';

// Mock loginInBrowser so session-fixation tests don't depend on the full browser flow
vi.mock('../discovery/browser-login.js', () => ({
  loginInBrowser: vi.fn().mockResolvedValue({ ok: true, cookies: [], finalUrl: 'http://localhost:3002/dashboard' }),
}));

function makeRunState(overrides: Partial<RunState['config']> = {}): RunState {
  return {
    runId: 'auth-test-run',
    projectDir: '/tmp/auth-test',
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
      roles: ['user'],
      ...overrides,
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeMinimalSurface(mocks: Partial<SurfaceMcpAdapter> = {}): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn(),
    surface_call: vi.fn(),
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
    ...mocks,
  } as unknown as SurfaceMcpAdapter;
}

function makeOpts(
  configOverrides: Partial<RunState['config']> = {},
  surfaceMocks: Partial<SurfaceMcpAdapter> = {},
  browser?: BrowserMcpAdapter,
): AuthFlowOptions {
  return {
    runState: makeRunState(configOverrides),
    surface: makeMinimalSurface(surfaceMocks),
    browser,
    appBaseUrl: 'http://localhost:3002',
    roles: ['user'],
    maxClusters: 50,
    onClusterFound: () => 0,
  };
}

describe('runAuthFlow — disabled by default', () => {
  it('returns disabled abort reason when authFlow.enabled is not set', async () => {
    const result = await runAuthFlow(makeOpts());
    expect(result.abortReason).toBe('disabled');
    expect(result.detections).toHaveLength(0);
  });

  it('returns disabled when authFlow.enabled is false', async () => {
    const result = await runAuthFlow(makeOpts({ authFlow: { enabled: false } }));
    expect(result.abortReason).toBe('disabled');
  });

  it('runs when authFlow.enabled is true', async () => {
    const result = await runAuthFlow(makeOpts({ authFlow: { enabled: true, checks: [] } }));
    expect(result.abortReason).toBeUndefined();
    expect(result.detections).toHaveLength(0);
  });
});

describe('checkSessionFixation', () => {
  it('emits auth_session_fixation when pre/post cookie values match', async () => {
    const COOKIE = 'SAME_SESSION_VALUE_12345678';

    const mockScope = {
      tabId: 'test',
      evaluate: vi.fn().mockResolvedValue({ value: `tj_sess=${COOKIE}` }),
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html></html>' }),
      screenshot: vi.fn().mockResolvedValue(undefined),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    } as unknown as TabScope;

    const mockBrowser: BrowserMcpAdapter = {
      withTab: vi.fn().mockImplementation(async (_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(mockScope)),
    } as unknown as BrowserMcpAdapter;

    const mockSurface = makeMinimalSurface({
      surface_describe_auth: vi.fn().mockResolvedValue({
        authKind: 'form',
        uiLoginPath: '/auth/login',
        fields: { email: 'email', password: 'password' },
        values: { email: 'test@test.com', password: 'pass' },
        successCheck: { kind: 'cookie', name: 'tj_sess' },
        cookieName: 'tj_sess',
      }),
      surface_login_status: vi.fn().mockResolvedValue({ authenticated: true, refreshCount: 0 }),
    });

    const opts = makeOpts(
      { authFlow: { enabled: true, checks: ['session_fixation'] } },
      {},
      mockBrowser,
    );
    opts.surface = mockSurface;

    const result = await runAuthFlow(opts);
    const fixations = result.detections.filter(d => d.detection.kind === 'auth_session_fixation');
    expect(fixations.length).toBeGreaterThanOrEqual(1);
    expect(fixations[0]?.detection.authFlowContext?.cookieName).toBe('tj_sess');
    expect(fixations[0]?.detection.authFlowContext?.preValuePrefix).toBe(postValuePrefix(COOKIE));
  });

  it('does NOT fire when pre/post cookie values differ', async () => {
    let callCount = 0;
    const mockScope = {
      tabId: 'test',
      evaluate: vi.fn().mockImplementation(() => {
        callCount++;
        // First call: pre-login value; second call: post-login value
        return Promise.resolve({ value: `tj_sess=${callCount === 1 ? 'BEFORE_1234' : 'AFTER_5678'}` });
      }),
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      scroll: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ snapshot: '<html></html>' }),
      screenshot: vi.fn().mockResolvedValue(undefined),
      clickByHint: vi.fn().mockResolvedValue({ clicked: false }),
    } as unknown as TabScope;

    const mockBrowser: BrowserMcpAdapter = {
      withTab: vi.fn().mockImplementation(async (_url: string, _headers: unknown, fn: (scope: TabScope) => Promise<unknown>) => fn(mockScope)),
    } as unknown as BrowserMcpAdapter;

    const mockSurface = makeMinimalSurface({
      surface_describe_auth: vi.fn().mockResolvedValue({
        authKind: 'form',
        uiLoginPath: '/auth/login',
        fields: {},
        values: {},
        successCheck: { kind: 'cookie', name: 'tj_sess' },
        cookieName: 'tj_sess',
      }),
      surface_login_status: vi.fn().mockResolvedValue({ authenticated: true, refreshCount: 0 }),
    });

    const opts = makeOpts(
      { authFlow: { enabled: true, checks: ['session_fixation'] } },
      {},
      mockBrowser,
    );
    opts.surface = mockSurface;

    const result = await runAuthFlow(opts);
    const fixations = result.detections.filter(d => d.detection.kind === 'auth_session_fixation');
    expect(fixations).toHaveLength(0);
  });

  it('skips when no browser adapter is provided', async () => {
    const opts = makeOpts({ authFlow: { enabled: true, checks: ['session_fixation'] } });
    const result = await runAuthFlow(opts);
    expect(result.detections.filter(d => d.detection.kind === 'auth_session_fixation')).toHaveLength(0);
  });

  it('skips when auth kind is not form-based', async () => {
    const mockBrowser = { withTab: vi.fn() } as unknown as BrowserMcpAdapter;
    const mockSurface = makeMinimalSurface({
      surface_describe_auth: vi.fn().mockResolvedValue({ authKind: 'bearer', reason: 'programmatic_only', detail: 'api key' }),
    });
    const opts = makeOpts({ authFlow: { enabled: true, checks: ['session_fixation'] } }, {}, mockBrowser);
    opts.surface = mockSurface;
    const result = await runAuthFlow(opts);
    expect(result.detections.filter(d => d.detection.kind === 'auth_session_fixation')).toHaveLength(0);
  });
});

describe('checkPasswordResetReuse', () => {
  it('emits password_reset_token_reuse when token is consumed twice successfully', async () => {
    let callIdx = 0;
    const callMock = vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({ ok: true, status: 200, body: { token: 'reset-token-aaa' }, durationMs: 5, revisionAtCall: 1 });
      if (callIdx === 2) return Promise.resolve({ ok: true, status: 200, body: { token: 'reset-token-bbb' }, durationMs: 5, revisionAtCall: 1 });
      // Both consume calls succeed
      return Promise.resolve({ ok: true, status: 200, body: {}, durationMs: 5, revisionAtCall: 1 });
    });
    const opts = makeOpts({
      authFlow: {
        enabled: true,
        checks: ['password_reset_reuse'],
        requestResetToolId: 'request-reset',
        consumeResetToolId: 'consume-reset',
      },
    }, { surface_call: callMock });

    const result = await runAuthFlow(opts);
    const reuseDetections = result.detections.filter(d => d.detection.kind === 'password_reset_token_reuse');
    expect(reuseDetections.length).toBeGreaterThanOrEqual(1);
    expect(reuseDetections[0]?.detection.authFlowContext?.reuseCount).toBe(2);
  });

  it('does NOT fire when second consume returns 4xx', async () => {
    let callIdx = 0;
    const callMock = vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({ ok: true, status: 200, body: { token: 'reset-token-aaa' }, durationMs: 5, revisionAtCall: 1 });
      if (callIdx === 2) return Promise.resolve({ ok: true, status: 200, body: { token: 'reset-token-bbb' }, durationMs: 5, revisionAtCall: 1 });
      if (callIdx === 3) return Promise.resolve({ ok: true, status: 200, body: {}, durationMs: 5, revisionAtCall: 1 });
      // Second consume fails (token already used)
      return Promise.resolve({ ok: false, status: 410, body: {}, durationMs: 5, revisionAtCall: 1 });
    });
    const opts = makeOpts({
      authFlow: {
        enabled: true,
        checks: ['password_reset_reuse'],
        requestResetToolId: 'request-reset',
        consumeResetToolId: 'consume-reset',
      },
    }, { surface_call: callMock });

    const result = await runAuthFlow(opts);
    const reuseDetections = result.detections.filter(d => d.detection.kind === 'password_reset_token_reuse');
    expect(reuseDetections).toHaveLength(0);
  });

  it('skips when toolIds are not configured', async () => {
    const opts = makeOpts({ authFlow: { enabled: true, checks: ['password_reset_reuse'] } });
    const result = await runAuthFlow(opts);
    expect(result.detections.filter(d => d.detection.kind === 'password_reset_token_reuse')).toHaveLength(0);
  });

  it('emits when same token returned twice', async () => {
    let callIdx = 0;
    const callMock = vi.fn().mockImplementation(() => {
      callIdx++;
      // Both request-reset calls return the same token
      if (callIdx <= 2) return Promise.resolve({ ok: true, status: 200, body: { token: 'same-token-12345' }, durationMs: 5, revisionAtCall: 1 });
      return Promise.resolve({ ok: true, status: 200, body: {}, durationMs: 5, revisionAtCall: 1 });
    });
    const opts = makeOpts({
      authFlow: {
        enabled: true,
        checks: ['password_reset_reuse'],
        requestResetToolId: 'request-reset',
        consumeResetToolId: 'consume-reset',
      },
    }, { surface_call: callMock });

    const result = await runAuthFlow(opts);
    const reuseDetections = result.detections.filter(d => d.detection.kind === 'password_reset_token_reuse');
    expect(reuseDetections.length).toBeGreaterThanOrEqual(1);
    expect(reuseDetections[0]?.detection.authFlowContext?.reuseCount).toBe(0);
  });
});

describe('open_redirect sub-check', () => {
  it('skips when no candidate URLs and no discovery pages match', async () => {
    const opts = makeOpts({ authFlow: { enabled: true, checks: ['open_redirect'] } });
    // No pages in discovery — no probes; no fetch calls
    const result = await runAuthFlow(opts);
    const openRedirects = result.detections.filter(d => d.detection.kind === 'open_redirect');
    expect(openRedirects).toHaveLength(0);
  });
});

describe('extractResetToken', () => {
  it('extracts token from object with token key', () => {
    expect(extractResetToken({ token: 'abc12345' })).toBe('abc12345');
  });

  it('extracts resetToken from nested data object', () => {
    expect(extractResetToken({ data: { resetToken: 'def67890' } })).toBe('def67890');
  });

  it('extracts token from JSON string body', () => {
    expect(extractResetToken('{"token": "ghi11122"}')).toBe('ghi11122');
  });

  it('returns null for object without token', () => {
    expect(extractResetToken({ status: 'ok' })).toBeNull();
  });

  it('returns null for null', () => {
    expect(extractResetToken(null)).toBeNull();
  });

  it('returns null for object with token shorter than 8 chars', () => {
    expect(extractResetToken({ token: 'short' })).toBeNull();
  });

  it('extracts reset_token (underscore format)', () => {
    expect(extractResetToken({ reset_token: 'validtoken1234' })).toBe('validtoken1234');
  });
});

// Helper to truncate to 8 chars as done in the detection
function postValuePrefix(val: string): string {
  return val.slice(0, 8);
}
