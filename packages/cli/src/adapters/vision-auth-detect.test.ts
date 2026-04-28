// Tests for vision auth detection helper (v0.5 T03).

import { describe, it, expect } from 'vitest';
import { detectVisionAuth } from './vision-auth-detect.js';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

const FIXTURE_DIR = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../../tests/fixtures/vision-cli'
);
const FAKE_CLAUDE = path.join(FIXTURE_DIR, 'fake-claude');

describe('detectVisionAuth', () => {
  it('returns claudeCli when claude binary is on PATH', async () => {
    const result = await detectVisionAuth({ PATH: FIXTURE_DIR });
    expect(result.kind).toBe('claudeCli');
    if (result.kind === 'claudeCli') {
      expect(result.binaryPath).toContain('claude');
    }
  });

  it('returns apiKey when no claude binary but ANTHROPIC_API_KEY set', async () => {
    const result = await detectVisionAuth({
      PATH: '/nonexistent-path-for-bughunter-test',
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
    });
    expect(result.kind).toBe('apiKey');
    if (result.kind === 'apiKey') {
      expect(result.apiKey).toBe('sk-ant-test-key');
    }
  });

  it('returns unavailable when neither claude binary nor API key present', async () => {
    const result = await detectVisionAuth({ PATH: '/nonexistent-path-for-bughunter-test' });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toMatch(/no Claude CLI/);
    }
  });

  it('prefers claudeCli over apiKey when both available', async () => {
    const result = await detectVisionAuth({
      PATH: FIXTURE_DIR,
      ANTHROPIC_API_KEY: 'sk-ant-should-not-use',
    });
    expect(result.kind).toBe('claudeCli');
  });
});

describe('detectVisionAuth — integration with fake-claude binary', () => {
  it('fake-claude binary responds to --version with exit 0', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(FAKE_CLAUDE, ['--version'], { timeout: 2000 }, (err) => {
        if (err !== null) reject(err);
        else resolve();
      });
    });
  });
});
