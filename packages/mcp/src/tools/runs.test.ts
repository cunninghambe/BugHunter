import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerRunsListTool, registerRunSummaryTool } from './runs.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(name: string, register: (s: McpServer) => void, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  register(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered[name];
  if (handler === undefined) throw new Error(`Tool ${name} not registered`);
  return handler.handler(args);
}

describe('bughunt_runs_list', () => {
  it('lists runs for a project, sorted descending by startedAt', async () => {
    const result = await callTool('bughunt_runs_list', registerRunsListTool, { project: FIXTURE_DIR, limit: 20 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as Array<{ runId: string; startedAt: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].runId).toBe('run_sample_001');
  });

  it('returns invalid_argument when project is omitted', async () => {
    const result = await callTool('bughunt_runs_list', registerRunsListTool, { limit: 20 }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('invalid_argument');
  });

  it('filters by since', async () => {
    const result = await callTool('bughunt_runs_list', registerRunsListTool, {
      project: FIXTURE_DIR,
      since: '2026-04-30T09:00:00.000Z',
      limit: 20,
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as Array<{ startedAt: string }>;
    expect(data).toHaveLength(1);
  });

  it('filters out runs before since', async () => {
    const result = await callTool('bughunt_runs_list', registerRunsListTool, {
      project: FIXTURE_DIR,
      since: '2026-05-01T00:00:00.000Z',
      limit: 20,
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as unknown[];
    expect(data).toHaveLength(0);
  });
});

describe('bughunt_run_summary', () => {
  it('returns the full RunSummary for a completed run', async () => {
    const result = await callTool('bughunt_run_summary', registerRunSummaryTool, {
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { runId: string; bugs_filed: number };
    expect(data.runId).toBe('run_sample_001');
    expect(data.bugs_filed).toBe(3);
  });

  it('returns not_found for a run without summary.json', async () => {
    // run_no_summary won't have a summary.json
    const result = await callTool('bughunt_run_summary', registerRunSummaryTool, {
      project: FIXTURE_DIR,
      runId: 'run_NONEXISTENT',
    }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });
});
