// Integration smoke test: v0.21 IDOR end-to-end via the idor-bad fixture server.
//
// Starts the fixture server in-process, creates a mock surface adapter that forwards
// to it, and runs runCrossUser with v0.21 config. Verifies:
//  - ≥1 idor_horizontal_read cluster with resourceType='order'
//  - ≥1 idor_horizontal_mutate cluster when probeMutating=true (transactional reset)
//  - Zero idor_vertical_suspicious when legitimizedHierarchies suppresses admin→alice
//  - ≥1 idor_vertical_suspicious without legitimizedHierarchies
//  - Cluster signatures collapse two order tools into one idor_horizontal_read cluster
//  - idorTelemetry.fixturesCollected populated

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import { runCrossUser } from '../../packages/cli/src/phases/cross-user.js';
import type { CrossUserOptions } from '../../packages/cli/src/phases/cross-user.js';
import type { SurfaceMcpAdapter } from '../../packages/cli/src/adapters/surface-mcp.js';
import type { RunState, ToolMeta } from '../../packages/cli/src/types.js';
import { clusterSignature } from '../../packages/cli/src/cluster/signature.js';

// ---- inline fixture server (mirrors fixtures/idor-bad/server.js) ----

const ORDERS: Record<string, { id: string; owner: string; amount: number }> = {
  'order-alice-1': { id: 'order-alice-1', owner: 'alice', amount: 100 },
  'order-alice-2': { id: 'order-alice-2', owner: 'alice', amount: 200 },
  'order-bob-1':   { id: 'order-bob-1',   owner: 'bob',   amount: 50 },
};

const TOOLS: ToolMeta[] = [
  {
    toolId: 'getOrder',
    name: 'getOrder',
    method: 'GET',
    path: '/api/orders/:id',
    inputSchema: {},
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 1,
    isServerAction: false,
  },
  {
    toolId: 'getOrderLineItems',
    name: 'getOrderLineItems',
    method: 'GET',
    path: '/api/orders/:id/line-items',
    inputSchema: {},
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 2,
    isServerAction: false,
  },
  {
    toolId: 'deleteOrder',
    name: 'deleteOrder',
    method: 'DELETE',
    path: '/api/orders/:id',
    inputSchema: {},
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'mutating',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 3,
    isServerAction: false,
  },
  {
    toolId: 'getAdminReports',
    name: 'getAdminReports',
    method: 'GET',
    path: '/api/admin/reports',
    inputSchema: {},
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'safe',
    sourceFile: 'fixtures/idor-bad/server.js',
    sourceLine: 4,
    isServerAction: false,
  },
];

// Simulates the broken fixture: no ownership check on getOrder / deleteOrder
function fixtureCallResponse(toolId: string, role: string, input: Record<string, unknown>): { status: number; body: unknown } {
  if (toolId === 'getOrder' || toolId === 'getOrderLineItems') {
    const orderId = input['id'] as string | undefined;
    if (orderId === undefined) return { status: 400, body: { error: 'id required' } };
    const order = ORDERS[orderId];
    if (order === undefined) return { status: 404, body: { error: 'not found' } };
    // IDOR: no ownership check
    return { status: 200, body: order };
  }

  if (toolId === 'deleteOrder') {
    const orderId = input['id'] as string | undefined;
    if (orderId === undefined) return { status: 400, body: { error: 'id required' } };
    const order = ORDERS[orderId];
    if (order === undefined) return { status: 404, body: { error: 'not found' } };
    // IDOR: no ownership check
    return { status: 200, body: { deleted: true, id: orderId } };
  }

  if (toolId === 'getAdminReports') {
    if (role !== 'admin') return { status: 403, body: { error: 'forbidden' } };
    return { status: 200, body: { orders: Object.values(ORDERS) } };
  }

  return { status: 404, body: { error: 'unknown tool' } };
}

function makeSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: async () => ({ revision: 1, tools: TOOLS }),
    surface_call: async (args: { toolId: string; role: string; input: unknown }) => {
      const resp = fixtureCallResponse(args.toolId, args.role, (args.input ?? {}) as Record<string, unknown>);
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, body: resp.body, durationMs: 1, revisionAtCall: 1 };
    },
    surface_describe_tool: async () => { throw new Error('not implemented'); },
    surface_probe: async () => { throw new Error('not implemented'); },
    surface_sample_inputs: async () => { throw new Error('not implemented'); },
    surface_login_status: async () => { throw new Error('not implemented'); },
    surface_relogin: async () => { throw new Error('not implemented'); },
    surface_routes_for_page: async () => { throw new Error('not implemented'); },
    surface_list_pages: async () => { throw new Error('not implemented'); },
    surface_describe_self: async () => { throw new Error('not implemented'); },
    surface_describe_auth: async () => { throw new Error('not implemented'); },
    surface_list_navigations: async () => { throw new Error('not implemented'); },
    surface_enumerate_routes_runtime: async () => { throw new Error('not implemented'); },
    surface_postprocess_runtime_routes: async () => { throw new Error('not implemented'); },
  } as unknown as SurfaceMcpAdapter;
}

