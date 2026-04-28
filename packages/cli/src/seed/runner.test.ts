// Unit tests for seed/runner.ts — 10+ cases per spec §6.1.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSeedHook, runSeedHooksAt, parseShellCommand } from './runner.js';
import type { SeedHook } from '../types.js';

// ---------------------------------------------------------------------------
// parseShellCommand
// ---------------------------------------------------------------------------

describe('parseShellCommand', () => {
  it('splits on whitespace', () => {
    expect(parseShellCommand('pnpm run test')).toEqual(['pnpm', 'run', 'test']);
  });

  it('preserves single-quoted strings', () => {
    expect(parseShellCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('preserves double-quoted strings', () => {
    expect(parseShellCommand('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('handles multiple spaces between tokens', () => {
    expect(parseShellCommand('a  b   c')).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Shell hook tests
// ---------------------------------------------------------------------------

describe('runSeedHook — shell', () => {
  const ctx = { projectDir: '/tmp', lifecyclePoint: 'beforeRun' as const };

  it('echo hello → ok:true with captured output', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'echo hello' };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(true);
    expect(result.hookKind).toBe('shell');
    expect(result.output).toContain('hello');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('false → ok:false with exitCode 1', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'false' };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('command not found → ok:false with reason containing command_not_found', async () => {
    const hook: SeedHook = { kind: 'shell', command: '__bughunter_nonexistent_cmd_zz9876__' };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/command_not_found/);
  });

  it('timeout → ok:false with reason containing timeout', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'sleep 60', timeoutMs: 200 };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timeout/);
  }, 5000);

  it('stdout > 64KB still resolves and output is truncated to 500 chars in telemetry', async () => {
    // Generate >64KB stdout: print 1000 bytes * 100 = ~100KB
    const hook: SeedHook = {
      kind: 'shell',
      command: 'dd if=/dev/urandom bs=1024 count=100 2>/dev/null | base64',
    };
    const result = await runSeedHook(hook, ctx);
    // The hook may succeed or fail depending on dd; either way it must resolve
    // and the output must be at most 500 chars + 1 for the ellipsis
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    if (result.output !== undefined) {
      expect(result.output.length).toBeLessThanOrEqual(501);
    }
  }, 10000);

  it('uses description from hook when present', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'echo hi', description: 'my-desc' };
    const result = await runSeedHook(hook, ctx);
    expect(result.description).toBe('my-desc');
  });

  it('uses command as description when description is absent', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'echo hi' };
    const result = await runSeedHook(hook, ctx);
    expect(result.description).toBe('echo hi');
  });

  it('records lifecyclePoint from context', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'echo x' };
    const result = await runSeedHook(hook, { ...ctx, lifecyclePoint: 'cleanup' });
    expect(result.lifecyclePoint).toBe('cleanup');
  });

  it('records role from context when present', async () => {
    const hook: SeedHook = { kind: 'shell', command: 'echo x' };
    const result = await runSeedHook(hook, { ...ctx, role: 'owner' });
    expect(result.role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// HTTP hook tests (using global fetch mock via vi.stubGlobal)
// ---------------------------------------------------------------------------

function mockFetch(status: number, body = ''): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    text: () => Promise.resolve(body),
  }));
}

describe('runSeedHook — http', () => {
  const ctx = { projectDir: '/tmp', appBaseUrl: 'http://localhost:3000', lifecyclePoint: 'beforeRun' as const };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('200 response → ok:true with status 200', async () => {
    mockFetch(200, 'seeded');
    const hook: SeedHook = { kind: 'http', method: 'POST', url: '/api/seed' };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.output).toBe('seeded');
  });

  it('500 response with default expectedStatus → ok:false', async () => {
    mockFetch(500, 'error');
    const hook: SeedHook = { kind: 'http', method: 'POST', url: '/api/seed', expectedStatus: 200 };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it('500 response with expectedStatus:[200,500] → ok:true', async () => {
    mockFetch(500, 'ok-ish');
    const hook: SeedHook = { kind: 'http', method: 'POST', url: '/api/seed', expectedStatus: [200, 500] };
    const result = await runSeedHook(hook, ctx);
    expect(result.ok).toBe(true);
  });

  it('relative URL with appBaseUrl → resolves correctly', async () => {
    const spy = vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('') });
    vi.stubGlobal('fetch', spy);
    const hook: SeedHook = { kind: 'http', method: 'GET', url: '/api/seed' };
    await runSeedHook(hook, ctx);
    expect(spy).toHaveBeenCalledWith(
      'http://localhost:3000/api/seed',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('relative URL with no appBaseUrl → reason contains seed: http hook', async () => {
    const hook: SeedHook = { kind: 'http', method: 'GET', url: '/api/seed' };
    const result = await runSeedHook(hook, { projectDir: '/tmp', lifecyclePoint: 'beforeRun' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/seed: http hook with relative URL but no appBaseUrl/);
  });

  it('output is truncated to 500 chars', async () => {
    const longBody = 'x'.repeat(1000);
    mockFetch(200, longBody);
    const hook: SeedHook = { kind: 'http', method: 'GET', url: 'http://example.com/seed' };
    const result = await runSeedHook(hook, ctx);
    expect(result.output?.length).toBeLessThanOrEqual(501);
  });
});

// ---------------------------------------------------------------------------
// runSeedHooksAt — error propagation
// ---------------------------------------------------------------------------

describe('runSeedHooksAt', () => {
  const ctx = { projectDir: '/tmp', lifecyclePoint: 'beforeRun' as const };

  it('returns empty array when hooks is undefined', async () => {
    const result = await runSeedHooksAt(undefined, ctx);
    expect(result).toEqual([]);
  });

  it('throws on first failure when continueOnError is not set', async () => {
    const hooks: SeedHook[] = [
      { kind: 'shell', command: 'false' },
      { kind: 'shell', command: 'echo should_not_run' },
    ];
    await expect(runSeedHooksAt(hooks, ctx)).rejects.toThrow(/beforeRun hook failed/);
  });

  it('continues past failure when continueOnError is true', async () => {
    const hooks: SeedHook[] = [
      { kind: 'shell', command: 'false', continueOnError: true },
      { kind: 'shell', command: 'echo second' },
    ];
    const results = await runSeedHooksAt(hooks, ctx);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });

  it('returns all executions in order', async () => {
    const hooks: SeedHook[] = [
      { kind: 'shell', command: 'echo a' },
      { kind: 'shell', command: 'echo b' },
    ];
    const results = await runSeedHooksAt(hooks, ctx);
    expect(results).toHaveLength(2);
    expect(results[0].output).toContain('a');
    expect(results[1].output).toContain('b');
  });
});
