import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-baseline-'));
  fs.mkdirSync(path.join(dir, '.bughunter', 'runs'), { recursive: true });
  return dir;
}

const BASE_SUMMARY = {
  runId: 'r1',
  bugs_filed: 0, bugs_specced: 0, bugs_attempted_fix: 0,
  bugs_architect_refused: 0, bugs_verified_fixed: 0,
  partially_verified: 0, bugs_persistent: 0, bugs_skipped: 0,
  bugs_lost_to_revision: 0,
  byKind: {}, byRole: {},
  actualRuntimeMs: 1000, testsPlanned: 1, testsRan: 1, testsSkipped: 0,
  skippedReasons: [],
  vision: { enabled: true, called: 2, succeeded: 2, anomaliesFound: 0 },
  perfSummary: {
    vitalsByPage: {},
    longestTaskMs: 100,
    totalNetworkRequests: 5,
  },
};

function addRun(projectDir: string, runId: string, summary: typeof BASE_SUMMARY): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const screenshotsDir = path.join(runDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.writeFileSync(path.join(screenshotsDir, 'page1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary));
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ phase: 'done' }));
  fs.writeFileSync(path.join(runDir, 'bugs.jsonl'), '');
}

describe('bughunt_baseline_save', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerBaselineTools } = await import('./baseline.js');
    registerBaselineTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('saves visual baseline and creates current symlink', async () => {
    addRun(projectDir, 'r1', BASE_SUMMARY);
    const handler = getToolHandler(server, 'bughunt_baseline_save');
    const result = await handler({ project: projectDir, runId: 'r1', kind: 'visual' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; artifactCount: number };
    expect(data.ok).toBe(true);
    expect(data.artifactCount).toBe(1);

    const currentLink = path.join(projectDir, '.bughunter', 'baselines', 'visual', 'current');
    expect(fs.existsSync(currentLink)).toBe(true);
  });

  it('saves perf baseline', async () => {
    addRun(projectDir, 'r1', BASE_SUMMARY);
    const handler = getToolHandler(server, 'bughunt_baseline_save');
    const result = await handler({ project: projectDir, runId: 'r1', kind: 'perf' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; artifactCount: number };
    expect(data.ok).toBe(true);
    expect(data.artifactCount).toBeGreaterThan(0);
  });

  it('returns invalid_input when vision.called = 0 (EC-B1)', async () => {
    const noVisionSummary = { ...BASE_SUMMARY, vision: { enabled: true, called: 0, succeeded: 0, anomaliesFound: 0 } };
    addRun(projectDir, 'r1', noVisionSummary);
    const handler = getToolHandler(server, 'bughunt_baseline_save');
    const result = await handler({ project: projectDir, runId: 'r1', kind: 'visual' }) as { isError?: boolean; content: [{ text: string }] };
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toBe('invalid_input');
  });

  it('returns not_found for missing run', async () => {
    const handler = getToolHandler(server, 'bughunt_baseline_save');
    const result = await handler({ project: projectDir, runId: 'missing', kind: 'visual' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('overwrites baseline for same runId (EC-B3)', async () => {
    addRun(projectDir, 'r1', BASE_SUMMARY);
    const handler = getToolHandler(server, 'bughunt_baseline_save');
    await handler({ project: projectDir, runId: 'r1', kind: 'visual' });
    const result = await handler({ project: projectDir, runId: 'r1', kind: 'visual' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe('bughunt_baseline_compare', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerBaselineTools } = await import('./baseline.js');
    registerBaselineTools(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns not_found when no visual baseline (EC-B2)', async () => {
    addRun(projectDir, 'r1', BASE_SUMMARY);
    const handler = getToolHandler(server, 'bughunt_baseline_compare');
    const result = await handler({ project: projectDir, runId: 'r1', kind: 'visual' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('returns zero regressions for identical run after baseline save (AC-11)', async () => {
    addRun(projectDir, 'r1', BASE_SUMMARY);
    const saveHandler = getToolHandler(server, 'bughunt_baseline_save');
    await saveHandler({ project: projectDir, runId: 'r1', kind: 'visual' });

    const compareHandler = getToolHandler(server, 'bughunt_baseline_compare');
    const result = await compareHandler({ project: projectDir, runId: 'r1', kind: 'visual' }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as {
      ok: boolean;
      visual?: { regressions: unknown[]; unchanged: number };
    };
    expect(data.ok).toBe(true);
    expect(data.visual?.regressions).toHaveLength(0);
    expect(data.visual?.unchanged).toBeGreaterThan(0);
  });
});
