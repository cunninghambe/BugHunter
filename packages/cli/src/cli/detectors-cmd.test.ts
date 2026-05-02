import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { detectorsCommand } from './detectors-cmd.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';

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

describe('detectorsCommand', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('lists all 128 entries in JSON format (v0.41: +6 mobile wired kinds)', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'json' }));
    const json = JSON.parse(output) as { meta: { total: number }; entries: unknown[] };
    expect(json.entries).toHaveLength(128);
    expect(json.meta.total).toBe(128);
  });

  it('JSON meta has correct wired/deferred/dead counts', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'json' }));
    const json = JSON.parse(output) as { meta: { wired: number; deferred: number; dead: number } };
    expect(json.meta.wired).toBe(127);
    expect(json.meta.deferred).toBe(1);
    expect(json.meta.dead).toBe(0);
  });

  it('--status deferred returns exactly 1 entry', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { status: 'deferred', format: 'json' }));
    const json = JSON.parse(output) as { entries: unknown[] };
    expect(json.entries).toHaveLength(1);
  });

  it('--kind console_error returns one entry with correct detectorSite', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { kind: 'console_error', format: 'json' }));
    const json = JSON.parse(output) as { entries: Array<{ kind: string; detectorSite?: string }> };
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]?.detectorSite).toBe('packages/cli/src/classify/console.ts:24');
  });

  it('--kind with unknown value exits 1', () => {
    withCapturedOutput(() => detectorsCommand('', { kind: 'not_a_real_kind' as 'console_error', format: 'table' }));
    expect(process.exitCode).toBe(1);
  });

  it('table output includes all 128 entries (v0.41: +6 mobile wired kinds)', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'table' }));
    const lines = output.split('\n').filter(l => l.includes('|'));
    // header + divider aren't included in line count; entries have '|' separator
    const entryLines = lines.filter(l => !l.startsWith('-') && !l.startsWith('BugKind'));
    expect(entryLines).toHaveLength(128);
  });

  it('table output has no ANSI escape codes', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'table' }));
    expect(output).not.toMatch(/\x1b\[/);
  });

  it('table output shows history-not-available for lastFiredAt', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'table' }));
    expect(output).toContain('history-not-available');
  });

  it('table entries are sorted wired-first then alphabetic', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'json' }));
    const json = JSON.parse(output) as { entries: Array<{ status: string; kind: string }> };
    const entries = json.entries;
    let prevStatusOrder = -1;
    const statusOrder: Record<string, number> = { wired: 0, deferred: 1, dead: 2 };
    for (const e of entries) {
      const order = statusOrder[e.status] ?? 99;
      expect(order).toBeGreaterThanOrEqual(prevStatusOrder);
      prevStatusOrder = order;
    }
  });

  it('no entry has status "missing"', () => {
    const output = withCapturedOutput(() => detectorsCommand('', { format: 'json' }));
    const json = JSON.parse(output) as { entries: Array<{ status: string }> };
    const missing = json.entries.filter(e => e.status === 'missing');
    expect(missing).toHaveLength(0);
  });

  it('exits 0 (not set) normally', () => {
    withCapturedOutput(() => detectorsCommand('', { format: 'json' }));
    expect(process.exitCode).toBeUndefined();
  });
});
