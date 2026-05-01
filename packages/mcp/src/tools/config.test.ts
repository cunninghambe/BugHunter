import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerConfigGetTool } from './config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerConfigGetTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_config_get'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_config_get', () => {
  it('returns raw config when resolved: false', async () => {
    const result = await callTool({ projectDir: FIXTURE_DIR, resolved: false }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { projectName: string; surfaceMcpUrl: string };
    expect(data.projectName).toBe('sample-project');
    expect(data.surfaceMcpUrl).toBe('http://localhost:3001');
  });

  it('returns config (resolved or raw) when resolved: true', async () => {
    const result = await callTool({ projectDir: FIXTURE_DIR, resolved: true }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { projectName: string };
    // The resolved config will either be parsed or fall back to raw with a note
    expect(data.projectName).toBe('sample-project');
  });

  it('returns not_found for project without config.json', async () => {
    const result = await callTool({ projectDir: '/tmp', resolved: false }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns not_found for non-existent project directory', async () => {
    const result = await callTool({ projectDir: '/nonexistent', resolved: false }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
  });
});
