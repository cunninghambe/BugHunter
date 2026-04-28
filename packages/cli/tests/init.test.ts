import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock readline/promises before importing initCommand so the import-time
// side effect of loading the module sees the mock.
// The mock is reset per-test via vi.restoreAllMocks() in afterEach.
let mockQuestion: ReturnType<typeof vi.fn>;
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: (...args: Parameters<typeof mockQuestion>) => mockQuestion(...args),
    close: vi.fn(),
  })),
}));

import { initCommand } from '../src/cli/init.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-init-test-'));
  mockQuestion = vi.fn();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readConfig(dir: string): Record<string, unknown> {
  const p = path.join(dir, '.bughunter', 'config.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('initCommand — non-interactive mode (§5)', () => {
  it('writes config with defaults when --no-interactive given', async () => {
    await initCommand(tmpDir, { noInteractive: true });
    const cfg = readConfig(tmpDir);
    expect(cfg.projectName).toBe(path.basename(tmpDir));
    expect(cfg.surfaceMcpUrl).toBe('http://127.0.0.1:3102');
    expect(cfg.resetPolicy).toBe('per-page');
    expect(cfg.browserMcpUrl).toBeUndefined();
    expect(cfg.resetCommand).toBeUndefined();
  });

  it('respects flag overrides', async () => {
    await initCommand(tmpDir, {
      noInteractive: true,
      projectName: 'myproj',
      surfaceMcpUrl: 'http://custom:9000',
    });
    const cfg = readConfig(tmpDir);
    expect(cfg.projectName).toBe('myproj');
    expect(cfg.surfaceMcpUrl).toBe('http://custom:9000');
  });

  it('respects env var fallback (BUGHUNTER_PROJECT_NAME)', async () => {
    process.env['BUGHUNTER_PROJECT_NAME'] = 'env-project';
    try {
      await initCommand(tmpDir, { noInteractive: true });
      const cfg = readConfig(tmpDir);
      expect(cfg.projectName).toBe('env-project');
    } finally {
      delete process.env['BUGHUNTER_PROJECT_NAME'];
    }
  });

  it('flag overrides env var (flag wins)', async () => {
    process.env['BUGHUNTER_PROJECT_NAME'] = 'env-project';
    try {
      await initCommand(tmpDir, { noInteractive: true, projectName: 'flag-project' });
      const cfg = readConfig(tmpDir);
      expect(cfg.projectName).toBe('flag-project');
    } finally {
      delete process.env['BUGHUNTER_PROJECT_NAME'];
    }
  });

  it('throws with Zod message on invalid surfaceMcpUrl', async () => {
    await expect(
      initCommand(tmpDir, { noInteractive: true, surfaceMcpUrl: 'not-a-url' })
    ).rejects.toThrow(/surfaceMcpUrl/);
  });

  it('throws with Zod message on invalid resetPolicy', async () => {
    await expect(
      initCommand(tmpDir, { noInteractive: true, resetPolicy: 'bogus' as never })
    ).rejects.toThrow(/resetPolicy/);
  });

  it('does NOT call readline in non-interactive mode', async () => {
    const { createInterface } = await import('node:readline/promises');
    await expect(
      initCommand(tmpDir, { noInteractive: true })
    ).resolves.not.toThrow();
    expect(createInterface).not.toHaveBeenCalled();
  });

  it('is a no-op when config already exists', async () => {
    await initCommand(tmpDir, { noInteractive: true });
    // Second call should not throw and should leave the file unchanged
    const before = readConfig(tmpDir);
    await initCommand(tmpDir, { noInteractive: true, projectName: 'other' });
    const after = readConfig(tmpDir);
    expect(after.projectName).toBe(before.projectName);
  });
});

describe('initCommand — interactive mode (B-3)', () => {
  // B-3 regression: blank browserMcpUrl input must produce undefined (not a defaulted URL),
  // matching the non-interactive flow which correctly defaults browserMcpUrl to undefined.
  it('B-3: blank browserMcpUrl input produces undefined, consistent with non-interactive default', async () => {
    // Simulate user input: projectName, surfaceMcpUrl (blank→default), browserMcpUrl (blank→skip),
    // resetCommand (blank), resetPolicy (blank→default)
    mockQuestion
      .mockResolvedValueOnce('myproject')       // project name
      .mockResolvedValueOnce('')                 // surfaceMcpUrl → default http://127.0.0.1:3102
      .mockResolvedValueOnce('')                 // browserMcpUrl → blank = skip → undefined
      .mockResolvedValueOnce('')                 // resetCommand → undefined
      .mockResolvedValueOnce('');                // resetPolicy → default per-page

    await initCommand(tmpDir);
    const cfg = readConfig(tmpDir);

    // surfaceMcpUrl should default
    expect(cfg.surfaceMcpUrl).toBe('http://127.0.0.1:3102');
    // browserMcpUrl must be absent (undefined), not 'http://127.0.0.1:3100'
    expect(cfg.browserMcpUrl).toBeUndefined();
    expect(cfg.resetCommand).toBeUndefined();
    expect(cfg.resetPolicy).toBe('per-page');
  });

  it('B-3: non-blank browserMcpUrl is preserved as-is', async () => {
    mockQuestion
      .mockResolvedValueOnce('myproject')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('http://127.0.0.1:3100')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    await initCommand(tmpDir);
    const cfg = readConfig(tmpDir);
    expect(cfg.browserMcpUrl).toBe('http://127.0.0.1:3100');
  });

  it('B-3: non-blank resetCommand is preserved as-is', async () => {
    mockQuestion
      .mockResolvedValueOnce('myproject')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('npm run db:seed')
      .mockResolvedValueOnce('');

    await initCommand(tmpDir);
    const cfg = readConfig(tmpDir);
    expect(cfg.resetCommand).toBe('npm run db:seed');
  });
});
