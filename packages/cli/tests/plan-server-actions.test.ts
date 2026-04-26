import { describe, it, expect, vi } from 'vitest';
import { runPlan } from '../src/phases/plan.js';
import type { DiscoveryOutput, ToolMeta } from '../src/types.js';
import type { SurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';

function makeTool(
  toolId: string,
  isServerAction: boolean,
  confidence: ToolMeta['inputSchemaConfidence'] = 'introspected',
): ToolMeta {
  return {
    name: `tool_${toolId}`,
    toolId,
    method: 'POST',
    path: `/api/${toolId}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    inputSchemaConfidence: confidence,
    sideEffectClass: 'mutating',
    sourceFile: `src/api/${toolId}.ts`,
    sourceLine: 1,
    isServerAction,
  };
}

function mockSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn().mockResolvedValue({ confidence: 'unknown' }),
    surface_sample_inputs: vi.fn().mockResolvedValue({ samples: [] }),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
  };
}

describe('plan phase — server-action exclusion (§ 3.4)', () => {
  it('emits API test cases only for regular (non-server-action) routes', async () => {
    const surface = mockSurface();
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [
        makeTool('regular-route', false),
        makeTool('server-action', true),
      ],
      skipList: [],
    };

    const result = await runPlan(
      'run-1',
      discovery,
      { projectName: 'test', surfaceMcpUrl: 'http://127.0.0.1:3102' },
      ['owner'],
      surface,
    );

    const regularCases = result.testCases.filter(
      t => t.action.via === 'api' && t.action.toolId === 'regular-route',
    );
    const serverActionCases = result.testCases.filter(
      t => t.action.via === 'api' && t.action.toolId === 'server-action',
    );

    expect(regularCases.length).toBeGreaterThan(0);
    expect(serverActionCases).toHaveLength(0);
  });

  it('server action tool is never passed to surface_sample_inputs', async () => {
    const surface = mockSurface();
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [
        makeTool('regular-route', false),
        makeTool('server-action', true),
      ],
      skipList: [],
    };

    await runPlan(
      'run-1',
      discovery,
      { projectName: 'test', surfaceMcpUrl: 'http://127.0.0.1:3102' },
      ['owner'],
      surface,
    );

    const sampleCalls = vi.mocked(surface.surface_sample_inputs).mock.calls;
    const calledToolIds = sampleCalls.map(c => c[0].toolId);
    expect(calledToolIds).toContain('regular-route');
    expect(calledToolIds).not.toContain('server-action');
  });
});
