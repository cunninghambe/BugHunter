import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerTailTool } from './tail.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerTailTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_tail'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_tail', () => {
  it('returns clusters and runDone for a completed run (no sinceClusterId)', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: unknown[]; runDone: boolean; asOfClusterId?: string };
    expect(typeof data.runDone).toBe('boolean');
    expect(Array.isArray(data.clusters)).toBe(true);
    // run_sample_001 is in 'done' phase
    expect(data.runDone).toBe(true);
  });

  it('returns clusters after sinceClusterId', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', sinceClusterId: 'cluster_001' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: Array<{ id: string }>; runDone: boolean };
    // Should return clusters after cluster_001 (i.e., cluster_002 and cluster_003)
    expect(data.clusters).toHaveLength(2);
    expect(data.clusters.map(c => c.id)).not.toContain('cluster_001');
  });

  it('returns empty clusters when sinceClusterId is the last cluster', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', sinceClusterId: 'cluster_003' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: unknown[] };
    expect(data.clusters).toHaveLength(0);
  });

  it('returns not_found for non-existent run', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_NONEXISTENT' }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });
});
