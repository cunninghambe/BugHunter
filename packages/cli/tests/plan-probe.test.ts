import { describe, it, expect, vi } from 'vitest';
import { runPlan } from '../src/phases/plan.js';
import type { DiscoveryOutput, ToolMeta } from '../src/types.js';
import type { SurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';

function makeTool(toolId: string, confidence: ToolMeta['inputSchemaConfidence']): ToolMeta {
  return {
    name: `tool_${toolId}`,
    toolId,
    method: 'POST',
    path: `/api/${toolId}`,
    inputSchema: confidence === 'unknown'
      ? { type: 'object', additionalProperties: true }
      : { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    inputSchemaConfidence: confidence,
    sideEffectClass: 'mutating',
    sourceFile: `src/api/${toolId}.ts`,
    sourceLine: 1,
    isServerAction: false,
  };
}

function mockSurface(probeReturn: 'upgrade' | 'fail' = 'upgrade'): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn().mockImplementation(async () => {
      if (probeReturn === 'upgrade') {
        return {
          recoveredSchema: { type: 'object', properties: { name: { type: 'string' } } },
          confidence: 'inferred',
        };
      }
      return { confidence: 'unknown' };
    }),
    surface_sample_inputs: vi.fn().mockResolvedValue({ samples: [] }),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
  };
}

describe('plan phase — surface_probe upgrades unknown → inferred', () => {
  it('calls surface_probe for unknown-confidence tools', async () => {
    const surface = mockSurface('upgrade');
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [
        makeTool('known-tool', 'introspected'),
        makeTool('unknown-tool', 'unknown'),
      ],
      skipList: [],
    };

    const result = await runPlan('run-1', discovery, {
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102/mcp',
    }, ['owner'], surface);

    expect(surface.surface_probe).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'unknown-tool', role: 'owner' })
    );
    expect(result.upgradedToolIds).toContain('unknown-tool');
    expect(surface.surface_probe).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'known-tool' })
    );
  });

  it('upgraded tools get 4 test cases; failed probe tools get 1', async () => {
    const surface = mockSurface('fail');
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [makeTool('unknown-tool', 'unknown')],
      skipList: [],
    };

    const result = await runPlan('run-1', discovery, {
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102/mcp',
    }, ['owner'], surface);

    // Tool with failed probe gets 1 happy-path test
    const apiCases = result.testCases.filter(t => t.action.via === 'api' && t.action.toolId === 'unknown-tool');
    expect(apiCases).toHaveLength(1);
    expect(apiCases[0].palette).toBe('happy');
  });

  it('successfully probed tools get 4 test cases', async () => {
    const surface = mockSurface('upgrade');
    const discovery: DiscoveryOutput = {
      pages: [],
      apiTools: [makeTool('unknown-tool', 'unknown')],
      skipList: [],
    };

    const result = await runPlan('run-1', discovery, {
      projectName: 'test',
      surfaceMcpUrl: 'http://127.0.0.1:3102/mcp',
    }, ['owner'], surface);

    const apiCases = result.testCases.filter(t => t.action.via === 'api' && t.action.toolId === 'unknown-tool');
    expect(apiCases).toHaveLength(4);
    expect(apiCases.map(c => c.palette).sort()).toEqual(['edge', 'happy', 'null', 'out_of_bounds'].sort());
  });
});
