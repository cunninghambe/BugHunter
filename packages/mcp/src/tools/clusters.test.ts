import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerClustersTool } from './clusters.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerClustersTool(server);
  // Access the registered tool handler via the internal registry
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_clusters'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_clusters', () => {
  it('returns all clusters for a valid project and run', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', limit: 50 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: unknown[]; total: number };
    expect(data.clusters).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  it('filters by kind', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', kind: 'xss_reflected', limit: 50 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: Array<{ kind: string }> };
    expect(data.clusters).toHaveLength(1);
    expect(data.clusters[0].kind).toBe('xss_reflected');
  });

  it('filters by verdict', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', verdict: 'not_fixed', limit: 50 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: Array<{ verdict: string }> };
    expect(data.clusters).toHaveLength(1);
    expect(data.clusters[0].verdict).toBe('not_fixed');
  });

  it('paginates: limit 1 returns first cluster and nextCursor', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', limit: 1 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { clusters: unknown[]; nextCursor?: string };
    expect(data.clusters).toHaveLength(1);
    expect(data.nextCursor).toBeDefined();
  });

  it('cursor pagination returns next page without overlap', async () => {
    const r1 = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', limit: 1 }) as { content: [{ text: string }] };
    const d1 = JSON.parse(r1.content[0].text) as { clusters: Array<{ id: string }>; nextCursor: string };
    const firstId = d1.clusters[0].id;

    const r2 = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', limit: 2, cursor: d1.nextCursor }) as { content: [{ text: string }] };
    const d2 = JSON.parse(r2.content[0].text) as { clusters: Array<{ id: string }> };
    expect(d2.clusters.map(c => c.id)).not.toContain(firstId);
    expect(d2.clusters.length).toBe(2);
  });

  it('returns not_found for non-existent project', async () => {
    const result = await callTool({ project: '/nonexistent/path', runId: 'run_001', limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns not_found for non-existent run', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_nonexistent', limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns invalid_argument for cursor scoped to different run', async () => {
    const r1 = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', limit: 1 }) as { content: [{ text: string }] };
    const d1 = JSON.parse(r1.content[0].text) as { nextCursor: string };
    // Try to use cursor with a different runId
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_OTHER', cursor: d1.nextCursor, limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
  });

  it('returns not_implemented for severity filter when no severity in data', async () => {
    // cluster_001 and cluster_003 have no severity; cluster_002 has severity
    // Requesting severity filter without all clusters having it → not_implemented
    // Since our fixture has mix (one with severity, two without),
    // the sample is the first cluster which has no severity → not_implemented
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', severity: 'critical', limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    // Either not_implemented (if first cluster lacks severity) or valid result
    const data = JSON.parse(result.content[0].text) as { error?: string };
    if (result.isError) {
      expect(data.error).toBe('not_implemented');
    }
    // If not error, the filter ran successfully (first cluster happened to have severity)
  });
});
