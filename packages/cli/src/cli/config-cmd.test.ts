import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('../adapters/surface-mcp.js', () => ({
  HttpSurfaceMcpAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { configCommand, checkOrphansAsync } from './config-cmd.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';

const MockHttpSurface = vi.mocked(HttpSurfaceMcpAdapter);

const VALID_CONFIG = {
  projectName: 'TestProject',
  surfaceMcpUrl: 'http://127.0.0.1:3102',
};

const INVALID_CONFIG_TYPO = {
  projectName: 'TestProject',
  surfaceMcpUrl: 'not-a-valid-url',
};

function withCapturedOutput(fn: () => void): string {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

function writeBughunterDir(tmpDir: string, config: unknown): void {
  const dir = path.join(tmpDir, '.bughunter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('configCommand validate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-config-test-'));
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('exits 0 on a valid config and prints Config OK', () => {
    writeBughunterDir(tmpDir, VALID_CONFIG);
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain('Config OK.');
  });

  it('exits 1 when config file is missing', () => {
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBe(1);
    expect(output).toContain('No .bughunter/config.json found');
  });

  it('exits 1 when surfaceMcpUrl is invalid (Zod failure)', () => {
    writeBughunterDir(tmpDir, INVALID_CONFIG_TYPO);
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBe(1);
    expect(output).toContain('Invalid .bughunter/config.json');
    expect(output).toContain('surfaceMcpUrl');
  });

  it('reports multiple Zod issues', () => {
    writeBughunterDir(tmpDir, {
      projectName: '',
      surfaceMcpUrl: 'bad-url',
    });
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBe(1);
    // Should mention at least 2 issues
    expect(output).toContain('issue(s)');
  });

  it('exits 1 when config JSON is malformed', () => {
    const dir = path.join(tmpDir, '.bughunter');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ invalid json }');
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBe(1);
    expect(output).toContain('Invalid .bughunter/config.json');
  });

  it('exits 1 when palette.json is malformed', () => {
    writeBughunterDir(tmpDir, VALID_CONFIG);
    fs.writeFileSync(path.join(tmpDir, '.bughunter', 'palette.json'), '{ bad }');
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(process.exitCode).toBe(1);
    expect(output).toContain('palette.json');
  });

  it('prints counts for fixtures and forbidden paths', () => {
    writeBughunterDir(tmpDir, {
      ...VALID_CONFIG,
      bodyFixtures: {},
      discoveryFixtures: {},
      forbiddenPaths: ['custom-path'],
    });
    const output = withCapturedOutput(() => configCommand(tmpDir, 'validate', {}));
    expect(output).toContain('forbiddenPaths:');
  });
});

describe('configCommand show', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-config-show-'));
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('outputs valid JSON', () => {
    writeBughunterDir(tmpDir, VALID_CONFIG);
    const output = withCapturedOutput(() => configCommand(tmpDir, 'show', {}));
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('redacts vision.apiKey to [redacted]', () => {
    writeBughunterDir(tmpDir, {
      ...VALID_CONFIG,
      vision: { enabled: true, apiKey: 'sk-secret-key-12345' },
    });
    const output = withCapturedOutput(() => configCommand(tmpDir, 'show', {}));
    const json = JSON.parse(output) as { vision?: { apiKey?: string } };
    expect(json.vision?.apiKey).toBe('[redacted]');
    expect(output).not.toContain('sk-secret-key-12345');
  });

  it('redacts authorization header', () => {
    writeBughunterDir(tmpDir, {
      ...VALID_CONFIG,
      extraHeaders: { Authorization: 'Bearer my-secret-token' },
    });
    const output = withCapturedOutput(() => configCommand(tmpDir, 'show', {}));
    const json = JSON.parse(output) as { extraHeaders?: { Authorization?: string } };
    expect(json.extraHeaders?.Authorization).toBe('[redacted]');
    expect(output).not.toContain('my-secret-token');
  });

  it('--resolved includes forbiddenPaths defaults', () => {
    writeBughunterDir(tmpDir, VALID_CONFIG);
    const output = withCapturedOutput(() => configCommand(tmpDir, 'show', { resolved: true }));
    const json = JSON.parse(output) as { forbiddenPaths?: string[]; maxBugs?: number };
    // Resolved view includes defaults from DEFAULT_FORBIDDEN_PATHS
    expect(Array.isArray(json.forbiddenPaths)).toBe(true);
    expect(json.forbiddenPaths?.length).toBeGreaterThan(0);
    // Also fills maxBugs default
    expect(json.maxBugs).toBe(200);
  });

  it('exits 1 when config is missing', () => {
    withCapturedOutput(() => configCommand(tmpDir, 'show', {}));
    expect(process.exitCode).toBe(1);
  });
});

describe('checkOrphansAsync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-orphan-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no fixtures configured', async () => {
    const config = {
      projectName: 'Test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      maxBugs: 200,
      discoveryFixtures: {},
      domainHints: {},
      forbiddenPaths: [],
    } as Parameters<typeof checkOrphansAsync>[0];
    const warnings = await checkOrphansAsync(config);
    expect(warnings).toHaveLength(0);
  });

  it('reports orphan bodyFixture when toolId not in catalog', async () => {
    MockHttpSurface.mockImplementation(function (this: unknown) {
      return {
        surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [{ toolId: 'POST /api/real' }] }),
        surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages: [] }),
      };
    } as unknown as typeof HttpSurfaceMcpAdapter);

    const config = {
      projectName: 'Test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      bodyFixtures: { 'POST /api/legacy-trades': { owner: { name: 'test' } } },
      maxBugs: 200,
      discoveryFixtures: {},
      domainHints: {},
      forbiddenPaths: [],
    } as Parameters<typeof checkOrphansAsync>[0];

    const warnings = await checkOrphansAsync(config);
    expect(warnings.some(w => w.includes('orphan bodyFixture'))).toBe(true);
    expect(warnings.some(w => w.includes('POST /api/legacy-trades'))).toBe(true);
  });

  it('reports orphan discoveryFixture when route not in pages', async () => {
    MockHttpSurface.mockImplementation(function (this: unknown) {
      return {
        surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
        surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages: [{ route: '/real-page' }] }),
      };
    } as unknown as typeof HttpSurfaceMcpAdapter);

    const config = {
      projectName: 'Test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      discoveryFixtures: { '/old-page': ['click#btn'] },
      bodyFixtures: {},
      maxBugs: 200,
      domainHints: {},
      forbiddenPaths: [],
    } as Parameters<typeof checkOrphansAsync>[0];

    const warnings = await checkOrphansAsync(config);
    expect(warnings.some(w => w.includes('orphan discoveryFixture'))).toBe(true);
    expect(warnings.some(w => w.includes('/old-page'))).toBe(true);
  });

  it('returns unreachable warning when SurfaceMCP is down', async () => {
    MockHttpSurface.mockImplementation(function (this: unknown) {
      return {
        surface_list_tools: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        surface_list_pages: vi.fn(),
      };
    } as unknown as typeof HttpSurfaceMcpAdapter);

    const config = {
      projectName: 'Test',
      surfaceMcpUrl: 'http://127.0.0.1:3102',
      bodyFixtures: { 'POST /api/x': { owner: {} } },
      maxBugs: 200,
      discoveryFixtures: {},
      domainHints: {},
      forbiddenPaths: [],
    } as Parameters<typeof checkOrphansAsync>[0];

    const warnings = await checkOrphansAsync(config);
    expect(warnings.some(w => w.includes('SurfaceMCP unreachable'))).toBe(true);
  });
});
