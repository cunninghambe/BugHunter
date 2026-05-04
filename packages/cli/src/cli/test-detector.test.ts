// Tests for bughunter test-detector CLI command.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testDetectorCommand } from './test-detector.js';
import type { TestDetectorOptions } from './test-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return {
    out: () => chunks.join(''),
    restore: () => { process.stdout.write = original; },
  };
}

function captureStderr(): { err: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return {
    err: () => chunks.join(''),
    restore: () => { process.stderr.write = original; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('testDetectorCommand', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('exits with code 1 and stderr message for unknown kind', async () => {
    const stderr = captureStderr();
    const stdout = captureStdout();

    await testDetectorCommand({ kind: 'nonexistent_kind_abc' });

    stderr.restore();
    stdout.restore();

    expect(process.exitCode).toBe(1);
    expect(stderr.err()).toContain('No DetectorContract found');
    expect(stderr.err()).toContain('nonexistent_kind_abc');
  });

  it('prints "0 detectors, 0 tests" when contracts is empty and kind=all', async () => {
    const stdout = captureStdout();

    await testDetectorCommand({ kind: 'all' });
    stdout.restore();

    // V56.1: DETECTOR_CONTRACTS is empty so we see the informational message
    expect(stdout.out()).toContain('0 detectors');
  });

  it('emits JSON output when --json flag set and no contracts', async () => {
    const stdout = captureStdout();

    await testDetectorCommand({ kind: 'all', json: true });
    stdout.restore();

    const jsonLine = stdout.out().split('\n').find(l => l.startsWith('{'));
    expect(jsonLine).toBeDefined();
    if (jsonLine !== undefined) {
      const parsed = JSON.parse(jsonLine) as { passed: boolean; results: unknown[] };
      expect(parsed.passed).toBe(true);
      expect(parsed.results).toEqual([]);
    }
  });

  it('emits V56.2+ informational message when kind not found and contracts empty', async () => {
    const stderr = captureStderr();
    const stdout = captureStdout();

    await testDetectorCommand({ kind: 'xss_reflected' });

    stderr.restore();
    stdout.restore();

    expect(process.exitCode).toBe(1);
    // Should mention V56.2 since contracts are empty
    expect(stderr.err()).toMatch(/V56\.1|V56\.2|DETECTOR_CONTRACTS/);
  });

  it('--all flag is equivalent to kind=all', async () => {
    const stdout1 = captureStdout();
    await testDetectorCommand({ kind: 'x', all: true });
    stdout1.restore();

    const stdout2 = captureStdout();
    await testDetectorCommand({ kind: 'all' });
    stdout2.restore();

    // Both produce the same "0 detectors" message
    expect(stdout1.out()).toContain('0 detectors');
    expect(stdout2.out()).toContain('0 detectors');
  });
});
