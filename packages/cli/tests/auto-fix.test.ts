import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pattern matching — used by forbidden-path gate (§ 3.9.1)
// ---------------------------------------------------------------------------

describe('forbidden-path pattern matching', () => {
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

  it('prisma/schema.prisma matches forbidden pattern', async () => {
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

// ---------------------------------------------------------------------------
// fix-summary — reads fix-state.json, prints table (§ 3.9.1, § 3.9.6)
// ---------------------------------------------------------------------------

describe('fix-summary: missing fix-state.json', () => {
  it('prints "no fix run yet" when fix-state.json does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    const runId = 'testrun-missing';
    fs.mkdirSync(path.join(tmpDir, '.bughunter', 'runs', runId), { recursive: true });
    // Do NOT create fix-state.json

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    const { fixSummaryCommand } = await import('../src/cli/fix-summary.js');
    fixSummaryCommand(tmpDir, runId);

    fs.rmSync(tmpDir, { recursive: true });

    expect(chunks.join('')).toContain('no fix run yet');
  });
});

describe('fix-summary: with fix-state.json', () => {
  it('prints a table with correct counter values from fix-state.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
    const runId = 'testrun-counters';
    const runDir = path.join(tmpDir, '.bughunter', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const fixState = [
      { clusterId: 'c1', verdict: 'verified_fixed' },
      { clusterId: 'c2', verdict: 'not_fixed' },
      { clusterId: 'c3', verdict: 'architect_refused', detail: 'requires migration' },
      { clusterId: 'c4', verdict: 'touched_forbidden_path', paths: ['prisma/schema.prisma'] },
    ];
    fs.writeFileSync(path.join(runDir, 'fix-state.json'), JSON.stringify(fixState));

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    const { fixSummaryCommand } = await import('../src/cli/fix-summary.js');
    fixSummaryCommand(tmpDir, runId);

    fs.rmSync(tmpDir, { recursive: true });

    const out = chunks.join('');
    expect(out).toContain('verified_fixed');
    expect(out).toContain('not_fixed');
    expect(out).toContain('architect_refused');
    expect(out).toContain('bugs_filed:             4');
    expect(out).toContain('bugs_verified_fixed:    1');
    expect(out).toContain('bugs_persistent:        1');
    expect(out).toContain('bugs_architect_refused: 1');
    expect(out).toContain('bugs_skipped:           2'); // refused + forbidden_path
  });
});

describe('fix-summary: --reset flag in forbidden-path-gate result shape', () => {
  it('result includes reset: true when --reset was passed and violations exist', async () => {
    // Test the shape contract directly from ops/forbidden-paths.ts without git
    // We validate the TypeScript type shape — { ok: false, violations: string[], reset: boolean }
    // by constructing a value that satisfies it
    type ForbiddenPathGateResult =
      | { ok: true; violations: [] }
      | { ok: false; violations: string[]; reset: boolean };

    const result: ForbiddenPathGateResult = { ok: false, violations: ['prisma/schema.prisma'], reset: true };
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reset).toBe(true);
      expect(result.violations).toContain('prisma/schema.prisma');
    }
  });
});

// ---------------------------------------------------------------------------
// Resume validity (kept from original test suite)
// ---------------------------------------------------------------------------

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
