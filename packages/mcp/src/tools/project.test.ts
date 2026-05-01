import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerProjectDescribeTool } from './project.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerProjectDescribeTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_project_describe'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

type CheckResult = { name: string; status: string; detail: string; suggestion?: string };
type ProjectResult = { projectDir: string; ok: boolean; checks: CheckResult[] };

describe('bughunt_project_describe', () => {
  it('returns a structured report for a valid project', async () => {
    const result = await callTool({ projectDir: FIXTURE_DIR }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    expect(data.projectDir).toBe(FIXTURE_DIR);
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.checks.length).toBeGreaterThan(0);
  });

  it('never errors — always returns a report even for invalid directory', async () => {
    const result = await callTool({ projectDir: '/nonexistent/path/to/project' }) as { content: [{ text: string }]; isError?: boolean };
    // Should NOT be an error response — always returns a report
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    expect(Array.isArray(data.checks)).toBe(true);
  });

  it('reports error check for missing .bughunter directory', async () => {
    const result = await callTool({ projectDir: '/tmp' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    const bughunterCheck = data.checks.find(c => c.name === 'bughunterDir');
    expect(bughunterCheck?.status).toBe('error');
  });

  it('overall ok is false when any check is error', async () => {
    const result = await callTool({ projectDir: '/tmp' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    expect(data.ok).toBe(false);
  });

  it('reports bughunterDir ok for valid project', async () => {
    const result = await callTool({ projectDir: FIXTURE_DIR }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    const dirCheck = data.checks.find(c => c.name === 'bughunterDir');
    expect(dirCheck?.status).toBe('ok');
  });

  it('reports config ok for valid project with config.json', async () => {
    const result = await callTool({ projectDir: FIXTURE_DIR }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as ProjectResult;
    const configCheck = data.checks.find(c => c.name === 'config');
    expect(configCheck?.status).toBe('ok');
  });
});
