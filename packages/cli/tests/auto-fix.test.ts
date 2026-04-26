import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkForbiddenPaths } from '../src/auto-fix/forbidden-paths.js';
import type { BugCluster } from '../src/types.js';
import type { ClaudeMcpAdapter, ClaudeJobStatus } from '../src/adapters/claude-mcp.js';

// Mock node:fs so dispatch.ts's readFileSync is controllable per-test.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});

import * as fs from 'node:fs';
import { dispatchClusterFix } from '../src/auto-fix/dispatch.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCluster(id = 'cluster-1'): BugCluster {
  return {
    id,
    runId: 'run-1',
    kind: 'network_5xx',
    rootCause: 'Internal Server Error',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: ['src/api/route.ts'],
    fixHints: ['Check handler'],
    thirdPartyOrGenerated: false,
  };
}

function makeAdapter(): { adapter: ClaudeMcpAdapter; runCalls: Array<{ project: string; prompt: string }> } {
  const runCalls: Array<{ project: string; prompt: string }> = [];
  let jobCounter = 0;
  const adapter: ClaudeMcpAdapter = {
    claude_run: vi.fn().mockImplementation(async (args: { project: string; prompt: string }) => {
      runCalls.push({ project: args.project, prompt: args.prompt });
      jobCounter++;
      return { jobId: `job-${jobCounter}` };
    }),
    claude_job_status: vi.fn().mockResolvedValue({ state: 'done' } satisfies ClaudeJobStatus),
  };
  return { adapter, runCalls };
}

function mockSpecFile(content: string): void {
  vi.mocked(fs.readFileSync).mockReturnValue(content);
}

describe('per-cluster ClaudeMCP dispatch — two-phase (§ 3.9.1–3.9.2)', () => {
  it('dispatches TWO jobs per cluster (Phase A + Phase B)', async () => {
    mockSpecFile('# Valid spec content');
    const { adapter, runCalls } = makeAdapter();

    const cluster = makeCluster('c1');
    const result = await dispatchClusterFix(cluster, 'myproject', 'run-1', '/project', adapter);

    expect(adapter.claude_run).toHaveBeenCalledTimes(2);
    expect(runCalls).toHaveLength(2);
    expect(result.clusterId).toBe('c1');
    expect(result.architectJobId).toBe('job-1');
    expect(result.coderJobId).toBe('job-2');
    expect(result.bugsSkipped).toBeUndefined();
  });

  it('Phase A prompt includes architect role, cluster id, suspected files, spec path', async () => {
    mockSpecFile('# Spec');
    const { adapter, runCalls } = makeAdapter();

    await dispatchClusterFix(makeCluster('cluster-abc'), 'proj', 'run-1', '/proj', adapter);

    const architectPrompt = runCalls[0].prompt;
    expect(architectPrompt).toContain('You are an architect');
    expect(architectPrompt).toContain('cluster-abc');
    expect(architectPrompt).toContain('src/api/route.ts');
    expect(architectPrompt).toContain('.bughunter/runs/run-1/specs/cluster-abc.md');
    expect(architectPrompt).toContain('Do NOT implement');
  });

  it('Phase B prompt includes coder role, cluster id, spec path, forbidden paths', async () => {
    mockSpecFile('# Spec');
    const { adapter, runCalls } = makeAdapter();

    await dispatchClusterFix(makeCluster('cluster-xyz'), 'proj', 'run-1', '/proj', adapter);

    const coderPrompt = runCalls[1].prompt;
    expect(coderPrompt).toContain('You are a coder');
    expect(coderPrompt).toContain('cluster-xyz');
    expect(coderPrompt).toContain('prisma/schema.prisma');
    expect(coderPrompt).toContain('Do NOT push');
  });

  it('dispatches two jobs each for three clusters (total 6 claude_run calls)', async () => {
    mockSpecFile('# Some spec');
    const { adapter } = makeAdapter();

    const clusters = [makeCluster('c1'), makeCluster('c2'), makeCluster('c3')];
    for (const cluster of clusters) {
      await dispatchClusterFix(cluster, 'myproject', 'run-1', '/project', adapter);
    }

    expect(adapter.claude_run).toHaveBeenCalledTimes(6);
  });

  it('REFUSE: in spec skips Phase B and marks bugs_skipped: architect_refused', async () => {
    mockSpecFile('REFUSE: requires schema migration');
    const { adapter } = makeAdapter();

    const result = await dispatchClusterFix(makeCluster('cluster-refuse'), 'proj', 'run-1', '/proj', adapter);

    // Only Phase A dispatched
    expect(adapter.claude_run).toHaveBeenCalledTimes(1);
    expect(result.coderJobId).toBeUndefined();
    expect(result.bugsSkipped).toBeDefined();
    expect(result.bugsSkipped!.reason).toBe('architect_refused');
    expect(result.bugsSkipped!.detail).toBe('requires schema migration');
  });

  it('REFUSE: is detected even with leading blank lines in spec', async () => {
    mockSpecFile('\n\nREFUSE: forbidden path touched');
    const { adapter } = makeAdapter();

    const result = await dispatchClusterFix(makeCluster('cluster-refuse2'), 'proj', 'run-1', '/proj', adapter);

    expect(adapter.claude_run).toHaveBeenCalledTimes(1);
    expect(result.bugsSkipped?.reason).toBe('architect_refused');
  });

  it('polls claude_job_status after Phase A before dispatching Phase B', async () => {
    mockSpecFile('# Valid spec');
    const { adapter } = makeAdapter();

    await dispatchClusterFix(makeCluster('c1'), 'myproject', 'run-1', '/project', adapter);

    // job_status must be called for the Phase A job (job-1) before Phase B runs
    expect(adapter.claude_job_status).toHaveBeenCalledWith({ jobId: 'job-1' });
  });
});

