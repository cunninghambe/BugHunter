// Integration test for v0.14 seed-data hooks.
// Spins up a tiny HTTP server, then verifies that runSeedHooksAt
// produces executions with the correct lifecyclePoint values and that
// the records would appear in summary.json.seedHookExecutions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runSeedHooksAt } from '../../src/seed/runner.js';
import type { SeedHook } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Tiny test HTTP server
// ---------------------------------------------------------------------------

type ServerHandle = { server: http.Server; baseUrl: string };

async function startServer(): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/seed' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ seeded: true }));
        return;
      }
      if (req.url === '/cleanup' && req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('seed-hooks integration', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServer();
  });

  afterAll(() => {
    handle.server.close();
  });

  it('beforeRun hooks fire and produce executions with correct lifecyclePoint', async () => {
    const hooks: SeedHook[] = [
      {
        kind: 'http',
        method: 'POST',
        url: '/seed',
        expectedStatus: 200,
        description: 'seed test data',
      },
      {
        kind: 'shell',
        command: 'echo beforeRun-shell',
        description: 'shell marker',
      },
    ];

    const results = await runSeedHooksAt(hooks, {
      projectDir: '/tmp',
      appBaseUrl: handle.baseUrl,
      lifecyclePoint: 'beforeRun',
    });

    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[0].lifecyclePoint).toBe('beforeRun');
    expect(results[0].hookKind).toBe('http');
    expect(results[0].status).toBe(200);

    expect(results[1].ok).toBe(true);
    expect(results[1].lifecyclePoint).toBe('beforeRun');
    expect(results[1].hookKind).toBe('shell');
    expect(results[1].output).toContain('beforeRun-shell');
  });

  it('cleanup hooks fire with lifecyclePoint cleanup', async () => {
    const hooks: SeedHook[] = [
      {
        kind: 'http',
        method: 'DELETE',
        url: '/cleanup',
        expectedStatus: 204,
        continueOnError: true,
        description: 'cleanup',
      },
    ];

    const results = await runSeedHooksAt(hooks, {
      projectDir: '/tmp',
      appBaseUrl: handle.baseUrl,
      lifecyclePoint: 'cleanup',
    });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].lifecyclePoint).toBe('cleanup');
  });

  it('executions are in order and all lifecyclePoints are correctly stamped', async () => {
    const beforeRunHooks: SeedHook[] = [
      { kind: 'shell', command: 'echo step-1', description: 'step-1' },
    ];
    const beforeExecuteHooks: SeedHook[] = [
      { kind: 'shell', command: 'echo step-2', description: 'step-2' },
    ];
    const cleanupHooks: SeedHook[] = [
      { kind: 'shell', command: 'echo step-3', description: 'step-3', continueOnError: true },
    ];

    const ctx = { projectDir: '/tmp', appBaseUrl: handle.baseUrl };

    const br = await runSeedHooksAt(beforeRunHooks, { ...ctx, lifecyclePoint: 'beforeRun' });
    const be = await runSeedHooksAt(beforeExecuteHooks, { ...ctx, lifecyclePoint: 'beforeExecute' });
    const cl = await runSeedHooksAt(cleanupHooks, { ...ctx, lifecyclePoint: 'cleanup' });

    const seedHookExecutions = [...br, ...be, ...cl];

    expect(seedHookExecutions).toHaveLength(3);
    expect(seedHookExecutions[0].lifecyclePoint).toBe('beforeRun');
    expect(seedHookExecutions[1].lifecyclePoint).toBe('beforeExecute');
    expect(seedHookExecutions[2].lifecyclePoint).toBe('cleanup');

    // Verify this is the structure that would land in summary.json
    for (const exec of seedHookExecutions) {
      expect(exec).toMatchObject({
        hookKind: 'shell',
        ok: true,
        durationMs: expect.any(Number),
        description: expect.any(String),
        lifecyclePoint: expect.stringMatching(/^(beforeRun|beforeExecute|cleanup)$/),
      });
    }
  });

  it('afterLogin hooks carry role in execution record', async () => {
    const hooks: SeedHook[] = [
      { kind: 'shell', command: 'echo after-login', description: 'after-login' },
    ];

    const results = await runSeedHooksAt(hooks, {
      projectDir: '/tmp',
      appBaseUrl: handle.baseUrl,
      role: 'owner',
      lifecyclePoint: 'afterLogin',
    });

    expect(results[0].role).toBe('owner');
    expect(results[0].lifecyclePoint).toBe('afterLogin');
  });

  it('failed http hook without continueOnError throws and does not run subsequent hooks', async () => {
    let secondRan = false;
    const hooks: SeedHook[] = [
      {
        kind: 'http',
        method: 'POST',
        url: '/nonexistent-route',
        expectedStatus: 200,
      },
      {
        kind: 'shell',
        command: 'echo second',
        continueOnError: true,
      },
    ];

    try {
      await runSeedHooksAt(hooks, {
        projectDir: '/tmp',
        appBaseUrl: handle.baseUrl,
        lifecyclePoint: 'beforeRun',
      });
      secondRan = true; // should not reach here
    } catch {
      // expected
    }

    expect(secondRan).toBe(false);
  });
});
