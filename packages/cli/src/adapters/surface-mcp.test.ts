// Tests for BoundSurfaceMcpAdapter (v0.43 multi-surface) and legacy fallback.

import { describe, it, expect, vi } from 'vitest';
import {
  BoundSurfaceMcpAdapter,
  HttpSurfaceMcpAdapter,
} from './surface-mcp.js';
import type {
  SurfaceMcpAdapter,
  SurfaceDescribeSelfResult,
  SurfaceListSurfacesResult,
  SurfaceListToolsResult,
  SurfaceLoginStatusResult,
  SurfaceListPagesResult,
  SurfaceListNavigationsResult,
  SurfaceRuntimeEnumScript,
  SurfacePostprocessResult,
  SurfaceRoutesForPageResult,
  DescribeAuthResult,
} from './surface-mcp.js';

/** Minimal stub adapter that records every call's args. */
function makeStub(): SurfaceMcpAdapter & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  function rec(method: string, args: unknown[]): void {
    if (calls[method] === undefined) calls[method] = [];
    calls[method].push(args);
  }

  const listSurfacesResult: SurfaceListSurfacesResult = {
    surfaceMcpVersion: '0.3.0',
    surfaces: [],
  };
  const describeSelfResult: SurfaceDescribeSelfResult = {
    name: 'test-surface',
    stack: 'vite',
    baseUrl: 'http://localhost:5790',
    toolRevision: 1,
    pageRevision: 1,
    capabilities: { listPages: true },
  };
  const listToolsResult: SurfaceListToolsResult = { revision: 1, tools: [] };
  const loginStatusResult: SurfaceLoginStatusResult = {
    authenticated: true,
    refreshCount: 0,
  };
  const listPagesResult: SurfaceListPagesResult = { revision: 1, pages: [] };
  const listNavigationsResult: SurfaceListNavigationsResult = { revision: 1, navigations: [], skips: [] };
  const runtimeEnumScript: SurfaceRuntimeEnumScript = { version: 1, script: '', timeoutMs: 5000, expectedSchema: {} };
  const postprocessResult: SurfacePostprocessResult = {
    routes: [],
    summary: { detectedRouters: [], errorCount: 0, totalRoutes: 0, dedupedRoutes: 0, fellBackToNone: false },
  };
  const routesForPageResult: SurfaceRoutesForPageResult = { tools: [] };
  const describeAuthResult: DescribeAuthResult = { authKind: 'none', reason: 'no_auth_configured' };

  return {
    calls,
    getSurfaceName: () => undefined,
    surface_list_surfaces: vi.fn(() => {
      rec('surface_list_surfaces', []);
      return Promise.resolve(listSurfacesResult);
    }),
    surface_list_tools: vi.fn((filter) => {
      rec('surface_list_tools', [filter]);
      return Promise.resolve(listToolsResult);
    }),
    surface_describe_tool: vi.fn((args) => {
      rec('surface_describe_tool', [args]);
      return Promise.resolve({
        name: 'tool', toolId: 'id', method: 'GET', path: '/', sideEffectClass: 'safe' as const,
        inputSchema: {}, inputSchemaConfidence: 'inferred' as const, sourceFile: '', sourceLine: 0, isServerAction: false,
      });
    }),
    surface_call: vi.fn((args) => {
      rec('surface_call', [args]);
      return Promise.resolve({ ok: true, durationMs: 0, revisionAtCall: 1 });
    }),
    surface_probe: vi.fn((args) => {
      rec('surface_probe', [args]);
      return Promise.resolve({ confidence: 'unknown' as const });
    }),
    surface_sample_inputs: vi.fn((args) => {
      rec('surface_sample_inputs', [args]);
      return Promise.resolve({ samples: [] });
    }),
    surface_login_status: vi.fn((args) => {
      rec('surface_login_status', [args]);
      return Promise.resolve(loginStatusResult);
    }),
    surface_relogin: vi.fn((args) => {
      rec('surface_relogin', [args]);
      return Promise.resolve({ ok: true });
    }),
    surface_routes_for_page: vi.fn((args) => {
      rec('surface_routes_for_page', [args]);
      return Promise.resolve(routesForPageResult);
    }),
    surface_list_pages: vi.fn((args) => {
      rec('surface_list_pages', [args]);
      return Promise.resolve(listPagesResult);
    }),
    surface_describe_self: vi.fn((args) => {
      rec('surface_describe_self', [args]);
      return Promise.resolve(describeSelfResult);
    }),
    surface_describe_auth: vi.fn((args) => {
      rec('surface_describe_auth', [args]);
      return Promise.resolve(describeAuthResult);
    }),
    surface_list_navigations: vi.fn((args) => {
      rec('surface_list_navigations', [args]);
      return Promise.resolve(listNavigationsResult);
    }),
    surface_enumerate_routes_runtime: vi.fn((args) => {
      rec('surface_enumerate_routes_runtime', [args]);
      return Promise.resolve(runtimeEnumScript);
    }),
    surface_postprocess_runtime_routes: vi.fn((args) => {
      rec('surface_postprocess_runtime_routes', [args]);
      return Promise.resolve(postprocessResult);
    }),
  };
}

