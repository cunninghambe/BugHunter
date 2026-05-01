import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerOccurrenceTool } from './occurrence.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerOccurrenceTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_occurrence'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_occurrence', () => {
  it('returns OccurrenceFull for occ_001a (fullArtifacts: true)', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', occurrenceId: 'occ_001a' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { occurrenceId: string; fullArtifacts: boolean };
    expect(data.occurrenceId).toBe('occ_001a');
    expect(data.fullArtifacts).toBe(true);
  });

  it('returns OccurrenceSummary for occ_001b (fullArtifacts: false)', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', occurrenceId: 'occ_001b' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { occurrenceId: string; fullArtifacts: boolean };
    expect(data.occurrenceId).toBe('occ_001b');
    expect(data.fullArtifacts).toBe(false);
  });

  it('returns not_found for unknown occurrence', async () => {
    const result = await callTool({ project: FIXTURE_DIR, runId: 'run_sample_001', occurrenceId: 'occ_UNKNOWN' }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });
});