describe('forbidden-path gate', () => {
  it('non-forbidden source files do not match forbidden patterns', async () => {
    const { default: micromatch } = await import('micromatch');
    const patterns = [
      'prisma/migrations/**',
      'prisma/schema.prisma',
      'package.json',
      '.env*',
      'node_modules/**',
    ];
    expect(micromatch(['src/api/route.ts'], patterns)).toHaveLength(0);
    expect(micromatch(['src/components/Button.tsx'], patterns)).toHaveLength(0);
  });

  it('pattern matching: prisma/schema.prisma matches forbidden pattern', async () => {
    const { default: micromatch } = await import('micromatch');
    const patterns = [
      'prisma/migrations/**',
      'prisma/schema.prisma',
      'package.json',
      '.env*',
      'node_modules/**',
    ];
    expect(micromatch(['prisma/schema.prisma'], patterns)).toHaveLength(1);
    expect(micromatch(['src/api/route.ts'], patterns)).toHaveLength(0);
    expect(micromatch(['.env.local'], patterns)).toHaveLength(1);
    expect(micromatch(['node_modules/react/index.js'], patterns)).toHaveLength(1);
  });
});

describe('resume validity', () => {
  it('refuses on revision mismatch without --force-resume', async () => {
    const { runValidate } = await import('../src/phases/validate.js');

    const mockSurface = {
      surface_list_tools: vi.fn().mockResolvedValue({ revision: 5, tools: [] }),
      surface_describe_tool: vi.fn(),
      surface_call: vi.fn(),
      surface_probe: vi.fn(),
      surface_sample_inputs: vi.fn(),
      surface_login_status: vi.fn().mockResolvedValue({ authenticated: true, refreshCount: 0 }),
      surface_relogin: vi.fn().mockResolvedValue({ ok: true }),
      surface_routes_for_page: vi.fn(),
    };

    const resumeState = {
      runId: 'r1',
      projectDir: '/proj',
      startedAt: new Date().toISOString(),
      phase: 'execute' as const,
      surfaceRevision: 3, // different from current 5
      config: {
        projectName: 'test',
        surfaceMcpUrl: 'http://127.0.0.1:3102/mcp',
        roles: ['owner'],
      },
      clusterCount: 0,
      infraFailureCount: 0,
      consecutiveInfraFailures: 0,
      emitted: false,
      partialEmit: false,
    };

    await expect(
      runValidate({
        surfaceMcp: mockSurface,
        config: resumeState.config,
        resumeState,
        forceResume: false,
      })
    ).rejects.toThrow(/revision changed/i);
  });

  it('allows resume with --force-resume on mismatch', async () => {
    const { runValidate } = await import('../src/phases/validate.js');

    const mockSurface = {
      surface_list_tools: vi.fn().mockResolvedValue({ revision: 5, tools: [] }),
      surface_describe_tool: vi.fn(),
      surface_call: vi.fn(),
      surface_probe: vi.fn(),
      surface_sample_inputs: vi.fn(),
      surface_login_status: vi.fn().mockResolvedValue({ authenticated: true, refreshCount: 0 }),
      surface_relogin: vi.fn().mockResolvedValue({ ok: true }),
      surface_routes_for_page: vi.fn(),
    };

    const resumeState = {
      runId: 'r1',
      projectDir: '/proj',
      startedAt: new Date().toISOString(),
      phase: 'execute' as const,
      surfaceRevision: 3,
      config: {
        projectName: 'test',
        surfaceMcpUrl: 'http://127.0.0.1:3102/mcp',
        roles: ['owner'],
      },
      clusterCount: 0,
      infraFailureCount: 0,
      consecutiveInfraFailures: 0,
      emitted: false,
      partialEmit: false,
    };

    await expect(
      runValidate({
        surfaceMcp: mockSurface,
        config: resumeState.config,
        resumeState,
        forceResume: true,
      })
    ).resolves.toBeDefined();
  });
});
