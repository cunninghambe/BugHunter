/**
 * Integration tests for CamofoxBrowserMcpAdapter — §7.3.
 *
 * Gated behind RUN_INTEGRATION=1 environment variable.
 * These tests spawn a real camofox-mcp subprocess and navigate a real page.
 *
 * Usage:
 *   RUN_INTEGRATION=1 npm test -- src/adapters/browser-mcp.integration.test.ts
 *
 * Prerequisites:
 *   - camofox-browser running on port 9377
 *   - camofox-mcp binary at /opt/camofox-mcp/dist/index.js
 *   - A local HTTP server or public URL accessible from this machine
 */

import { describe, it, expect } from 'vitest';
import { CamofoxBrowserMcpAdapter } from './browser-mcp.js';

const RUN_INTEGRATION = Boolean(process.env['RUN_INTEGRATION']);

// Conservative: use a local server that's likely running in CI.
// Can be overridden via INTEGRATION_TARGET_URL env var.
const TARGET_URL = process.env['INTEGRATION_TARGET_URL'] ?? 'http://localhost:8787';

describe.skipIf(!RUN_INTEGRATION)('CamofoxBrowserMcpAdapter — live camofox-mcp (stdio)', () => {
  it('navigates a real page over stdio transport', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
    });

    try {
      const result = await adapter.navigate(TARGET_URL);
      expect(result.url).toContain('localhost');
    } finally {
      await adapter.dispose();
    }
  });

  it('takes a snapshot over stdio transport', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
    });

    try {
      await adapter.navigate(TARGET_URL);
      const result = await adapter.snapshot();
      expect(typeof result.snapshot).toBe('string');
    } finally {
      await adapter.dispose();
    }
  });

  it('lists tabs over stdio transport', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
    });

    try {
      await adapter.navigate(TARGET_URL);
      const result = await adapter.listTabs();
      expect(result.tabs.length).toBeGreaterThan(0);
    } finally {
      await adapter.dispose();
    }
  });

  it('dispose() cleans up without hanging', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
    });

    await adapter.navigate(TARGET_URL);
    // Should complete within 5 seconds
    await Promise.race([
      adapter.dispose(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('dispose() timed out')), 5000),
      ),
    ]);
  });
});

describe.skipIf(!RUN_INTEGRATION)('CamofoxBrowserMcpAdapter — live camofox-mcp (mcp-http)', () => {
  it('navigates a real page over HTTP transport', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'http',
      url: 'http://127.0.0.1:3104/mcp',
    });

    try {
      const result = await adapter.navigate(TARGET_URL);
      expect(result.url).toContain('localhost');
    } finally {
      await adapter.dispose();
    }
  });
});