function makeRunState(idorOverrides: RunState['config']['idor'] = {}): RunState {
  return {
    runId: 'idor-smoke-run',
    projectDir: '/tmp/idor-smoke',
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'idor-bad-fixture',
      surfaceMcpUrl: 'http://localhost:4090',
      idor: { enabled: true, ...idorOverrides },
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
    // alice owns order-alice-1 and order-alice-2; discovered during alice's execute phase
    discoveredIds: new Map([
      ['alice', new Map([
        ['getOrder:id', new Set(['order-alice-1', 'order-alice-2'])],
        ['getOrderLineItems:id', new Set(['order-alice-1'])],
      ])],
      ['bob', new Map([
        ['getOrder:id', new Set(['order-bob-1'])],
      ])],
    ]),
  };
}

describe('idor-smoke: horizontal read (AC §10.4)', () => {
  it('produces ≥1 idor_horizontal_read cluster with resourceType=order', async () => {
    const result = await runCrossUser({
      runState: makeRunState(),
      surface: makeSurface(),
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    const readDetections = result.detections.filter(d => d.detection.kind === 'idor_horizontal_read');
    expect(readDetections.length).toBeGreaterThanOrEqual(1);
    expect(readDetections[0]?.detection.idorContext?.resourceType).toBe('order');
    expect(result.idorTelemetry?.detectionsByKind.idor_horizontal_read).toBeGreaterThanOrEqual(1);
  });
});

describe('idor-smoke: horizontal mutate (AC §10.5)', () => {
  it('produces ≥1 idor_horizontal_mutate cluster with probeMutating=true and transactional reset', async () => {
    const runState = makeRunState({ probeMutating: true });
    runState.config.resetPolicy = 'transactional';

    const result = await runCrossUser({
      runState,
      surface: makeSurface(),
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    expect(result.detections.some(d => d.detection.kind === 'idor_horizontal_mutate')).toBe(true);
    expect(result.idorTelemetry?.detectionsByKind.idor_horizontal_mutate).toBeGreaterThanOrEqual(1);
  });
});

describe('idor-smoke: vertical suspicious (AC §10.6)', () => {
  it('emits ≥1 idor_vertical_suspicious when legitimizedHierarchies is not configured', async () => {
    const result = await runCrossUser({
      runState: makeRunState(),
      surface: makeSurface(),
      roles: ['alice', 'admin'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    // admin reading alice's order is cross-tier and NOT suppressed
    expect(result.detections.some(d => d.detection.kind === 'idor_vertical_suspicious')).toBe(true);
  });

  it('emits zero idor_vertical_suspicious when legitimizedHierarchies suppresses admin→alice', async () => {
    // Use only alice's discoveredIds (no bob) so the only cross-tier candidate is admin reading alice's data.
    // legitimizedHierarchies: [{ from: 'admin', to: 'alice' }] suppresses exactly that direction.
    const runStateAliceOnly = makeRunState({
      legitimizedHierarchies: [{ from: 'admin', to: 'alice' }],
    });
    runStateAliceOnly.discoveredIds = new Map([
      ['alice', new Map([
        ['getOrder:id', new Set(['order-alice-1', 'order-alice-2'])],
      ])],
    ]);
    const result = await runCrossUser({
      runState: runStateAliceOnly,
      surface: makeSurface(),
      roles: ['alice', 'admin'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    expect(result.detections.some(d => d.detection.kind === 'idor_vertical_suspicious')).toBe(false);
    expect(result.idorTelemetry?.suppressedByLegitimizedHierarchy).toBeGreaterThanOrEqual(1);
  });
});

describe('idor-smoke: cluster signature collapses same resourceType (AC §10 + spec §5)', () => {
  it('getOrder and getOrderLineItems collapse to one idor_horizontal_read cluster', async () => {
    const result = await runCrossUser({
      runState: makeRunState(),
      surface: makeSurface(),
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    const readDetections = result.detections.filter(d => d.detection.kind === 'idor_horizontal_read');
    // Both tools derive resourceType='order' → same cluster signature → deduplicated
    const signatures = new Set(readDetections.map(d => clusterSignature(d.detection)));
    expect(signatures.size).toBe(1);
    expect([...signatures][0]).toMatch(/^idor_horizontal_read\|order\|/);
  });
});

describe('idor-smoke: telemetry (AC §10.8)', () => {
  it('populates idorTelemetry block', async () => {
    const result = await runCrossUser({
      runState: makeRunState(),
      surface: makeSurface(),
      roles: ['alice', 'bob'],
      maxClusters: 50,
      onClusterFound: () => 0,
    });

    const t = result.idorTelemetry;
    expect(t).toBeDefined();
    expect(t?.enabled).toBe(true);
    expect(t?.swapsAttempted).toBeGreaterThanOrEqual(1);
    expect(t?.fixturesCollected['alice']?.['order']).toBeGreaterThanOrEqual(1);
    expect(t?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
