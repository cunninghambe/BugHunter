import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../adapters/surface-mcp.js', () => ({
  HttpSurfaceMcpAdapter: vi.fn(),
}));

vi.mock('../adapters/browser-mcp.js', () => ({
  CamofoxBrowserMcpAdapter: vi.fn(),
}));

vi.mock('../phases/validate.js', () => ({
  runValidate: vi.fn(),
}));

vi.mock('../phases/discover.js', () => ({
  runDiscover: vi.fn(),
}));

vi.mock('../phases/plan.js', () => ({
  runPlan: vi.fn(),
}));

import { scopeCommand } from './scope.js';
import { loadConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import type { PlanResult } from '../phases/plan.js';
import type { DiscoveryOutput } from '../types.js';

const mockLoadConfig = vi.mocked(loadConfig);
const MockHttpSurface = vi.mocked(HttpSurfaceMcpAdapter);
const mockRunValidate = vi.mocked(runValidate);
const mockRunDiscover = vi.mocked(runDiscover);
const mockRunPlan = vi.mocked(runPlan);

const MINIMAL_CONFIG = {
  projectName: 'TestProject',
  surfaceMcpUrl: 'http://127.0.0.1:3102',
  maxBugs: 200,
  discoveryFixtures: {},
  domainHints: {},
  forbiddenPaths: [],
};

const EMPTY_DISCOVERY: DiscoveryOutput = {
  pages: [],
  apiTools: [],
  skipList: [],
};

const EMPTY_PLAN: PlanResult = {
  testCases: [],
  projectedRuntimeMs: 0,
  upgradedToolIds: [],
  skipReasons: [],
};

function makeTestCase(overrides: Partial<{
  role: string; page: string; kind: string; palette: string; via: string;
}> = {}) {
  return {
    id: 'tc1',
    runId: 'scope-1',
    role: overrides.role ?? 'owner',
    page: overrides.page ?? '/dashboard',
    action: {
      kind: overrides.kind ?? 'api_call',
      via: overrides.via ?? 'api',
      expectedOutcome: 'success' as const,
      palette: (overrides.palette ?? 'happy') as 'happy',
    },
    expectedOutcome: 'success' as const,
    palette: (overrides.palette ?? 'happy') as 'happy',
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

describe('scopeCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-scope-test-'));
    process.exitCode = undefined;
    vi.clearAllMocks();

    mockLoadConfig.mockReturnValue(MINIMAL_CONFIG as ReturnType<typeof loadConfig>);
    MockHttpSurface.mockImplementation(function (this: unknown) {
      return {};
    } as unknown as typeof HttpSurfaceMcpAdapter);
    mockRunValidate.mockResolvedValue({ revision: 1, roles: ['owner'] });
    mockRunDiscover.mockResolvedValue(EMPTY_DISCOVERY);
    mockRunPlan.mockResolvedValue(EMPTY_PLAN);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('runs validate + discover + plan in sequence', async () => {
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(mockRunValidate).toHaveBeenCalledOnce();
    expect(mockRunDiscover).toHaveBeenCalledOnce();
    expect(mockRunPlan).toHaveBeenCalledOnce();
  });

  it('does NOT create a runs directory', async () => {
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    const runsDir = path.join(tmpDir, '.bughunter', 'runs');
    expect(fs.existsSync(runsDir)).toBe(false);
  });

  it('runId starts with scope- (never persisted)', async () => {
    let capturedRunId: string | undefined;
    mockRunPlan.mockImplementation(async (runId) => {
      capturedRunId = runId;
      return EMPTY_PLAN;
    });
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(capturedRunId).toMatch(/^scope-\d+$/);
  });

  it('exits 1 when validate fails', async () => {
    mockRunValidate.mockRejectedValue(new Error('SurfaceMCP unreachable'));
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when discover fails', async () => {
    mockRunDiscover.mockRejectedValue(new Error('discover error'));
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 on zero matching tests (advisory message, not error)', async () => {
    await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBeUndefined();
  });

  it('JSON output has correct structure', async () => {
    const tc = makeTestCase({ kind: 'api_call', via: 'api', palette: 'happy', role: 'owner', page: '/dashboard' });
    mockRunPlan.mockResolvedValue({
      testCases: [tc as ReturnType<typeof makeTestCase>],
      projectedRuntimeMs: 7500,
      upgradedToolIds: [],
      skipReasons: [],
    } as unknown as PlanResult);
    const output = await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as {
      totalTests: number;
      byRole: Record<string, number>;
      projectedRuntimeMs: number;
      projectedApiCalls: number;
    };
    expect(json.totalTests).toBe(1);
    expect(json.byRole['owner']).toBe(1);
    expect(json.projectedRuntimeMs).toBe(7500);
    expect(json.projectedApiCalls).toBe(1);
  });

  it('passes --route to runDiscover', async () => {
    await withCapturedOutput(() => scopeCommand(tmpDir, { route: '/dashboard*', format: 'table' }));
    expect(mockRunDiscover).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Array),
      expect.stringMatching(/^scope-/),
      expect.anything(),
      undefined,
      '/dashboard*',
    );
  });

  it('table output shows advisory when zero tests', async () => {
    const output = await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(output).toContain('Total tests planned:   0');
    expect(output).toContain('Advisory:');
  });

  it('table output has no ANSI escape codes', async () => {
    const output = await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'table' }));
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('skippedRoutes excludes items without a route property', async () => {
    mockRunDiscover.mockResolvedValue({
      ...EMPTY_DISCOVERY,
      skipList: [
        { route: '/admin', reason: 'role-not-permitted' },
        { reason: 'no-probe' },
      ],
    } as unknown as DiscoveryOutput);
    const output = await withCapturedOutput(() => scopeCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { skippedRoutes: unknown[] };
    expect(json.skippedRoutes).toHaveLength(1);
  });
});