describe('BoundSurfaceMcpAdapter — surface threading', () => {
  it('getSurfaceName returns the bound surface name', () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    expect(bound.getSurfaceName()).toBe('self-spa');
  });

  it('surface_describe_self injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_describe_self();
    expect(stub.surface_describe_self).toHaveBeenCalledWith({ surface: 'self-spa' });
  });

  it('surface_list_pages injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_list_pages();
    expect(stub.surface_list_pages).toHaveBeenCalledWith({ surface: 'self-spa' });
  });

  it('surface_list_navigations injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_list_navigations();
    expect(stub.surface_list_navigations).toHaveBeenCalledWith({ surface: 'self-api' });
  });

  it('surface_login_status injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_login_status({ role: 'anonymous' });
    expect(stub.surface_login_status).toHaveBeenCalledWith({ role: 'anonymous', surface: 'self-api' });
  });

  it('surface_relogin injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_relogin({ role: 'anonymous' });
    expect(stub.surface_relogin).toHaveBeenCalledWith({ role: 'anonymous', surface: 'self-api' });
  });

  it('surface_describe_auth injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_describe_auth({ role: 'anonymous' });
    expect(stub.surface_describe_auth).toHaveBeenCalledWith({ role: 'anonymous', surface: 'self-api' });
  });

  it('surface_routes_for_page injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_routes_for_page({ pagePath: '/dashboard' });
    expect(stub.surface_routes_for_page).toHaveBeenCalledWith({ pagePath: '/dashboard', surface: 'self-spa' });
  });

  it('surface_enumerate_routes_runtime injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_enumerate_routes_runtime();
    expect(stub.surface_enumerate_routes_runtime).toHaveBeenCalledWith({ surface: 'self-spa' });
  });

  it('surface_postprocess_runtime_routes injects bound surface name', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_postprocess_runtime_routes({ raw: [] });
    expect(stub.surface_postprocess_runtime_routes).toHaveBeenCalledWith({ raw: [], surface: 'self-spa' });
  });

  it('surface_list_tools injects bound surface name as filter.surface', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_list_tools({ method: 'GET' });
    expect(stub.surface_list_tools).toHaveBeenCalledWith({ method: 'GET', surface: 'self-api' });
  });

  it('surface_list_surfaces does NOT inject surface arg (global call)', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    await bound.surface_list_surfaces();
    expect(stub.surface_list_surfaces).toHaveBeenCalledWith();
  });

  it('surface_call does NOT inject surface arg (tool name carries surface prefix)', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-api');
    const args = { name: 'self-api:getUser', role: 'anonymous', input: {} };
    await bound.surface_call(args);
    expect(stub.surface_call).toHaveBeenCalledWith(args);
  });

  it('caller-supplied surface wins over bound surface', async () => {
    const stub = makeStub();
    const bound = new BoundSurfaceMcpAdapter(stub, 'self-spa');
    await bound.surface_describe_self({ surface: 'override-surface' });
    expect(stub.surface_describe_self).toHaveBeenCalledWith({ surface: 'override-surface' });
  });
});

describe('BoundSurfaceMcpAdapter — HttpSurfaceMcpAdapter.getSurfaceName', () => {
  it('HttpSurfaceMcpAdapter.getSurfaceName returns undefined', () => {
    const http = new HttpSurfaceMcpAdapter('http://localhost:3140');
    expect(http.getSurfaceName()).toBeUndefined();
  });
});

describe('resolveSurfaceTopology — legacy fallback', () => {
  it('falls back to single-surface shim when surface_list_surfaces throws', async () => {
    const { resolveSurfaceTopology } = await import('../cli/run.js');

    const stub = makeStub();
    // Override surface_list_surfaces to throw "method not found"
    (stub.surface_list_surfaces as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SurfaceMCP error: {"code":"method_not_found"}'),
    );
    // Override surface_describe_self to return a legacy shape
    (stub.surface_describe_self as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'my-surface',
      stack: 'vite' as const,
      baseUrl: 'http://localhost:5790',
      toolRevision: 42,
      pageRevision: 1,
      capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: false, crawlSeed: true },
    });

    // resolveSurfaceTopology takes an HttpSurfaceMcpAdapter; cast via type intersection
    const result = await resolveSurfaceTopology(stub as unknown as HttpSurfaceMcpAdapter);

    expect(result.surfaceMcpVersion).toBe('<unknown:legacy>');
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0].name).toBe('my-surface');
    expect(result.surfaces[0].state.kind).toBe('ready');
    expect(result.surfaces[0].toolRevision).toBe(42);
    expect(result.surfaces[0].capabilities.listNavigations).toBe(true);
    expect(result.surfaces[0].capabilities.enumerateRoutesRuntime).toBe(false);
  });
});
