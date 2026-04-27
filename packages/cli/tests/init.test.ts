import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock readline/promises before importing initCommand so the import-time
// side effect of loading the module sees the mock.
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => {
    throw new Error('readline was called unexpectedly in non-interactive mode');
  }),
}));

import { initCommand } from '../src/cli/init.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-init-test-'));
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
    // If readline was called this would throw due to our mock above
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
