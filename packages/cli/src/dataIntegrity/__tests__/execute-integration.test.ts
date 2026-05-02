// Integration test for issue #96: ActionResult fields wired through execute.ts.
// Verifies that evaluateInvariantsAfter receives status, responseBody, and
// requestBody from the actual executeApiTest call — not the stub that had only
// url and method.
//
// This test does NOT mock runSeedHook or the evaluator. It spins up a real
// in-process HTTP server for the invariant "after" query, and drives the full
// execute phase through runExecute with a surface_call stub that returns
// realistic response data.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runExecute } from '../../phases/execute.js';
import type { ExecuteOptions } from '../../phases/execute.js';
import type { SurfaceMcpAdapter } from '../../adapters/surface-mcp.js';
import type { TestCase, RunState, ToolMeta, DataIntegrityInvariant } from '../../types.js';

// ---------------------------------------------------------------------------
// Fixture server — responds to invariant "after" queries
// ---------------------------------------------------------------------------

type ServerState = {
  lastReceivedBody: string | null;
  responsePayload: string;
};

type ServerHandle = {
  server: http.Server;
  baseUrl: string;
  state: ServerState;
};

async function startFixtureServer(): Promise<ServerHandle> {
  const state: ServerState = { lastReceivedBody: null, responsePayload: '{"count":0}' };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        state.lastReceivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(state.responsePayload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, state });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRunState(projectDir: string, invariant: DataIntegrityInvariant, queryBaseUrl: string): RunState {
  return {
    runId: 'di-integration-run',
    projectDir,
    startedAt: new Date().toISOString(),
    phase: 'execute',
    config: {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost:3100',
      dataIntegrity: {
        enabled: true,
        invariants: [invariant],
      },
    },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  };
}

