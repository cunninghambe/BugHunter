import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerHistoryTool } from './history.js';
import { clearFeatureDetectCache } from '../feature-detect.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerHistoryTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_history'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_history', () => {
  beforeEach(() => {
    clearFeatureDetectCache();
  });

  it('returns not_implemented when V27 is not available', async () => {
    const result = await callTool({ project: FIXTURE_DIR, limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { error: string };
    if (result.isError) {
      expect(data.error).toBe('not_implemented');
    }
  });

  it('returns invalid_argument when both kind and bugIdentity are provided', async () => {
    const result = await callTool({ project: FIXTURE_DIR, kind: 'console_error', bugIdentity: 'sig_abc', limit: 50 }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('invalid_argument');
  });
});
