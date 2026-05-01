// AC-6, AC-7, AC-18: applySuppressions unit tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySuppressions } from './apply.js';
import { saveSuppressions } from './io.js';
import type { BugCluster } from '../types.js';
import type { SuppressionEntry } from './types.js';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    kind: 'console_error',
    signatureKey: 'console_error|TypeError|abc123',
    rootCause: 'TypeError: Cannot read property',
    clusterSize: 2,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T01:00:00.000Z',
    occurrences: [
      {
        id: 'occ-1',
        role: 'user',
        page: '/home',
        action: { kind: 'click', selector: '#btn', toolId: undefined },
        screenshot: undefined,
        dom: undefined,
        consoleLog: undefined,
        networkLog: undefined,
      },
    ],
    suspectedFiles: ['src/home.tsx'],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  } as unknown as BugCluster;
}

function makeEntry(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  return {
    id: 'sup-1',
    pattern: 'kind:console_error',
    reason: 'Test noise',
    addedBy: 'dev@example.com',
    addedAt: '2026-04-30T12:00:00.000Z',
    matchCount: 0,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-apply-test-'));
  delete process.env['BUGHUNTER_DISABLE_SUPPRESSIONS'];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('applySuppressions', () => {
  // AC-18: zero suppressions → suppressedClusters is 0 (not undefined)
  it('returns suppressedCount=0 when no suppressions file exists', () => {
    const clusters = [makeCluster()];
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });
    expect(result.suppressedCount).toBe(0);
    expect(result.suppressedSamples).toHaveLength(0);
    expect(result.clusters).toHaveLength(1);
  });

  // AC-6: kind match removes cluster and emits SuppressedSample
  it('removes matched cluster and adds it to suppressedSamples', () => {
    const entry = makeEntry({ pattern: 'kind:console_error' });
    saveSuppressions(tmpDir, [entry]);

    const clusters = [makeCluster({ kind: 'console_error', id: 'c1' })];
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });

    expect(result.suppressedCount).toBe(1);
    expect(result.clusters).toHaveLength(0);
    expect(result.suppressedSamples).toHaveLength(1);
    expect(result.suppressedSamples[0]).toMatchObject({
      clusterId: 'c1',
      kind: 'console_error',
      matchedPattern: 'kind:console_error',
      suppressionId: 'sup-1',
    });
  });

  // AC-7: bugIdentity > kind precedence
  it('attributes suppression to bugIdentity entry over kind entry', () => {
    const kindEntry = makeEntry({ id: 'kind-entry', pattern: 'kind:console_error' });
    const biEntry = makeEntry({ id: 'bi-entry', pattern: 'bugIdentity:console_error|TypeError|abc123' });
    saveSuppressions(tmpDir, [kindEntry, biEntry]);

    const cluster = makeCluster({ kind: 'console_error', signatureKey: 'console_error|TypeError|abc123' });
    const result = applySuppressions({ clusters: [cluster], projectDir: tmpDir, runId: 'run-1' });

    expect(result.suppressedCount).toBe(1);
    // bugIdentity has higher precedence — bi-entry should win
    expect(result.suppressedSamples[0]?.suppressionId).toBe('bi-entry');
  });

  it('passes through clusters not matching any suppression', () => {
    const entry = makeEntry({ pattern: 'kind:network_5xx' });
    saveSuppressions(tmpDir, [entry]);

    const clusters = [makeCluster({ kind: 'console_error' }), makeCluster({ kind: 'network_5xx', id: 'c2' })];
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });

    expect(result.suppressedCount).toBe(1);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.kind).toBe('console_error');
  });

  it('caps suppressedSamples at 20', () => {
    const entry = makeEntry({ pattern: 'kind:console_error' });
    saveSuppressions(tmpDir, [entry]);

    const clusters = Array.from({ length: 25 }, (_, i) =>
      makeCluster({ id: `c-${i}`, kind: 'console_error' }),
    );
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });

    expect(result.suppressedCount).toBe(25);
    expect(result.suppressedSamples).toHaveLength(20);
  });

  it('updates matchCount in suppressions.json after a match', () => {
    const entry = makeEntry({ pattern: 'kind:console_error', matchCount: 3 });
    saveSuppressions(tmpDir, [entry]);

    applySuppressions({ clusters: [makeCluster()], projectDir: tmpDir, runId: 'run-1' });

    const suppressionsPath = path.join(tmpDir, '.bughunter', 'suppressions.json');
    const updated = JSON.parse(fs.readFileSync(suppressionsPath, 'utf-8')) as SuppressionEntry[];
    expect(updated[0]?.matchCount).toBe(4);
    expect(updated[0]?.lastMatchedAt).toBeDefined();
  });

  it('respects BUGHUNTER_DISABLE_SUPPRESSIONS=1', () => {
    process.env['BUGHUNTER_DISABLE_SUPPRESSIONS'] = '1';
    const entry = makeEntry({ pattern: 'kind:console_error' });
    saveSuppressions(tmpDir, [entry]);

    const clusters = [makeCluster()];
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });

    expect(result.suppressedCount).toBe(0);
    expect(result.clusters).toHaveLength(1);
  });

  it('treats malformed suppressions.json as empty (EC-2)', () => {
    const bughunterDir = path.join(tmpDir, '.bughunter');
    fs.mkdirSync(bughunterDir, { recursive: true });
    fs.writeFileSync(path.join(bughunterDir, 'suppressions.json'), 'NOT_JSON', 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clusters = [makeCluster()];
    const result = applySuppressions({ clusters, projectDir: tmpDir, runId: 'run-1' });

    expect(result.clusters).toHaveLength(1);
    expect(result.suppressedCount).toBe(0);
    warnSpy.mockRestore();
  });

  it('warns for expired suppression entries but still applies them (EC-5)', () => {
    const expiredEntry = makeEntry({
      pattern: 'kind:console_error',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    saveSuppressions(tmpDir, [expiredEntry]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = applySuppressions({ clusters: [makeCluster()], projectDir: tmpDir, runId: 'run-1' });
    // Expired but still applied in v0.28
    expect(result.suppressedCount).toBe(1);
    warnSpy.mockRestore();
  });
});
