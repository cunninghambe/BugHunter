import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
  effectiveForbiddenPaths: vi.fn(),
}));

vi.mock('../adapters/surface-mcp.js', () => ({
  HttpSurfaceMcpAdapter: vi.fn(),
}));

vi.mock('../adapters/browser-mcp.js', () => ({
  CamofoxBrowserMcpAdapter: vi.fn(),
}));

vi.mock('../adapters/vision-auth-detect.js', () => ({
  detectVisionAuth: vi.fn(),
}));

vi.mock('../store/filesystem.js', () => ({
  listRunIds: vi.fn(),
  runPaths: vi.fn(),
}));

import { doctorCommand } from './doctor.js';
import { loadConfig, effectiveForbiddenPaths } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { detectVisionAuth } from '../adapters/vision-auth-detect.js';
import { listRunIds } from '../store/filesystem.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockEffectiveForbiddenPaths = vi.mocked(effectiveForbiddenPaths);
const MockHttpSurface = vi.mocked(HttpSurfaceMcpAdapter);
const MockBrowser = vi.mocked(CamofoxBrowserMcpAdapter);
const mockDetectVisionAuth = vi.mocked(detectVisionAuth);
const mockListRunIds = vi.mocked(listRunIds);

const MINIMAL_CONFIG = {
  projectName: 'TestProject',
  surfaceMcpUrl: 'http://127.0.0.1:3102',
  browserMcpUrl: undefined,
  maxBugs: 200,
  discoveryFixtures: {},
  domainHints: {},
  forbiddenPaths: [],
};

function withCapturedOutput(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const write = (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(String(chunk));
      return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stdout.write = write as typeof process.stdout.write;
    fn()
      .then(() => {
        process.stdout.write = origWrite;
        resolve(chunks.join(''));
      })
      .catch(err => {
        process.stdout.write = origWrite;
        reject(err as Error);
      });
  });
}

function makeSurfaceMock(): InstanceType<typeof HttpSurfaceMcpAdapter> {
  return {
    surface_describe_self: vi.fn().mockResolvedValue({
      name: 'test', stack: 'nextjs', baseUrl: 'http://localhost:3000',
      toolRevision: 1, pageRevision: 1, capabilities: { listPages: true },
    }),
    surface_list_tools: vi.fn(),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn(),
    surface_describe_auth: vi.fn(),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  } as unknown as InstanceType<typeof HttpSurfaceMcpAdapter>;
}

describe('doctorCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-doctor-test-'));
    process.exitCode = undefined;
    vi.clearAllMocks();

    mockLoadConfig.mockReturnValue(MINIMAL_CONFIG as ReturnType<typeof loadConfig>);
    mockEffectiveForbiddenPaths.mockReturnValue(['prisma/migrations/**', 'node_modules/**']);
    MockHttpSurface.mockImplementation(makeSurfaceMock);
    MockBrowser.mockImplementation(() => ({
      listTabs: vi.fn().mockResolvedValue({ tabs: [] }),
    }) as unknown as InstanceType<typeof CamofoxBrowserMcpAdapter>);
    mockDetectVisionAuth.mockResolvedValue({ kind: 'claudeCli', binaryPath: '/usr/bin/claude' });
    mockListRunIds.mockReturnValue([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('exits 0 on a healthy green environment', async () => {
    await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBe(0);
  });

  it('exits 2 when config is missing', async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('No .bughunter/config.json found'); });
    await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBe(2);
  });

  it('exits 1 when SurfaceMCP is healthy but vision auth is unavailable', async () => {
    mockDetectVisionAuth.mockResolvedValue({ kind: 'unavailable', reason: 'no claude' });
    await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'table' }));
    expect(process.exitCode).toBe(1);
  });

  it('D4 returns yellow when vision auth unavailable', async () => {
    mockDetectVisionAuth.mockResolvedValue({ kind: 'unavailable', reason: 'no claude' });
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; status: string }> };
    const d4 = json.checks.find(c => c.id === 'D4');
    expect(d4?.status).toBe('yellow');
  });

  it('D2 returns red when SurfaceMCP is unreachable', async () => {
    MockHttpSurface.mockImplementation(() => ({
      surface_describe_self: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }) as unknown as InstanceType<typeof HttpSurfaceMcpAdapter>);
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; status: string }> };
    const d2 = json.checks.find(c => c.id === 'D2');
    expect(d2?.status).toBe('red');
  });

  it('D3 returns info when browserMcpUrl is not configured', async () => {
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; status: string; detail: string }> };
    const d3 = json.checks.find(c => c.id === 'D3');
    expect(d3?.status).toBe('info');
    expect(d3?.detail).toContain('not configured');
  });

  it('D8 returns yellow when runs dir has > 100 entries', async () => {
    mockListRunIds.mockReturnValue(Array.from({ length: 101 }, (_, i) => `run-${i}`));
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; status: string }> };
    const d8 = json.checks.find(c => c.id === 'D8');
    expect(d8?.status).toBe('yellow');
  });

  it('JSON output includes all 10 checks', async () => {
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string }> };
    expect(json.checks).toHaveLength(10);
    const ids = json.checks.map(c => c.id);
    expect(ids).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']);
  });

  it('subsequent checks are skipped when config is missing', async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('No .bughunter/config.json found'); });
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; status: string; detail: string }> };
    const d2 = json.checks.find(c => c.id === 'D2');
    expect(d2?.status).toBe('skipped');
    expect(d2?.detail).toBe('config-missing');
  });

  it('D10 reports forbidden paths count', async () => {
    mockEffectiveForbiddenPaths.mockReturnValue(Array.from({ length: 15 }, (_, i) => `path-${i}`));
    mockLoadConfig.mockReturnValue({
      ...MINIMAL_CONFIG, forbiddenPaths: ['custom-1', 'custom-2'],
    } as ReturnType<typeof loadConfig>);
    const output = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'json' }));
    const json = JSON.parse(output) as { checks: Array<{ id: string; detail: string }> };
    const d10 = json.checks.find(c => c.id === 'D10');
    expect(d10?.detail).toContain('15 entries');
  });

  it('table output does not include ANSI escape codes', async () => {
    const combined = await withCapturedOutput(() => doctorCommand(tmpDir, { format: 'table' }));
    expect(combined).not.toMatch(/\x1b\[/);
  });
});
