import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coverageCommand } from './coverage.js';
import { buildCoverage } from '../phases/coverage.js';
import { writeJsonFile } from '../store/filesystem.js';
import type { RunState } from '../types.js';

function minimalRunState(): RunState {
  return {
    runId: 'test-run',
    projectDir: '/tmp',
    startedAt: '2026-04-30T00:00:00.000Z',
    phase: 'emit',
    config: { projectName: 'test', surfaceMcpUrl: 'http://localhost' },
    clusterCount: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    emitted: false,
    partialEmit: false,
  } as unknown as RunState;
}

function setupRunWithCoverage(projectDir: string, runId: string): void {
  const runDir = path.join(projectDir, '.bughunter', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const coverage = buildCoverage(runId, '2026-04-30T00:00:00.000Z', minimalRunState(), [], undefined);
  writeJsonFile(path.join(runDir, 'coverage.json'), coverage);
}

describe('coverageCommand', () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cov-cli-'));
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdoutChunks.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderrChunks.push(String(chunk)); return true; });
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('pretty-prints four buckets for a valid run', () => {
    setupRunWithCoverage(tmpDir, 'run001');
    coverageCommand(tmpDir, 'run001', {});
    const output = stdoutChunks.join('');
    expect(output).toContain('=== Coverage for run run001 ===');
    expect(output).toContain('Total kinds:');
    expect(output).toContain('Fired:');
    expect(output).toContain('Input absent:');
    expect(output).toContain('Detector dead:');
    expect(output).toContain('Deferred:');
  });

  it('--json emits the coverage file verbatim (parseable JSON)', () => {
    setupRunWithCoverage(tmpDir, 'run001');
    coverageCommand(tmpDir, 'run001', { json: true });
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output) as { version: number; runId: string };
    expect(parsed.version).toBe(1);
    expect(parsed.runId).toBe('run001');
  });

  it('--latest picks the most recent run', () => {
    // Create two runs; latest should be picked
    setupRunWithCoverage(tmpDir, 'run_a');
    setupRunWithCoverage(tmpDir, 'run_z');
    coverageCommand(tmpDir, undefined, { latest: true });
    const output = stdoutChunks.join('');
    expect(output).toContain('run_z');
  });

  it('--dead emits only the detector-dead bucket', () => {
    setupRunWithCoverage(tmpDir, 'run001');
    coverageCommand(tmpDir, 'run001', { dead: true });
    const output = stdoutChunks.join('');
    // Should NOT contain the full header
    expect(output).not.toContain('=== Coverage for run');
    // Either says "Detector dead" or just empty if no dead kinds
    // The output should be deterministic — just check it doesn't crash
    expect(stderrChunks).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });

  it('--kind emits exactly one row as JSON', () => {
    setupRunWithCoverage(tmpDir, 'run001');
    coverageCommand(tmpDir, 'run001', { kind: 'console_error' });
    const output = stdoutChunks.join('');
    const parsed = JSON.parse(output) as { kind: string; status: string };
    expect(parsed.kind).toBe('console_error');
    expect(parsed).toHaveProperty('status');
  });

  it('missing coverage.json → exit 1, stderr contains coverage_unavailable', () => {
    const runDir = path.join(tmpDir, '.bughunter', 'runs', 'old-run');
    fs.mkdirSync(runDir, { recursive: true });
    // No coverage.json written
    coverageCommand(tmpDir, 'old-run', {});
    expect(process.exitCode).toBe(1);
    const errOutput = stderrChunks.join('');
    expect(errOutput).toContain('coverage_unavailable');
  });

  it('--latest with no runs → exit 1, stderr contains coverage_unavailable', () => {
    // No runs directory at all
    coverageCommand(tmpDir, undefined, { latest: true });
    expect(process.exitCode).toBe(1);
    const errOutput = stderrChunks.join('');
    expect(errOutput).toContain('coverage_unavailable');
  });
});
