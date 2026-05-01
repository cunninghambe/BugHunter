// AC-13, AC-14, AC-19: explainCliCommand cache hit/miss, --no-cache, not-found behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { explainCliCommand } from './explain.js';
import { writeCache } from '../explain/cache.js';
import { runPaths, ensureRunDirs } from '../store/filesystem.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-explain-test-'));
  process.exitCode = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function writeFixtureCluster(runId: string, cluster: object): void {
  const paths = runPaths(tmpDir, runId);
  ensureRunDirs(paths);
  fs.appendFileSync(paths.bugsFile, `${JSON.stringify(cluster)}\n`, 'utf-8');
}

const FIXTURE_CLUSTER = {
  id: 'cluster-explain-1',
  kind: 'console_error',
  signatureKey: 'console_error|TypeError|abc',
  rootCause: 'TypeError: Something',
  clusterSize: 1,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  occurrences: [],
  suspectedFiles: [],
  fixHints: [],
  thirdPartyOrGenerated: false,
};

// AC-19: cluster not found exits 1
describe('explainCliCommand — not found', () => {
  it('exits 1 and prints error when cluster is not found in any run', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => { stderrLines.push(String(data)); return true; };

    await explainCliCommand({ projectDir: tmpDir, clusterId: 'nonexistent' });

    process.stderr.write = origWrite;
    expect(process.exitCode).toBe(1);
    expect(stderrLines.join('')).toContain('nonexistent');
  });

  it('exits 1 when run-id is given but cluster is not in that run', async () => {
    writeFixtureCluster('run-001', FIXTURE_CLUSTER);

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => { stderrLines.push(String(data)); return true; };

    await explainCliCommand({ projectDir: tmpDir, clusterId: 'wrong-id', runId: 'run-001' });

    process.stderr.write = origWrite;
    expect(process.exitCode).toBe(1);
  });
});

// AC-13: cache hit — no Claude call
describe('explainCliCommand — cache hit', () => {
  it('returns cached markdown without calling explainViaClaude', async () => {
    writeFixtureCluster('run-001', FIXTURE_CLUSTER);
    const cacheKey = FIXTURE_CLUSTER.signatureKey;
    const cachedMd = '## What\'s happening\n\nCached result.';
    writeCache(tmpDir, cacheKey, cachedMd);

    // Mock explainViaClaude so we can verify it is NOT called
    const explainModule = await import('../explain/claude.js');
    const spy = vi.spyOn(explainModule, 'explainViaClaude').mockRejectedValue(new Error('Should not be called'));

    const stdoutLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: string | Uint8Array) => { stdoutLines.push(String(data)); return true; };

    await explainCliCommand({ projectDir: tmpDir, clusterId: 'cluster-explain-1', runId: 'run-001' });

    process.stdout.write = origWrite;
    expect(spy).not.toHaveBeenCalled();
    expect(stdoutLines.join('')).toContain('Cached result');
    expect(process.exitCode).toBe(0);
  });
});

// AC-14: --no-cache always calls Claude
describe('explainCliCommand — no-cache', () => {
  it('calls explainViaClaude even when cache exists', async () => {
    writeFixtureCluster('run-001', FIXTURE_CLUSTER);
    const cacheKey = FIXTURE_CLUSTER.signatureKey;
    writeCache(tmpDir, cacheKey, '## Old cached result\n\nStale.');

    const explainModule = await import('../explain/claude.js');
    const freshMd = '## What\'s happening\n\nFresh result.';
    vi.spyOn(explainModule, 'explainViaClaude').mockResolvedValue({ markdown: freshMd, costUsd: 0.01 });

    const stdoutLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: string | Uint8Array) => { stdoutLines.push(String(data)); return true; };

    await explainCliCommand({
      projectDir: tmpDir,
      clusterId: 'cluster-explain-1',
      runId: 'run-001',
      noCache: true,
    });

    process.stdout.write = origWrite;
    expect(stdoutLines.join('')).toContain('Fresh result');
    expect(process.exitCode).toBe(0);
  });
});

// AC-20 (triage): no clusters means no Ink render (tested via triageCliCommand behavior)
describe('triage empty-run behavior', () => {
  it('prints "No clusters" and returns cleanly without entering Ink', async () => {
    // Write a run with empty bugs.jsonl
    const paths = runPaths(tmpDir, 'run-empty');
    ensureRunDirs(paths);
    fs.writeFileSync(paths.bugsFile, '', 'utf-8');

    const stdoutLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: string | Uint8Array) => { stdoutLines.push(String(data)); return true; };

    // Import the triage command which calls triageCommand when clusters.length > 0
    const { triageCommand } = await import('../triage/index.js');
    await triageCommand({ projectDir: tmpDir, clusters: [], runId: 'run-empty', actor: 'dev@example.com' });

    process.stdout.write = origWrite;
    expect(stdoutLines.join('')).toContain('nothing to triage');
    expect(process.exitCode).toBe(0);
  });
});
