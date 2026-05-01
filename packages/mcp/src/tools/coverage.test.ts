import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// We need to call registerTools which registers bughunt_coverage.
// Import it from the top-level tools module.
import { registerTools } from '../tools.js';

async function callCoverage(args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerTools(server);
  const registered = (server as unknown as {
    _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  })._registeredTools;
  const handler = registered['bughunt_coverage'];
  if (handler === undefined) throw new Error('bughunt_coverage not registered');
  return handler.handler(args);
}

function writeSampleCoverage(runDir: string, runId: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  const coverage = {
    version: 1,
    runId,
    generatedAt: '2026-04-30T10:00:00.000Z',
    byKind: {
      console_error: { detectorWired: true, inputObserved: false, clustersEmitted: 0, status: 'input-absent' },
    },
    summary: { kindsTotal: 1, kindsWiredAndFired: 0, kindsWiredButInputAbsent: 1, kindsDead: 0, kindsDeferred: 0 },
  };
  fs.writeFileSync(path.join(runDir, 'coverage.json'), JSON.stringify(coverage, null, 2));
}

describe('bughunt_coverage MCP tool', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-mcp-cov-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns toolOk with the verbatim file contents when coverage.json is present', async () => {
    const runId = 'run_mcp_001';
    const runDir = path.join(tmpDir, '.bughunter', 'runs', runId);
    writeSampleCoverage(runDir, runId);

    const result = await callCoverage({ project: tmpDir, runId }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { version: number; runId: string; summary: unknown };
    expect(data.version).toBe(1);
    expect(data.runId).toBe(runId);
    expect(data.summary).toBeDefined();
  });

  it('resolves most-recent run when runId is omitted', async () => {
    const runId = 'run_mcp_002';
    const runDir = path.join(tmpDir, '.bughunter', 'runs', runId);
    writeSampleCoverage(runDir, runId);

    const result = await callCoverage({ project: tmpDir }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as { runId: string };
    expect(data.runId).toBe(runId);
  });

  it('returns toolErr coverage_unavailable when coverage.json is missing', async () => {
    const runId = 'run_mcp_no_cov';
    const runDir = path.join(tmpDir, '.bughunter', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    // No coverage.json written

    const result = await callCoverage({ project: tmpDir, runId }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('coverage_unavailable');
  });

  it('returns toolErr no_runs when the runs directory is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs'), { recursive: true });

    const result = await callCoverage({ project: tmpDir }) as { isError: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('no_runs');
  });
});
