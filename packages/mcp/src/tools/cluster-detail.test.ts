import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerClusterDetailTool } from './cluster-detail.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerClusterDetailTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_cluster_detail'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_cluster_detail', () => {
  it('returns full cluster for a known clusterId', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', clusterId: 'cluster_001' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { id: string; occurrences: unknown[] };
    expect(data.id).toBe('cluster_001');
    expect(data.occurrences).toHaveLength(2);
  });

  it('returns not_found for unknown clusterId', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', clusterId: 'cluster_UNKNOWN' }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('includes verdict when present', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', clusterId: 'cluster_002' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { verdict: string };
    expect(data.verdict).toBe('not_fixed');
  });

  it('returns not_found for non-existent project', async () => {
    const result = await callTool({ project: '/nonexistent', runId: 'run_001', clusterId: 'c1' }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
  });
});
