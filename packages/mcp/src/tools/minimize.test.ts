import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-minimize-'));
  fs.mkdirSync(path.join(dir, '.bughunter'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.bughunter', 'config.json'),
    JSON.stringify({ projectName: 'test', surfaceMcpUrl: 'http://localhost:3100' }),
  );
  return dir;
}

function makeActionLog(dir: string, runId: string, occurrenceId: string, steps: number): void {
  const actionLogsDir = path.join(dir, '.bughunter', 'runs', runId, 'action-logs');
  fs.mkdirSync(actionLogsDir, { recursive: true });
  const actions = Array.from({ length: steps }, (_, i) => ({
    step: i,
    kind: 'navigate',
    url: `http://localhost/${i}`,
    timestamp: new Date().toISOString(),
  }));
  const log = {
    occurrenceId,
    runId,
    role: 'user',
    page: '/test',
    baseUrl: 'http://localhost',
    actions,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(actionLogsDir, `${occurrenceId}.json`), JSON.stringify(log, null, 2));
}

describe('bughunt_minimize', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerMinimizeTools } = await import('./minimize.js');
    registerMinimizeTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns not_found when action log missing', async () => {
    const runDir = path.join(projectDir, '.bughunter', 'runs', 'r1', 'action-logs');
    fs.mkdirSync(runDir, { recursive: true });
    const handler = getToolHandler(server, 'bughunt_minimize');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'missing' }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns cannot_repro when original log does not reproduce (AC-10, EC-M3)', async () => {
    makeActionLog(projectDir, 'r1', 'occ1', 3);
    const replayMod = await import('bughunter/src/repro/replay.js');
    vi.spyOn(replayMod, 'replayActionLog').mockResolvedValue({
      ok: true,
      observation: { consoleErrors: [], networkRequests: [] },
    });

    const handler = getToolHandler(server, 'bughunt_minimize');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'occ1' }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('cannot_repro');
    // No minimized.json written (AC-10)
    expect(fs.existsSync(path.join(projectDir, '.bughunter', 'runs', 'r1', 'action-logs', 'occ1.minimized.json'))).toBe(false);
  });

  it('handles 1-step log as-is without ddmin loop (EC-M1)', async () => {
    makeActionLog(projectDir, 'r1', 'occ1', 1);
    const replayMod = await import('bughunter/src/repro/replay.js');
    vi.spyOn(replayMod, 'replayActionLog').mockResolvedValue({
      ok: false,
      observation: { consoleErrors: [], networkRequests: [] },
      error: 'bug reproduced',
    });

    const handler = getToolHandler(server, 'bughunt_minimize');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'occ1' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as {
      ok: boolean; originalSteps: number; minimizedSteps: number; iterations: number;
    };
    expect(data.ok).toBe(true);
    expect(data.originalSteps).toBe(1);
    expect(data.minimizedSteps).toBe(1);
    expect(data.iterations).toBe(0);
  });

  it('minimizes a 5-step log where only step 2 is needed (AC-9 simplified)', async () => {
    makeActionLog(projectDir, 'r1', 'occ1', 5);
    const replayMod = await import('bughunter/src/repro/replay.js');

    vi.spyOn(replayMod, 'replayActionLog').mockImplementation(async (log) => {
      const hasStep2 = log.actions.some(a => (a as { url?: string }).url === 'http://localhost/2');
      return {
        ok: !hasStep2,
        observation: {
          consoleErrors: hasStep2 ? [{ message: 'bug' }] : [],
          networkRequests: [],
        },
      };
    });

    const handler = getToolHandler(server, 'bughunt_minimize');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'occ1', maxBudgetMs: 30000 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; minimizedSteps: number };
    expect(data.ok).toBe(true);
    expect(data.minimizedSteps).toBeLessThan(5);
    expect(data.minimizedSteps).toBeGreaterThanOrEqual(1);
  });
});

describe('bughunt_replay_minimized', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerMinimizeTools } = await import('./minimize.js');
    registerMinimizeTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns not_found when minimized log missing', async () => {
    const runDir = path.join(projectDir, '.bughunter', 'runs', 'r1', 'action-logs');
    fs.mkdirSync(runDir, { recursive: true });
    const handler = getToolHandler(server, 'bughunt_replay_minimized');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'occ1' }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('replays minimized log', async () => {
    const actionLogsDir = path.join(projectDir, '.bughunter', 'runs', 'r1', 'action-logs');
    fs.mkdirSync(actionLogsDir, { recursive: true });
    const minimized = {
      occurrenceId: 'occ1', runId: 'r1', role: 'user', page: '/', baseUrl: 'http://localhost',
      actions: [{ step: 0, kind: 'navigate', url: 'http://localhost/2', timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(actionLogsDir, 'occ1.minimized.json'), JSON.stringify(minimized));

    const replayMod = await import('bughunter/src/repro/replay.js');
    vi.spyOn(replayMod, 'replayActionLog').mockResolvedValue({
      ok: false,
      observation: { consoleErrors: [{ message: 'bug' }], networkRequests: [] },
    });

    const handler = getToolHandler(server, 'bughunt_replay_minimized');
    const result = await handler({ project: projectDir, runId: 'r1', occurrenceId: 'occ1' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean };
    expect(data.ok).toBe(false);
  });
});
