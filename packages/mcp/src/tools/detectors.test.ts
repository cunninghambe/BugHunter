import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDetectorsTool } from './detectors.js';
import { clearFeatureDetectCache } from '../feature-detect.js';

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerDetectorsTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_detectors'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_detectors', () => {
  beforeEach(() => {
    clearFeatureDetectCache();
  });

  it('returns not_implemented or a list (depending on V26 availability)', async () => {
    const result = await callTool({}) as { isError?: boolean; content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { error?: string } | unknown[];

    if (result.isError === true) {
      // V26 not available
      expect((data as { error: string }).error).toBe('not_implemented');
    } else {
      // V26 available — should be an array
      expect(Array.isArray(data)).toBe(true);
    }
  });
});
