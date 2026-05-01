import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../adapters/surface-mcp.js', () => ({
  HttpSurfaceMcpAdapter: vi.fn(),
}));

vi.mock('../mutation/apply.js', () => ({
  apiTestCases: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { inputsCommand } from './inputs-cmd.js';
import { loadConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { apiTestCases } from '../mutation/apply.js';
import type { ToolMeta, PaletteVariant } from '../types.js';

const mockLoadConfig = vi.mocked(loadConfig);
const MockHttpSurface = vi.mocked(HttpSurfaceMcpAdapter);
const mockApiTestCases = vi.mocked(apiTestCases);

const MINIMAL_CONFIG = {
  projectName: 'TestProject',
  surfaceMcpUrl: 'http://127.0.0.1:3102',
  roles: ['owner'],
  maxBugs: 200,
  discoveryFixtures: {},
  domainHints: {},
  forbiddenPaths: [],
};

const MOCK_TOOL: ToolMeta = {
  name: 'Create Trade',
  toolId: 'POST /api/trades',
  method: 'POST',
  path: '/api/trades',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      amount: { type: 'number' },
    },
    required: ['name', 'amount'],
  },
  inputSchemaConfidence: 'introspected',
  sideEffectClass: 'mutating',
  sourceFile: 'app/api/trades/route.ts',
  sourceLine: 10,
  isServerAction: false,
};

function makeSurfaceMock(toolResult: ToolMeta = MOCK_TOOL, samplesResult: unknown[] = []) {
  return function (this: unknown) {
    return {
      surface_describe_tool: vi.fn().mockResolvedValue(toolResult),
      surface_sample_inputs: vi.fn().mockResolvedValue({ samples: samplesResult.map(i => ({ source: 'seed', input: i })) }),
    };
  };
}

function makeTestCase(palette: PaletteVariant, input: unknown) {
  return {
    id: 'tc1',
    runId: 'inputs-cli',
    role: 'owner',
    page: '/api/trades',
    action: { kind: 'api_call' as const, via: 'api' as const, expectedOutcome: 'success' as const, palette, input },
    expectedOutcome: 'success' as const,
    palette,
  };
}

function withCapturedOutput(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    fn()
      .then(() => { process.stdout.write = origWrite; resolve(chunks.join('')); })
      .catch(err => { process.stdout.write = origWrite; reject(err as Error); });
  });
}

describe('inputsCommand', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(MINIMAL_CONFIG as ReturnType<typeof loadConfig>);
    MockHttpSurface.mockImplementation(makeSurfaceMock() as unknown as typeof HttpSurfaceMcpAdapter);
    mockApiTestCases.mockReturnValue([
      makeTestCase('null', { name: null, amount: null }),
      makeTestCase('happy', { name: 'Test', amount: 100 }),
      makeTestCase('edge', { name: '', amount: 0 }),
      makeTestCase('out_of_bounds', { name: 'x'.repeat(300), amount: -1 }),
    ] as ReturnType<typeof makeTestCase>[]);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('returns 4 entries for a fully-introspected tool', async () => {
    const output = await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { format: 'json' })
    );
    const json = JSON.parse(output) as unknown[];
    expect(json).toHaveLength(4);
  });

  it('--palette happy returns only the happy entry', async () => {
    const output = await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { palette: 'happy', format: 'json' })
    );
    const json = JSON.parse(output) as Array<{ palette: string }>;
    expect(json).toHaveLength(1);
    expect(json[0]?.palette).toBe('happy');
  });

  it('--palette null returns only the null entry', async () => {
    const output = await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { palette: 'null', format: 'json' })
    );
    const json = JSON.parse(output) as Array<{ palette: string; input: Record<string, unknown> }>;
    expect(json).toHaveLength(1);
    expect(json[0]?.palette).toBe('null');
    expect(json[0]?.input?.name).toBeNull();
  });

  it('exits 1 on invalid --palette value', async () => {
    await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { palette: 'xss_inject' as PaletteVariant, format: 'json' })
    );
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when tool is not found', async () => {
    MockHttpSurface.mockImplementation(function (this: unknown) {
      return {
        surface_describe_tool: vi.fn().mockRejectedValue(new Error('not found')),
        surface_sample_inputs: vi.fn(),
      };
    } as unknown as typeof HttpSurfaceMcpAdapter);
    await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/nonexistent', { format: 'json' })
    );
    expect(process.exitCode).toBe(1);
  });

  it('returns empty array when --palette filter matches nothing (unknown confidence tool)', async () => {
    mockApiTestCases.mockReturnValue([
      makeTestCase('happy', { name: 'Test' }),
    ] as ReturnType<typeof makeTestCase>[]);
    const output = await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { palette: 'edge', format: 'json' })
    );
    const json = JSON.parse(output) as unknown[];
    expect(json).toHaveLength(0);
  });

  it('passes domainHints from config to apiTestCases', async () => {
    mockLoadConfig.mockReturnValue({
      ...MINIMAL_CONFIG,
      domainHints: { email: ['test@example.com'] },
    } as ReturnType<typeof loadConfig>);
    await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { format: 'json' })
    );
    expect(mockApiTestCases).toHaveBeenCalledWith(
      'inputs-cli',
      'owner',
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ email: ['test@example.com'] }),
      undefined,
    );
  });

  it('passes bodyFixture when configured', async () => {
    mockLoadConfig.mockReturnValue({
      ...MINIMAL_CONFIG,
      bodyFixtures: { 'POST /api/trades': { owner: { ticker: 'AAPL' } } },
    } as ReturnType<typeof loadConfig>);
    await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { format: 'json' })
    );
    expect(mockApiTestCases).toHaveBeenCalledWith(
      'inputs-cli',
      'owner',
      expect.anything(),
      expect.any(Array),
      expect.anything(),
      { ticker: 'AAPL' },
    );
  });

  it('invokes apiTestCases with role from config.roles[0]', async () => {
    await withCapturedOutput(() =>
      inputsCommand('', 'POST /api/trades', { format: 'json' })
    );
    expect(mockApiTestCases).toHaveBeenCalledWith(
      'inputs-cli',
      'owner',
      expect.anything(),
      expect.any(Array),
      expect.anything(),
      undefined,
    );
  });
});
