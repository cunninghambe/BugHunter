import { describe, it, expect, vi } from 'vitest';
import { dispatchClusterFix } from '../src/auto-fix/dispatch.js';
import { checkForbiddenPaths } from '../src/auto-fix/forbidden-paths.js';
import type { BugCluster } from '../src/types.js';
import type { ClaudeMcpAdapter } from '../src/adapters/claude-mcp.js';

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

describe('per-cluster ClaudeMCP dispatch', () => {
  it('dispatches one job per cluster', async () => {
    const jobs: string[] = [];
    const mockAdapter: ClaudeMcpAdapter = {
      claude_run: vi.fn().mockImplementation(async (args: { project: string; prompt: string }) => {
        jobs.push(args.project);
        return { jobId: `job-${jobs.length}` };
      }),
      claude_job_status: vi.fn(),
    };

    const clusters = [makeCluster('c1'), makeCluster('c2'), makeCluster('c3')];

    for (const cluster of clusters) {
      const result = await dispatchClusterFix(cluster, 'myproject', 'run-1', '/project', mockAdapter);
      expect(result.clusterId).toBe(cluster.id);
      expect(result.jobId).toMatch(/^job-/);
    }

    expect(mockAdapter.claude_run).toHaveBeenCalledTimes(3);
    expect(jobs).toHaveLength(3);
  });

  it('prompt includes cluster id, suspectedFiles, and forbidden paths note', async () => {
    let capturedPrompt = '';
    const mockAdapter: ClaudeMcpAdapter = {
      claude_run: vi.fn().mockImplementation(async (args: { prompt: string }) => {
        capturedPrompt = args.prompt;
        return { jobId: 'job-1' };
      }),
      claude_job_status: vi.fn(),
    };

    const cluster = makeCluster('cluster-abc');
    await dispatchClusterFix(cluster, 'proj', 'run-1', '/proj', mockAdapter);

    expect(capturedPrompt).toContain('cluster-abc');
    expect(capturedPrompt).toContain('prisma/schema.prisma');
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
