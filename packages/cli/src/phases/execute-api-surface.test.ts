// #178: runExecute for openapi-stack surface (no browser) must execute planned api tests.
// Regression guard: 296 tests planned, 0 executed was the smoke #17 symptom.
//
// Root cause: executeApiTest had an early-exit that trivially passed (no surface_call) when
// tc.action.toolId was undefined. SurfaceMCP for openapi/express stacks can omit toolId from
// ToolMeta at runtime; apiTestCases() now stores tool.name in Action.toolName so the executor
// can dispatch via surface_call({ name }) instead of silently passing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { TestCase, RunState } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const RUN_ID = 'api-surface-test-run';

function makeRunState(projectDir: string): RunState {
  return {
    runId: RUN_ID,
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: { projectName: 'test', surfaceMcpUrl: 'http://localhost:3100' },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeMinimalSurface(): SurfaceMcpAdapter {
  return {
    surface_call: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { id: 1, name: 'test' },
      durationMs: 5,
      revisionAtCall: 1,
    }),
    surface_list_tools: vi.fn(),
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

function makeApiTestCase(id: string, toolId: string): TestCase {
  return {
    id,
    runId: RUN_ID,
    role: 'user',
    page: '/api/items',
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'success',
      palette: 'happy',
      toolId,
      input: {},
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

/**
 * Simulates what apiTestCases() produces for a tool whose SurfaceMCP omits toolId (#178):
 * toolId is absent but toolName carries the MCP tool name for name-based dispatch.
 */
function makeApiTestCaseByName(id: string, toolName: string, page: string): TestCase {
  return {
    id,
    runId: RUN_ID,
    role: 'user',
    page,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'success',
      palette: 'happy',
      // toolId intentionally absent — mirrors SurfaceMCP omitting toolId from ToolMeta
      toolName,
      input: {},
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-api-surface-test-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', RUN_ID, sub), { recursive: true });
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runExecute — openapi-stack surface (no browser)', () => {
  it('executes all 5 api test cases and returns 5 results (#178)', async () => {
    const testCases = [
      makeApiTestCase('tc-1', 'GET /api/items'),
      makeApiTestCase('tc-2', 'GET /api/users'),
      makeApiTestCase('tc-3', 'POST /api/items'),
      makeApiTestCase('tc-4', 'PUT /api/items/1'),
      makeApiTestCase('tc-5', 'DELETE /api/items/1'),
    ];

    const surface = makeMinimalSurface();
    const opts: ExecuteOptions = {
      testCases,
      runState: makeRunState(tmpDir),
      surface,
      // no browser — openapi-stack has no UI
      maxBugs: 50,
      maxRuntimeMs: 60_000,
      concurrency: 1,
      apiConcurrency: 4,
      onClusterFound: () => 0,
      appBaseUrl: 'http://localhost:3100',
    };

    const result = await runExecute(opts);

    expect(result.results).toHaveLength(5);
    expect(result.abortReason).toBeUndefined();
    // surface_call should have been called once per test
    expect(surface.surface_call).toHaveBeenCalledTimes(5);
  });

  it('dispatches surface_call via name when toolId is absent — catches the 296-planned/0-executed regression (#178)', async () => {
    // Reproduces the exact failure mode: SurfaceMCP omits toolId from ToolMeta for openapi stacks.
    // apiTestCases() stores tool.name in Action.toolName; executeApiTest must use it for dispatch.
    // Without the fix, executeApiTest trivially passed these cases (no surface_call invocation).
    const testCases = [
      makeApiTestCaseByName('tc-n1', 'list_items',  '/api/items'),
      makeApiTestCaseByName('tc-n2', 'get_user',    '/api/users/1'),
      makeApiTestCaseByName('tc-n3', 'create_item', '/api/items'),
      makeApiTestCaseByName('tc-n4', 'update_item', '/api/items/1'),
      makeApiTestCaseByName('tc-n5', 'delete_item', '/api/items/1'),
    ];

    const surface = makeMinimalSurface();
    const opts: ExecuteOptions = {
      testCases,
      runState: makeRunState(tmpDir),
      surface,
      maxBugs: 50,
      maxRuntimeMs: 60_000,
      concurrency: 1,
      apiConcurrency: 5,
      onClusterFound: () => 0,
      appBaseUrl: 'http://localhost:3100',
    };

    const result = await runExecute(opts);

    expect(result.results).toHaveLength(5);
    expect(result.abortReason).toBeUndefined();
    // All 5 must produce real surface_call invocations — not the trivial-pass early-exit
    expect(surface.surface_call).toHaveBeenCalledTimes(5);
    // Each call should dispatch by name, not toolId
    for (const call of (surface.surface_call as ReturnType<typeof vi.fn>).mock.calls) {
      const args = call[0] as { toolId?: string; name?: string };
      expect(args.toolId).toBeUndefined();
      expect(args.name).toBeDefined();
    }
  });

  it('skips ui tests silently when no browser is provided but still runs api tests', async () => {
    const apiCase = makeApiTestCase('tc-api', 'GET /api/items');
    const uiCase: TestCase = {
      id: 'tc-ui',
      runId: RUN_ID,
      role: 'user',
      page: '/dashboard',
      action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
      expectedOutcome: 'success',
      palette: 'happy',
    };

    const surface = makeMinimalSurface();
    const opts: ExecuteOptions = {
      testCases: [apiCase, uiCase],
      runState: makeRunState(tmpDir),
      surface,
      // no browser — ui test should be skipped, api test should run
      maxBugs: 50,
      maxRuntimeMs: 60_000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
    };

    const result = await runExecute(opts);

    // Only the api test should run; the ui test is skipped (no browser)
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.testId).toBe('tc-api');
    expect(result.skipReasons).toContainEqual(
      expect.objectContaining({ reason: 'no browserMcpUrl configured', count: 1 }),
    );
  });
});
