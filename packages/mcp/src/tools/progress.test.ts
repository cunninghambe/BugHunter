import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerProgressTool } from './progress.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerProgressTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_progress'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_progress', () => {
  it('returns phase and counters for a valid run', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as {
      phase: string;
      startedAt: string;
      testsPlanned: number;
      testsRan: number;
      clusterCount: number;
      consecutiveInfraFailures: number;
      done: boolean;
    };
    expect(data.phase).toBe('done');
    expect(data.done).toBe(true);
    expect(data.clusterCount).toBe(3);
    expect(typeof data.startedAt).toBe('string');
  });

  it('returns not_found for non-existent run', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_NONEXISTENT' }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });
});
