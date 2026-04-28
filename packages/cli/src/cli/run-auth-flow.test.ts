// Integration tests for auth-flow wiring in the run pipeline (v0.7 Task A3).

import { describe, it, expect, vi } from 'vitest';
import { runAuthFlow } from '../phases/auth-flow.js';
import type { RunState } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { AuthFlowOptions } from '../phases/auth-flow.js';

function makeRunState(configOverrides: Partial<RunState['config']> = {}): RunState {
  return {
    runId: 'run-auth-test',
    projectDir: '/tmp/run-auth-test',
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
      roles: ['user'],
      ...configOverrides,
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
): AuthFlowOptions {
  return {
    runState: makeRunState(configOverrides),
    surface: makeMinimalSurface(surfaceMocks),
    appBaseUrl: 'http://localhost:3002',
    roles: ['user'],
    maxClusters: 50,
    onClusterFound: () => 0,
  };
}

describe('runAuthFlow pipeline wiring', () => {
  it('returns empty detections and testCases when disabled', async () => {
    const result = await runAuthFlow(makeOpts());
    expect(result.detections).toHaveLength(0);
    expect(result.testCases).toHaveLength(0);
    expect(result.abortReason).toBe('disabled');
  });

  it('returns empty detections when enabled but no checks configured', async () => {
    const result = await runAuthFlow(makeOpts({ authFlow: { enabled: true, checks: [] } }));
    expect(result.detections).toHaveLength(0);
    expect(result.testCases).toHaveLength(0);
    expect(result.abortReason).toBeUndefined();
  });

  it('detections reach the result when password reset reuse fires', async () => {
    let callIdx = 0;
    const callMock = vi.fn().mockImplementation(() => {
      callIdx++;
      // Both reset requests succeed, both consume calls succeed
      if (callIdx <= 2) return Promise.resolve({ ok: true, status: 200, body: { token: `reset-token-${callIdx}-abcdef` }, durationMs: 5, revisionAtCall: 1 });
      return Promise.resolve({ ok: true, status: 200, body: {}, durationMs: 5, revisionAtCall: 1 });
    });

    const opts = makeOpts(
      {
        authFlow: {
          enabled: true,
          checks: ['password_reset_reuse'],
          requestResetToolId: 'req-reset',
          consumeResetToolId: 'cons-reset',
        },
      },
      { surface_call: callMock },
    );

    const result = await runAuthFlow(opts);
    const tokenReuse = result.detections.filter(d => d.detection.kind === 'password_reset_token_reuse');
    expect(tokenReuse.length).toBeGreaterThanOrEqual(1);
    // Each detection has a testId and a detection object
    for (const { testId, detection } of result.detections) {
      expect(testId).toBeTruthy();
      expect(detection.kind).toBeDefined();
    }
  });

  it('open_redirect fires and populates detection when fetch returns 302 + evil.test location', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/steal' },
      })
    );

    const opts = makeOpts({
      authFlow: {
        enabled: true,
        checks: ['open_redirect'],
        redirectRoutes: ['/auth/login'],
        redirectParamNames: ['redirect'],
      },
    });

    const result = await runAuthFlow(opts);
    const openRedirects = result.detections.filter(d => d.detection.kind === 'open_redirect');
    expect(openRedirects.length).toBeGreaterThanOrEqual(1);

    fetchSpy.mockRestore();
  });

  it('each sub-check runs independently even if one throws', async () => {
    // Make password_reset_reuse throw during surface_call
    const callMock = vi.fn().mockRejectedValue(new Error('network failure'));
    const opts = makeOpts(
      {
        authFlow: {
          enabled: true,
          checks: ['password_reset_reuse', 'open_redirect'],
          requestResetToolId: 'req-reset',
          consumeResetToolId: 'cons-reset',
        },
      },
      { surface_call: callMock },
    );

    // Should not throw; should return gracefully
    const result = await runAuthFlow(opts);
    expect(result.abortReason).toBeUndefined();
    // password_reset_reuse threw; open_redirect ran with 0 candidate URLs → 0 detections
    expect(result.detections).toHaveLength(0);
  });
});
