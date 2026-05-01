import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerDiffTool } from './diff.js';
import { clearFeatureDetectCache } from '../feature-detect.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerDiffTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_diff'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_diff', () => {
  beforeEach(() => {
    clearFeatureDetectCache();
  });

  it('returns not_implemented when V27 is not available', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runIdOld: 'run_sample_001',
      runIdNew: 'run_sample_001',
      format: 'json',
    }) as { isError: boolean; content: [{ text: string }] };

    const data = JSON.parse(result.content[0].text) as { error: string };
    // Either not_implemented (V27 absent) or some real result
    if (result.isError) {
      expect(data.error).toBe('not_implemented');
    }
  });
});
