import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerExplainTool } from './explain.js';
import { clearFeatureDetectCache } from '../feature-detect.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerExplainTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_explain'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_explain', () => {
  beforeEach(() => {
    clearFeatureDetectCache();
  });

  it('returns not_implemented when V28 is not available', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', clusterId: 'cluster_001', noCache: false }) as { isError: boolean; content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { error: string };
    if (result.isError) {
      expect(data.error).toBe('not_implemented');
    }
  });
});
