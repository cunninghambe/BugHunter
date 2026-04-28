// Tests for cross-user IDOR phase (v0.5 §3.1).

import { describe, it, expect, vi } from 'vitest';
import { runCrossUser } from './cross-user.js';
import type { CrossUserOptions } from './cross-user.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { RunState } from '../types.js';

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-test',
    projectDir: '/tmp',
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
    ...overrides,
  };
}

function makeSurface(callResponse: (toolId: string, role: string) => { status: number; body?: unknown }): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({
      revision: 1,
      tools: [
        {
          toolId: 'getTrade',
          name: 'getTrade',
          method: 'GET',
          path: '/api/trades/:id',
          inputSchema: {},
          inputSchemaConfidence: 'introspected',
          sideEffectClass: 'safe',
          sourceFile: 'server/src/index.js',
          sourceLine: 100,
          isServerAction: false,
        },
      ],
    }),
    surface_call: vi.fn().mockImplementation(async (args: { toolId: string; role: string }) => {
      const resp = callResponse(args.toolId, args.role);
      return { ok: resp.status === 200, status: resp.status, body: resp.body, durationMs: 1, revisionAtCall: 1 };
    }),
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

describe('runCrossUser', () => {
  it('returns empty when discoveredIds is undefined', async () => {
    const opts: CrossUserOptions = {
      runState: makeRunState(),
      surface: makeSurface(() => ({ status: 403 })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };
    const result = await runCrossUser(opts);
    expect(result.detections).toHaveLength(0);
    expect(result.testCases).toHaveLength(0);
  });

  it('emits idor_horizontal when target role gets 200', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({ discoveredIds }),
      surface: makeSurface((_toolId, role) =>
        role === 'customer' ? { status: 200, body: { id: 'trade-1', amount: 100 } } : { status: 403 }
      ),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal')).toBe(true);
  });

  it('emits auth_bypass_via_unauthed_route when anonymous gets 200', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({ discoveredIds }),
      surface: makeSurface((_toolId, role) =>
        role === 'anonymous' ? { status: 200, body: { id: 'trade-1' } } : { status: 403 }
      ),
      roles: ['owner', 'anonymous'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'auth_bypass_via_unauthed_route')).toBe(true);
  });

  it('does NOT emit when target gets 403', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({ discoveredIds }),
      surface: makeSurface(() => ({ status: 403 })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections).toHaveLength(0);
  });

  it('suppresses finding when response body is empty array', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({ discoveredIds }),
      surface: makeSurface(() => ({ status: 200, body: [] })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections).toHaveLength(0);
  });

  it('emits network_5xx when replay returns 500', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({ discoveredIds }),
      surface: makeSurface(() => ({ status: 500 })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'network_5xx')).toBe(true);
  });

  it('skips when crossRoleProbeEnabled=false', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          crossUser: { crossRoleProbeEnabled: false },
        },
      }),
      surface: makeSurface(() => ({ status: 200, body: { id: 'trade-1' } })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections).toHaveLength(0);
  });

  it('respects maxReplays cap and returns abortReason=budget', async () => {
    // 10 IDs, maxReplays=3
    const ids = new Set(Array.from({ length: 10 }, (_, i) => `id-${i}`));
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', ids]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          crossUser: { maxReplays: 3 },
        },
      }),
      surface: makeSurface(() => ({ status: 403 })),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.abortReason).toBe('budget');
  });
});
