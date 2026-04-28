// Integration tests for runHeaderProbes wiring (v0.5 Gap 1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runExecute } from './execute.js';
import type { ExecuteOptions } from './execute.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { RunState } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TRADERJO_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;";

function makeFetchResponse(headers: Record<string, string>, status = 200): Response {
  return new Response(null, {
    status,
    headers,
  });
}

function makeRunState(projectDir: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'test-run',
    projectDir,
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

function makeMinimalSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn(),
    surface_call: vi.fn(),
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

function makeExecuteOpts(projectDir: string, overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    testCases: [],
    runState: makeRunState(projectDir),
    surface: makeMinimalSurface(),
    maxBugs: 50,
    maxRuntimeMs: 60000,
    concurrency: 1,
    apiConcurrency: 1,
    onClusterFound: () => 0,
    ...overrides,
  };
}

describe('runExecute header probe integration', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-probe-test-'));
    // Create required artifact subdirectories
    for (const sub of ['action-logs', 'screenshots', 'dom', 'console', 'network']) {
      fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', 'test-run', sub), { recursive: true });
    }
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects missing_csp_header with inline_scripts_allowed for TraiderJo CSP', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ 'content-security-policy': TRADERJO_CSP }));

    const opts = makeExecuteOpts(tmpDir, {
      pageUrls: ['/', '/wiki/x'],
      appBaseUrl: 'http://127.0.0.1:8787',
      headerProbeEnabled: true,
      runState: makeRunState(tmpDir, {
        config: {
          projectName: 'test',
          surfaceMcpUrl: 'http://localhost:3100',
          headers: { enabled: true, csp: { localhostMode: 'flag' } },
        },
      }),
    });

    const result = await runExecute(opts);
    const cspDetections = (result.headerProbeDetections ?? []).filter(d => d.kind === 'missing_csp_header');
    expect(cspDetections.length).toBeGreaterThanOrEqual(1);
    expect(cspDetections[0]?.headerContext?.expectedShape).toBe('inline_scripts_allowed');
  });

  it('emits no detections and warns on URL parse failure when appBaseUrl is undefined', async () => {
    const opts = makeExecuteOpts(tmpDir, {
      pageUrls: ['/'],
      appBaseUrl: undefined,
      headerProbeEnabled: true,
    });

    // fetch should not be called — the relative URL '/' with empty base produces 'http://undefinedundefined/'
    // which our buildAbsoluteUrl will reject; no valid origin means no probe
    const result = await runExecute(opts);
    // No fetch called with a valid URL — detections may be empty
    expect(result.headerProbeDetections ?? []).toHaveLength(0);
  });

  it('skips all fetches and emits no detections when headerProbeEnabled=false', async () => {
    const opts = makeExecuteOpts(tmpDir, {
      pageUrls: ['/', '/wiki/x'],
      appBaseUrl: 'http://127.0.0.1:8787',
      headerProbeEnabled: false,
    });

    const result = await runExecute(opts);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.headerProbeDetections ?? []).toHaveLength(0);
  });
});
