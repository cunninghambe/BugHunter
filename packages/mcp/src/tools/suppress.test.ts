import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-suppress-'));
  fs.mkdirSync(path.join(dir, '.bughunter'), { recursive: true });
  return dir;
}

describe('bughunt_suppress', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerSuppressTools } = await import('./suppress.js');
    registerSuppressTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates suppressions.json on first suppress', async () => {
    const handler = getToolHandler(server, 'bughunt_suppress');
    const result = await handler({ project: projectDir, pattern: 'kind:console_error', reason: 'known flaky test noise' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; entryId: string };
    expect(data.ok).toBe(true);
    expect(data.entryId).toBeTruthy();

    const suppressions = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'suppressions.json'), 'utf-8')) as unknown[];
    expect(suppressions).toHaveLength(1);
  });

  it('appends to suppressions-audit.log', async () => {
    const handler = getToolHandler(server, 'bughunt_suppress');
    await handler({ project: projectDir, pattern: 'kind:console_error', reason: 'known flaky test noise' });
    const audit = fs.readFileSync(path.join(projectDir, '.bughunter', 'suppressions-audit.log'), 'utf-8');
    const record = JSON.parse(audit.split('\n').filter(Boolean)[0]) as { action: string };
    expect(record.action).toBe('add');
  });

  it('rejects reason shorter than 8 chars', async () => {
    const handler = getToolHandler(server, 'bughunt_suppress');
    const result = await handler({ project: projectDir, pattern: 'kind:x', reason: 'short' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns suppressed count for kind: pattern', async () => {
    const runDir = path.join(projectDir, '.bughunter', 'runs', 'run1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'bugs.jsonl'), JSON.stringify({ id: 'c1', kind: 'console_error' }) + '\n');

    const handler = getToolHandler(server, 'bughunt_suppress');
    const result = await handler({ project: projectDir, pattern: 'kind:console_error', reason: 'known flaky test noise' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { suppressed: number };
    expect(data.suppressed).toBe(1);
  });

  it('multiple suppresses produce multiple entries', async () => {
    const handler = getToolHandler(server, 'bughunt_suppress');
    await handler({ project: projectDir, pattern: 'kind:console_error', reason: 'known flaky noise 1' });
    await handler({ project: projectDir, pattern: 'kind:react_error', reason: 'known flaky noise 2' });
    const suppressions = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'suppressions.json'), 'utf-8')) as unknown[];
    expect(suppressions).toHaveLength(2);
  });
});

describe('bughunt_unsuppress', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerSuppressTools } = await import('./suppress.js');
    registerSuppressTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('removes entry by entryId', async () => {
    const suppress = getToolHandler(server, 'bughunt_suppress');
    const addResult = await suppress({ project: projectDir, pattern: 'kind:react_error', reason: 'known flaky test noise' }) as { content: [{ text: string }] };
    const { entryId } = JSON.parse(addResult.content[0].text) as { entryId: string };

    const unsuppress = getToolHandler(server, 'bughunt_unsuppress');
    const removeResult = await unsuppress({ project: projectDir, entryId }) as { content: [{ text: string }] };
    const data = JSON.parse(removeResult.content[0].text) as { removed: number };
    expect(data.removed).toBe(1);

    const suppressions = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'suppressions.json'), 'utf-8')) as unknown[];
    expect(suppressions).toHaveLength(0);
  });

  it('removes entry by pattern', async () => {
    const suppress = getToolHandler(server, 'bughunt_suppress');
    await suppress({ project: projectDir, pattern: 'kind:react_error', reason: 'known flaky test noise' });

    const unsuppress = getToolHandler(server, 'bughunt_unsuppress');
    const result = await unsuppress({ project: projectDir, pattern: 'kind:react_error' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { removed: number };
    expect(data.removed).toBe(1);
  });

  it('returns removed:0 when no match (EC-S1)', async () => {
    const unsuppress = getToolHandler(server, 'bughunt_unsuppress');
    const result = await unsuppress({ project: projectDir, entryId: 'nonexistent' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { removed: number };
    expect(data.removed).toBe(0);
  });

  it('fails when neither entryId nor pattern provided', async () => {
    const unsuppress = getToolHandler(server, 'bughunt_unsuppress');
    const result = await unsuppress({ project: projectDir }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('appends remove record to audit log', async () => {
    const suppress = getToolHandler(server, 'bughunt_suppress');
    const addResult = await suppress({ project: projectDir, pattern: 'kind:react_error', reason: 'known flaky test noise' }) as { content: [{ text: string }] };
    const { entryId } = JSON.parse(addResult.content[0].text) as { entryId: string };
    const unsuppress = getToolHandler(server, 'bughunt_unsuppress');
    await unsuppress({ project: projectDir, entryId });
    const lines = fs.readFileSync(path.join(projectDir, '.bughunter', 'suppressions-audit.log'), 'utf-8').split('\n').filter(Boolean);
    const removeRecord = JSON.parse(lines[1]) as { action: string };
    expect(removeRecord.action).toBe('remove');
  });
});
