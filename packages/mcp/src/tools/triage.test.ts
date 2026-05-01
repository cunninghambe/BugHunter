import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-triage-'));
  fs.mkdirSync(path.join(dir, '.bughunter'), { recursive: true });
  return dir;
}

function addCluster(projectDir: string, runId: string, clusterId: string): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'bugs.jsonl'),
    JSON.stringify({ id: clusterId, kind: 'console_error', clusterSize: 1, rootCause: 'test', suspectedFiles: [], occurrences: [] }) + '\n',
  );
}

describe('bughunt_triage', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerTriageTool } = await import('./triage.js');
    registerTriageTool(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes triage.jsonl with mark', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const handler = getToolHandler(server, 'bughunt_triage');
    const result = await handler({ project: projectDir, runId: 'r1', clusterId: 'c1', mark: 'bug' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; triageEntryId: string };
    expect(data.ok).toBe(true);
    expect(data.triageEntryId).toBeTruthy();

    const lines = fs.readFileSync(path.join(projectDir, '.bughunter', 'triage.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const record = JSON.parse(lines[0]) as { clusterId: string; mark: string };
    expect(record.clusterId).toBe('c1');
    expect(record.mark).toBe('bug');
  });

  it('returns not_found when cluster missing (EC-T2)', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const handler = getToolHandler(server, 'bughunt_triage');
    const result = await handler({ project: projectDir, runId: 'r1', clusterId: 'nonexistent', mark: 'bug' }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('appends multiple triage records (EC-T1: latest wins)', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const handler = getToolHandler(server, 'bughunt_triage');
    await handler({ project: projectDir, runId: 'r1', clusterId: 'c1', mark: 'bug' });
    await handler({ project: projectDir, runId: 'r1', clusterId: 'c1', mark: 'known' });
    const lines = fs.readFileSync(path.join(projectDir, '.bughunter', 'triage.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const last = JSON.parse(lines[1]) as { mark: string };
    expect(last.mark).toBe('known');
  });

  it('includes optional note', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const handler = getToolHandler(server, 'bughunt_triage');
    await handler({ project: projectDir, runId: 'r1', clusterId: 'c1', mark: 'false-positive', note: 'test env only' });
    const line = fs.readFileSync(path.join(projectDir, '.bughunter', 'triage.jsonl'), 'utf-8').trim();
    const record = JSON.parse(line) as { note?: string };
    expect(record.note).toBe('test env only');
  });
});
