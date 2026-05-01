import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerArtifactTool } from './artifact.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../test-fixtures/sample-run');

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerArtifactTool(server);
  const registered = (server as unknown as { _registeredTools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }> })._registeredTools;
  const handler = registered['bughunt_artifact'];
  if (handler === undefined) throw new Error('Tool not registered');
  return handler.handler(args);
}

describe('bughunt_artifact', () => {
  it('returns base64 for screenshot (binary artifact)', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
      occurrenceId: 'occ_001a',
      kind: 'screenshot',
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { kind: string; contentType: string; base64: string; bytes: number };
    expect(data.kind).toBe('screenshot');
    expect(data.contentType).toBe('image/png');
    expect(typeof data.base64).toBe('string');
    expect(data.base64.length).toBeGreaterThan(0);
    expect(data.bytes).toBeGreaterThan(0);
  });

  it('returns text for console log (text artifact)', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
      occurrenceId: 'occ_001a',
      kind: 'console',
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { kind: string; contentType: string; text: string };
    expect(data.kind).toBe('console');
    expect(data.contentType).toBe('application/x-ndjson');
    expect(typeof data.text).toBe('string');
  });

  it('returns not_found for OccurrenceSummary (fullArtifacts: false)', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
      occurrenceId: 'occ_001b',
      kind: 'screenshot',
    }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns not_found for missing artifact file', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
      occurrenceId: 'occ_001a',
      kind: 'dom',
    }) as { isError: boolean; content: [{ text: string }] };
    // dom/occ_001a.html doesn't exist in fixtures
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns not_found for unknown occurrence', async () => {
    const result = await callTool({
      project: FIXTURE_DIR,
      runId: 'run_sample_001',
      occurrenceId: 'occ_UNKNOWN',
      kind: 'screenshot',
    }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
  });
});
