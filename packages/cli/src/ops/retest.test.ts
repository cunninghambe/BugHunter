// Tests for retest op static-rerun dispatch (§ retest-fix-static-rerun spec).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retestCluster } from './retest.js';
import * as runnerModule from '../static/runner.js';
import type { BugCluster, BugDetection, Occurrence } from '../types.js';
import type { StaticToolRun } from '../static/runner.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOccurrence(): Occurrence {
  return {
    occurrenceId: 'occ-1',
    testId: 'test-1',
    role: 'system',
    page: '/test',
    action: { kind: 'render', via: 'api', expectedOutcome: 'success', palette: 'happy' },
    fullArtifacts: false,
    timestamp: new Date().toISOString(),
  };
}

function makeCluster(overrides: Partial<BugCluster>): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-1',
    kind: 'vulnerable_dependency_high',
    rootCause: 'lodash has CVE-2021-xxxx',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    clusterSize: 1,
    occurrences: [makeOccurrence()],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    replayKind: 'static_rerun',
    signatureKey: 'sig-lodash',
    ...overrides,
  };
}

function makeSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ tools: [] }),
    surface_list_navigations: vi.fn().mockResolvedValue({ navigations: [] }),
    surface_reload_catalog: vi.fn().mockResolvedValue({}),
  } as unknown as SurfaceMcpAdapter;
}

function writeClusterToTmp(projectDir: string, runId: string, cluster: BugCluster): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'bugs.jsonl'), JSON.stringify(cluster) + '\n');
}

function makeToolRun(detections: BugDetection[]): StaticToolRun {
  return { toolId: 'npm-audit', detections, warnings: [], skipped: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retestCluster — static-rerun dispatch', () => {
  let tmpDir: string;
  let runStaticToolSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retest-test-'));
    runStaticToolSpy = vi.spyOn(runnerModule, 'runStaticTool');
  });

  afterEach(() => {
    runStaticToolSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns verified_fixed_static when rerunner finds no detections with matching signature', async () => {
    const cluster = makeCluster({ kind: 'vulnerable_dependency_high', signatureKey: 'sig-lodash' });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    // Rerunner returns detections with a DIFFERENT signature key
    const freshDetection: BugDetection = {
      kind: 'vulnerable_dependency_high',
      rootCause: 'different package CVE',
    };
    runStaticToolSpy.mockResolvedValue(makeToolRun([freshDetection]));

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());

    // The fresh detection has a different clusterSignature than 'sig-lodash', so stillPresent=false
    expect(result.verdict).toBe('verified_fixed_static');
    expect(result.replayedOccurrences).toBe(1);
    expect(result.passedOccurrences).toBe(1);
  });

  it('returns not_fixed_static when rerunner produces a detection with matching signature', async () => {
    // We need the fresh detection to produce the same clusterSignature as signatureKey
    // The simplest way: let signatureKey be undefined so expectedSignature falls back to proxy,
    // and the fresh detection matches the proxy
    const cluster = makeCluster({
      kind: 'vulnerable_dependency_high',
      rootCause: 'lodash has CVE-2021-xxxx',
      signatureKey: undefined,
    });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    // Fresh detection matches the cluster (same kind + rootCause → same proxy signature)
    const freshDetection: BugDetection = {
      kind: 'vulnerable_dependency_high',
      rootCause: 'lodash has CVE-2021-xxxx',
    };
    runStaticToolSpy.mockResolvedValue(makeToolRun([freshDetection]));

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());
    expect(result.verdict).toBe('not_fixed_static');
    expect(result.passedOccurrences).toBe(0);
  });

  it('returns cannot_retest for a static_rerun kind with no TOOL_RERUNNER entry', async () => {
    // seo_title_missing is in STATIC_RERUN_KINDS but has no TOOL_RERUNNERS entry
    const cluster = makeCluster({ kind: 'seo_title_missing', replayKind: 'static_rerun' });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());
    expect(result.verdict).toBe('cannot_retest');
    expect(runStaticToolSpy).not.toHaveBeenCalled();
  });

  it('returns cannot_retest when the static rerunner throws', async () => {
    const cluster = makeCluster({ kind: 'vulnerable_dependency_high', replayKind: 'static_rerun' });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    runStaticToolSpy.mockRejectedValue(new Error('npm not found'));

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());
    expect(result.verdict).toBe('cannot_retest');
    expect(result.detail).toMatch(/npm not found/);
  });

  it('returns cannot_retest for unrunable replayKind', async () => {
    const cluster = makeCluster({ replayKind: 'unrunable' });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());
    expect(result.verdict).toBe('cannot_retest');
    expect(runStaticToolSpy).not.toHaveBeenCalled();
  });

  it('dispatches to action_log path for action_log replayKind (no action-log → not_fixed)', async () => {
    // action_log path tries to read action-log files; with no fullArtifacts occurrences
    // and no lightweight-only cluster, it returns not_fixed (replayedOccurrences === 0)
    const cluster = makeCluster({
      kind: 'console_error',
      replayKind: 'action_log',
      occurrences: [makeOccurrence()], // OccurrenceSummary: fullArtifacts=false
    });
    writeClusterToTmp(tmpDir, 'run-1', cluster);

    const result = await retestCluster(tmpDir, 'run-1', 'cluster-1', makeSurface());
    // replayedOccurrences === 0 because there are no fullArtifacts occs → not_fixed
    expect(result.verdict).toBe('not_fixed');
    expect(runStaticToolSpy).not.toHaveBeenCalled();
  });
});
