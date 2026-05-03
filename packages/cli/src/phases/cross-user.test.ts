// Tests for cross-user IDOR phase (v0.5 §3.1, extended v0.21).

import { describe, it, expect, vi } from 'vitest';
import { runCrossUser } from './cross-user.js';
import type { CrossUserOptions } from './cross-user.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { RunState, ToolMeta } from '../types.js';

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

function makeSurface(
  callResponse: (toolId: string, role: string) => { status: number; body?: unknown },
  extraTools: ToolMeta[] = [],
): SurfaceMcpAdapter {
  const defaultTool: ToolMeta = {
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
  };
  return {
    surface_list_tools: vi.fn().mockResolvedValue({
      revision: 1,
      tools: [defaultTool, ...extraTools],
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

  it('runs anonymous-only sweep and emits auth_bypass_via_unauthed_route when discoveredIds is empty and resetPolicy is set', async () => {
    const tools: ToolMeta[] = [
      {
        toolId: 'getPublic',
        name: 'getPublic',
        method: 'GET',
        path: '/api/public',
        inputSchema: {},
        inputSchemaConfidence: 'introspected',
        sideEffectClass: 'safe',
        sourceFile: 'server/src/index.js',
        sourceLine: 1,
        isServerAction: false,
      },
      {
        toolId: 'getAlsoPublic',
        name: 'getAlsoPublic',
        method: 'GET',
        path: '/api/also-public',
        inputSchema: {},
        inputSchemaConfidence: 'introspected',
        sideEffectClass: 'safe',
        sourceFile: 'server/src/index.js',
        sourceLine: 2,
        isServerAction: false,
      },
      {
        toolId: 'deleteAdmin',
        name: 'deleteAdmin',
        method: 'DELETE',
        path: '/api/admin/delete',
        inputSchema: {},
        inputSchemaConfidence: 'introspected',
        sideEffectClass: 'mutating',
        sourceFile: 'server/src/index.js',
        sourceLine: 3,
        isServerAction: false,
      },
    ];

    const surface: SurfaceMcpAdapter = {
      surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools }),
      surface_call: vi.fn().mockImplementation(async (args: { toolId: string; role: string }) => {
        // getPublic returns 200 with data, getAlsoPublic returns 403
        if (args.toolId === 'getPublic') return { ok: true, status: 200, body: { id: 'x1', data: 'secret' }, durationMs: 1, revisionAtCall: 1 };
        return { ok: false, status: 403, body: null, durationMs: 1, revisionAtCall: 1 };
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

    const opts: CrossUserOptions = {
      runState: makeRunState({
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          resetPolicy: 'per-run',
        },
      }),
      surface,
      roles: ['owner', 'anonymous'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'auth_bypass_via_unauthed_route')).toBe(true);
    // Should not have attempted the mutating admin tool
    const callArgs = (surface.surface_call as ReturnType<typeof vi.fn>).mock.calls as Array<[{ toolId: string }]>;
    expect(callArgs.some(([a]) => a.toolId === 'deleteAdmin')).toBe(false);
  });
});

// --- v0.21 IDOR pass tests ---

function makeV21RunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-v21-test',
    projectDir: '/tmp',
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
      idor: { enabled: true },
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
    ...overrides,
  };
}

function makeOrderTool(toolId: string, sideEffectClass: 'safe' | 'mutating' = 'safe'): ToolMeta {
  return {
    toolId,
    name: toolId,
    method: sideEffectClass === 'mutating' ? 'DELETE' : 'GET',
    path: '/api/orders/:id',
    inputSchema: {},
    inputSchemaConfidence: 'introspected',
    sideEffectClass,
    sourceFile: 'server/src/index.js',
    sourceLine: 1,
    isServerAction: false,
  };
}

