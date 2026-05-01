import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fixcoord-'));
  fs.mkdirSync(path.join(dir, '.bughunter', 'runs'), { recursive: true });
  return dir;
}

function addCluster(projectDir: string, runId: string, clusterId: string): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'bugs.jsonl'),
    JSON.stringify({ id: clusterId, kind: 'console_error', clusterSize: 1, rootCause: 'test', suspectedFiles: [], occurrences: [], replayKind: 'action_log' }) + '\n',
  );
}

describe('bughunt_fix_dispatch', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const mod = await import('./fix-coord.js');
    mod.fixJobs.clear();
    mod.registerFixCoordTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns not_found for missing cluster (EC-F1)', async () => {
    const handler = getToolHandler(server, 'bughunt_fix_dispatch');
    const result = await handler({
      project: projectDir, runId: 'r1', clusterId: 'nonexistent',
      agent: 'coder', model: 'claude-3-5-sonnet', prompt: 'fix the bug',
    }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('not_found');
  });

  it('returns forbidden when binary has path component outside allowlist (AC-15)', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const handler = getToolHandler(server, 'bughunt_fix_dispatch');
    const result = await handler({
      project: projectDir, runId: 'r1', clusterId: 'c1',
      agent: 'coder', model: 'claude-3-5-sonnet', prompt: 'fix the bug',
      binary: '/usr/bin/malicious',
    }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('forbidden');
  });

  it('returns conflict when too many concurrent jobs (AC-13)', async () => {
    addCluster(projectDir, 'r1', 'c1');
    const { fixJobs } = await import('./fix-coord.js');
    // Simulate MAX_CONCURRENT_FIX_JOBS running jobs
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < 4; i++) {
      const t = setTimeout(() => undefined, 99999);
      timers.push(t);
      fixJobs.set(`job${i}`, {
        jobId: `job${i}`, runId: 'r1', clusterId: 'c1',
        pid: 99999, child: {} as never, startedAt: Date.now(),
        state: 'running', logPath: '', metaPath: '',
        killTimer: t,
      });
    }

    const handler = getToolHandler(server, 'bughunt_fix_dispatch');
    const result = await handler({
      project: projectDir, runId: 'r1', clusterId: 'c1',
      agent: 'coder', model: 'claude-3-5-sonnet', prompt: 'fix the bug',
    }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('conflict');

    // Cleanup
    for (const t of timers) clearTimeout(t);
    fixJobs.clear();
  });
});

describe('bughunt_fix_status', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const mod = await import('./fix-coord.js');
    mod.fixJobs.clear();
    mod.registerFixCoordTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns empty state when no fix run exists', async () => {
    const runDir = path.join(projectDir, '.bughunter', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    const handler = getToolHandler(server, 'bughunt_fix_status');
    const result = await handler({ project: projectDir, runId: 'r1' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; fixState: unknown[]; liveJobs: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.fixState).toHaveLength(0);
    expect(data.liveJobs).toHaveLength(0);
  });

  it('returns not_found when run does not exist', async () => {
    const handler = getToolHandler(server, 'bughunt_fix_status');
    const result = await handler({ project: projectDir, runId: 'norun' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('includes fix-state.json data when present', async () => {
    const runDir = path.join(projectDir, '.bughunter', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'fix-state.json'), JSON.stringify([
      { clusterId: 'c1', verdict: 'verified_fixed' },
    ]));
    const handler = getToolHandler(server, 'bughunt_fix_status');
    const result = await handler({ project: projectDir, runId: 'r1' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as {
      fixState: Array<{ clusterId: string; verdict: string }>;
      counters: { bugs_verified_fixed: number };
    };
    expect(data.fixState).toHaveLength(1);
    expect(data.counters.bugs_verified_fixed).toBe(1);
  });
});

describe('bughunt_fix_gate', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const mod = await import('./fix-coord.js');
    mod.fixJobs.clear();
    mod.registerFixCoordTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns ok:true for branch with no forbidden-path violations', async () => {
    const forbiddenMod = await import('bughunter/src/ops/forbidden-paths.js');
    vi.spyOn(forbiddenMod, 'forbiddenPathGate').mockReturnValue({ ok: true, violations: [] });

    const handler = getToolHandler(server, 'bughunt_fix_gate');
    const result = await handler({
      project: projectDir, runId: 'r1', clusterId: 'c1',
      branch: 'fix/r1/c1', baseBranch: 'main', reset: false,
    }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; violations: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.violations).toHaveLength(0);
  });

  it('returns ok:false with violations when forbidden paths changed', async () => {
    const forbiddenMod = await import('bughunter/src/ops/forbidden-paths.js');
    vi.spyOn(forbiddenMod, 'forbiddenPathGate').mockReturnValue({ ok: false, violations: ['package.json'], reset: false });

    const handler = getToolHandler(server, 'bughunt_fix_gate');
    const result = await handler({ project: projectDir, runId: 'r1', clusterId: 'c1', branch: 'fix/r1/c1' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; violations: string[] };
    expect(data.ok).toBe(false);
    expect(data.violations).toContain('package.json');
  });
});