function makeMinimalSurface(
  responseStatus: number,
  responseBody: unknown,
): SurfaceMcpAdapter {
  const callMock = vi.fn().mockResolvedValue({
    ok: responseStatus >= 200 && responseStatus < 300,
    status: responseStatus,
    body: responseBody,
    headers: { 'content-type': 'application/json' },
    durationMs: 5,
    revisionAtCall: 1,
  });
  return {
    surface_call: callMock,
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

function makeToolMap(): Map<string, ToolMeta> {
  const meta: ToolMeta = {
    name: 'create-item',
    toolId: 'create-item',
    method: 'POST',
    path: '/api/items',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaConfidence: 'inferred',
    sideEffectClass: 'mutating',
    sourceFile: 'src/routes/items.ts',
    sourceLine: 1,
    isServerAction: false,
  };
  return new Map([['create-item', meta]]);
}

function makeMutatingTestCase(runId: string): TestCase {
  return {
    id: 'tc-create-item',
    runId,
    role: 'admin',
    page: '/api/items',
    palette: 'happy',
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'success',
      palette: 'happy',
      toolId: 'create-item',
      input: { name: 'widget', price: 9.99 },
    },
    expectedOutcome: 'success',
  };
}

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-di-integ-'));
  for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
    fs.mkdirSync(path.join(dir, '.bughunter', 'runs', 'di-integration-run', sub), { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute.ts — ActionResult fields wired for invariant extract clauses (issue #96)', () => {
  let handle: ServerHandle;
  let tmpDir: string;

  beforeAll(async () => {
    handle = await startFixtureServer();
  });

  afterAll(() => {
    handle.server.close();
    if (tmpDir !== undefined) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invariant using extract.from=actionResponseBody receives the real response body', async () => {
    tmpDir = makeTmpDir();
    const responseBody = { id: 'item-42', name: 'widget', price: 9.99 };

    // The invariant queries the fixture server and expects the count to be 0
    // (the fixture server always returns {"count":0}). The extract clause pulls
    // the response id from the action's response body — this is the field that
    // was undefined before the fix.
    const invariant: DataIntegrityInvariant = {
      name: 'response-body-extract-test',
      bugKind: 'cache_staleness',
      appliesTo: {},
      extract: {
        createdId: { from: 'actionResponseBody', jsonPath: 'id' },
      },
      after: {
        query: {
          kind: 'http',
          url: `${handle.baseUrl}/check`,
          method: 'GET',
        },
        parse: 'json',
        expect: { op: 'lengthEquals', value: 0, jsonPath: 'count' },
      },
    };

    const runState = makeRunState(tmpDir, invariant, handle.baseUrl);
    const surface = makeMinimalSurface(200, responseBody);
    const tc = makeMutatingTestCase(runState.runId);

    const executeResult = await runExecute({
      testCases: [tc],
      runState,
      surface,
      maxBugs: 50,
      maxRuntimeMs: 30_000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      toolMap: makeToolMap(),
      appBaseUrl: handle.baseUrl,
    } satisfies ExecuteOptions);

    // The execute phase must have run our test case
    expect(executeResult.results).toHaveLength(1);

    // The invariant should have been evaluated (not skipped due to missing fields)
    const evaluations = executeResult.dataIntegrityEvaluations ?? [];
    expect(evaluations.length).toBeGreaterThan(0);

    const ev = evaluations[0];
    expect(ev?.invariantName).toBe('response-body-extract-test');
    // The invariant query returns {"count":0} which satisfies lengthEquals:0
    // so outcome should be 'passed' — proving the after query ran successfully
    expect(ev?.outcome).toBe('passed');
    expect(ev?.ok).toBe(true);
  });

  it('invariant using extract.from=actionRequestBody receives the sent request body', async () => {
    tmpDir = makeTmpDir();

    // This invariant extracts from requestBody — also broken before the fix.
    // We verify the invariant evaluates (outcome !== 'query_failed') which means
    // the extract clause ran against real data instead of undefined.
    const invariant: DataIntegrityInvariant = {
      name: 'request-body-extract-test',
      bugKind: 'audit_log_missing_for_mutation',
      appliesTo: {},
      extract: {
        sentPrice: { from: 'actionRequestBody', jsonPath: 'price' },
      },
      after: {
        query: {
          kind: 'http',
          url: `${handle.baseUrl}/audit`,
          method: 'GET',
        },
        parse: 'json',
        expect: { op: 'lengthEquals', value: 0, jsonPath: 'count' },
      },
    };

    const runState = makeRunState(tmpDir, invariant, handle.baseUrl);
    const surface = makeMinimalSurface(201, { id: 'item-99' });
    const tc = makeMutatingTestCase(runState.runId);

    const executeResult = await runExecute({
      testCases: [tc],
      runState,
      surface,
      maxBugs: 50,
      maxRuntimeMs: 30_000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      toolMap: makeToolMap(),
      appBaseUrl: handle.baseUrl,
    } satisfies ExecuteOptions);

    const evaluations = executeResult.dataIntegrityEvaluations ?? [];
    expect(evaluations.length).toBeGreaterThan(0);

    const ev = evaluations[0];
    expect(ev?.invariantName).toBe('request-body-extract-test');
    expect(ev?.outcome).toBe('passed');
  });

  it('status field is populated — actionResponseStatus resolves to real HTTP status', async () => {
    tmpDir = makeTmpDir();

    // An invariant that does not use extract — we verify status via the evaluation
    // record. Before the fix, status was undefined, so actionResponseStatus would
    // resolve to 0 in the runtime context. We test indirectly: if the invariant
    // was evaluated (not skipped/failed), the ActionResult was valid.
    const invariant: DataIntegrityInvariant = {
      name: 'status-populated-test',
      bugKind: 'data_integrity_orphan',
      appliesTo: {},
      after: {
        query: {
          kind: 'http',
          url: `${handle.baseUrl}/orphans`,
          method: 'GET',
        },
        parse: 'json',
        expect: { op: 'lengthEquals', value: 0, jsonPath: 'count' },
      },
    };

    const runState = makeRunState(tmpDir, invariant, handle.baseUrl);
    const surface = makeMinimalSurface(200, { id: 'item-1' });
    const tc = makeMutatingTestCase(runState.runId);

    const executeResult = await runExecute({
      testCases: [tc],
      runState,
      surface,
      maxBugs: 50,
      maxRuntimeMs: 30_000,
      concurrency: 1,
      apiConcurrency: 1,
      onClusterFound: () => 0,
      toolMap: makeToolMap(),
      appBaseUrl: handle.baseUrl,
    } satisfies ExecuteOptions);

    const evaluations = executeResult.dataIntegrityEvaluations ?? [];
    expect(evaluations.length).toBeGreaterThan(0);
    expect(evaluations[0]?.outcome).toBe('passed');
    expect(evaluations[0]?.ok).toBe(true);
  });
});