describe('runCrossUser — v0.21 IDOR pass', () => {
  it('emits idor_horizontal_read for peer-tier cross-role 200 on safe tool', async () => {
    const discoveredIds = new Map([
      ['alice', new Map([['getOrder:id', new Set(['order-1'])]])],
    ]);

    const surface = makeSurface(
      (_toolId, role) => role === 'bob'
        ? { status: 200, body: { id: 'order-1', amount: 50 } }
        : { status: 403 },
      [makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          idor: { enabled: true },
        },
      }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal_read')).toBe(true);
    const det = result.detections.find(d => d.detection.kind === 'idor_horizontal_read');
    expect(det?.detection.idorContext?.resourceType).toBe('order');
    expect(det?.detection.idorContext?.tier).toBe('peer');
  });

  it('emits idor_horizontal_mutate for peer-tier cross-role 200 on mutating tool with probeMutating=true', async () => {
    const discoveredIds = new Map([
      ['alice', new Map([['deleteOrder:id', new Set(['order-2'])]])],
    ]);

    const surface = makeSurface(
      (_toolId, role) => role === 'bob' ? { status: 200, body: { deleted: true } } : { status: 403 },
      [makeOrderTool('deleteOrder', 'mutating')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          resetPolicy: 'transactional',
          idor: { enabled: true, probeMutating: true },
        },
      }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal_mutate')).toBe(true);
  });

  it('does NOT probe mutating tools when probeMutating=false', async () => {
    const discoveredIds = new Map([
      ['alice', new Map([['deleteOrder:id', new Set(['order-2'])]])],
    ]);

    const surface = makeSurface(
      (_toolId, role) => role === 'bob' ? { status: 200, body: { deleted: true } } : { status: 403 },
      [makeOrderTool('deleteOrder', 'mutating')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          idor: { enabled: true, probeMutating: false },
        },
      }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal_mutate')).toBe(false);
  });

  it('emits idor_vertical_suspicious for cross-tier access', async () => {
    const discoveredIds = new Map([
      ['admin', new Map([['getOrder:id', new Set(['order-1'])]])],
    ]);

    const surface = makeSurface(
      (_toolId, role) => role === 'alice' ? { status: 200, body: { id: 'order-1' } } : { status: 403 },
      [makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          idor: { enabled: true },
        },
      }),
      surface,
      roles: ['admin', 'alice'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_vertical_suspicious')).toBe(true);
    const det = result.detections.find(d => d.detection.kind === 'idor_vertical_suspicious');
    expect(det?.detection.idorContext?.requiresAdjudication).toBe(true);
  });

  it('suppresses idor_vertical_suspicious when legitimizedHierarchies matches', async () => {
    // Scenario: admin's IDs are in discoveredIds; alice replays them.
    // This tests alice (accessor, targetRole) reading admin (owner, sourceRole) data.
    // The suppressing hierarchy must be { from: 'alice', to: 'admin' }
    // per spec §7.3: from=accessor, to=owner.
    const discoveredIds = new Map([
      ['admin', new Map([['getOrder:id', new Set(['order-1'])]])],
    ]);

    const surface = makeSurface(
      (_toolId, role) => role === 'alice' ? { status: 200, body: { id: 'order-1' } } : { status: 403 },
      [makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          idor: {
            enabled: true,
            legitimizedHierarchies: [{ from: 'alice', to: 'admin' }],
          },
        },
      }),
      surface,
      roles: ['admin', 'alice'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.detections.some(d => d.detection.kind === 'idor_vertical_suspicious')).toBe(false);
    expect(result.idorTelemetry?.suppressedByLegitimizedHierarchy).toBeGreaterThanOrEqual(1);
  });

  it('populates idorTelemetry with swapsAttempted and fixturesCollected', async () => {
    const discoveredIds = new Map([
      ['alice', new Map([['getOrder:id', new Set(['order-1', 'order-2'])]])],
    ]);

    const surface = makeSurface(
      () => ({ status: 403 }),
      [makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({ discoveredIds }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    expect(result.idorTelemetry?.enabled).toBe(true);
    expect(result.idorTelemetry?.swapsAttempted).toBeGreaterThanOrEqual(1);
    expect(result.idorTelemetry?.fixturesCollected['alice']?.['order']).toBeGreaterThanOrEqual(1);
  });

  it('respects maxFixturesPerRoleResource cap at insert time', async () => {
    // 10 ids, cap=2
    const ids = new Set(Array.from({ length: 10 }, (_, i) => `order-${i}`));
    const discoveredIds = new Map([
      ['alice', new Map([['getOrder:id', ids]])],
    ]);

    const surface = makeSurface(
      () => ({ status: 200, body: { id: 'order-0', amount: 10 } }),
      [makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          idor: { enabled: true, maxFixturesPerRoleResource: 2 },
        },
      }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    // Only 2 ids captured; only 2 replays (bob getting alice's 2 orders)
    expect(result.idorTelemetry?.fixturesCollected['alice']?.['order']).toBe(2);
    expect(result.idorTelemetry?.swapsAttempted).toBe(2);
  });

  it('skips fixture from denied tool path (/api/me)', async () => {
    // getTrade is at /api/me — should be denied
    const discoveredIds = new Map([
      ['alice', new Map([['getMeProfile:id', new Set(['user-1'])]])],
    ]);

    const meProfileTool: ToolMeta = {
      toolId: 'getMeProfile',
      name: 'getMeProfile',
      method: 'GET',
      path: '/api/me',
      inputSchema: {},
      inputSchemaConfidence: 'introspected',
      sideEffectClass: 'safe',
      sourceFile: 'server/src/index.js',
      sourceLine: 1,
      isServerAction: false,
    };

    const surface = makeSurface(
      () => ({ status: 200, body: { id: 'user-1' } }),
      [meProfileTool, makeOrderTool('getOrder')],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({ discoveredIds }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    // No fixtures collected from /api/me tool, so no replays
    expect(result.idorTelemetry?.swapsAttempted).toBe(0);
    expect(result.detections.filter(d =>
      d.detection.kind === 'idor_horizontal_read' || d.detection.kind === 'idor_horizontal_mutate'
    )).toHaveLength(0);
  });

  it('collapses two tools with the same resourceType into one cluster (cluster signature)', async () => {
    const discoveredIds = new Map([
      ['alice', new Map([
        ['getOrder:id', new Set(['order-1'])],
        ['getOrderLineItems:id', new Set(['order-1'])],
      ])],
    ]);

    const lineItemsTool: ToolMeta = {
      toolId: 'getOrderLineItems',
      name: 'getOrderLineItems',
      method: 'GET',
      path: '/api/orders/:id/line-items',
      inputSchema: {},
      inputSchemaConfidence: 'introspected',
      sideEffectClass: 'safe',
      sourceFile: 'server/src/index.js',
      sourceLine: 2,
      isServerAction: false,
    };

    const surface = makeSurface(
      (_toolId, role) => role === 'bob' ? { status: 200, body: { id: 'order-1' } } : { status: 403 },
      [makeOrderTool('getOrder'), lineItemsTool],
    );

    const opts: CrossUserOptions = {
      runState: makeV21RunState({ discoveredIds }),
      surface,
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    const readDetections = result.detections.filter(d => d.detection.kind === 'idor_horizontal_read');
    // Both tools derive resourceType='order', so cluster key is the same → deduplicated to 1
    expect(readDetections).toHaveLength(1);
    expect(readDetections[0]?.detection.idorContext?.resourceType).toBe('order');
  });

  it('does NOT emit v0.21 kinds when idor.enabled is false (legacy path)', async () => {
    const discoveredIds = new Map([
      ['owner', new Map([['getTrade:id', new Set(['trade-1'])]])],
    ]);

    const opts: CrossUserOptions = {
      runState: makeRunState({
        discoveredIds,
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          // idor.enabled is false/unset — legacy path
        },
      }),
      surface: makeSurface((_toolId, role) =>
        role === 'customer' ? { status: 200, body: { id: 'trade-1', amount: 100 } } : { status: 403 }
      ),
      roles: ['owner', 'customer'],
      maxClusters: 50,
      onClusterFound: () => 0,
    };

    const result = await runCrossUser(opts);
    // Should emit legacy idor_horizontal, not v0.21 kinds
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal')).toBe(true);
    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal_read')).toBe(false);
  });
});

describe('runCrossUser — surface stamping (#139)', () => {
  it('stamps detection.surface with targetSurface on all emitted detections', async () => {
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
      targetSurface: 'self-spa',
    };

    const result = await runCrossUser(opts);
    expect(result.detections.length).toBeGreaterThan(0);
    for (const { detection } of result.detections) {
      expect(detection.surface).toBe('self-spa');
    }
  });

  it('leaves detection.surface undefined when targetSurface is not provided', async () => {
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
    expect(result.detections.length).toBeGreaterThan(0);
    for (const { detection } of result.detections) {
      expect(detection.surface).toBeUndefined();
    }
  });
});
