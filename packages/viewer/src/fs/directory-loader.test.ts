import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFromHandle } from './directory-loader.ts';

// ---------------------------------------------------------------------------
// Fake FileSystem implementation
// ---------------------------------------------------------------------------

function makeFile(content: string): File {
  return new File([content], 'file', { type: 'text/plain' });
}

function makeFileHandle(file: File): FileSystemFileHandle {
  return {
    getFile: () => Promise.resolve(file),
    kind: 'file',
    name: file.name,
    isFile: true,
    isSameEntry: () => Promise.resolve(false),
    queryPermission: () => Promise.resolve('granted'),
    requestPermission: () => Promise.resolve('granted'),
  } as unknown as FileSystemFileHandle;
}

function makeDir(files: Record<string, string>): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'test-dir',
    getFileHandle: (name: string) => {
      if (name in files) {
        return Promise.resolve(makeFileHandle(makeFile(files[name] ?? '')));
      }
      const err = new DOMException(`${name} not found`, 'NotFoundError');
      return Promise.reject(err);
    },
    getDirectoryHandle: () => Promise.reject(new DOMException('not found', 'NotFoundError')),
    isSameEntry: () => Promise.resolve(false),
    isFile: false,
  } as unknown as FileSystemDirectoryHandle;
}

const VALID_SUMMARY = JSON.stringify({
  runId: 'run-abc',
  bugs_filed: 2,
  bugs_specced: 0,
  bugs_attempted_fix: 0,
  bugs_architect_refused: 0,
  bugs_verified_fixed: 0,
  partially_verified: 0,
  bugs_persistent: 0,
  bugs_skipped: 0,
  bugs_lost_to_revision: 0,
  byKind: {},
  byRole: {},
  actualRuntimeMs: 1000,
  testsPlanned: 1,
  testsRan: 1,
  testsSkipped: 0,
  skippedReasons: [],
  suppressedClusters: 0,
});

function makeClusterLine(id: string, runId = 'run-abc'): string {
  return JSON.stringify({
    id,
    runId,
    kind: 'console_error',
    rootCause: 'Test error',
    firstSeenAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    clusterSize: 1,
    occurrences: [{ occurrenceId: 'occ1', role: 'user', page: '/', fullArtifacts: false }],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadFromHandle', () => {
  it('returns invalid:no_summary_json when summary.json is missing', async () => {
    const handle = makeDir({ 'bugs.jsonl': '' });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('no_summary_json');
    }
  });

  it('returns invalid:malformed_summary when summary.json is not valid JSON', async () => {
    const handle = makeDir({ 'summary.json': '{ not json }' });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('malformed_summary');
    }
  });

  it('returns invalid:no_bugs_jsonl when bugs.jsonl is missing', async () => {
    const handle = makeDir({ 'summary.json': VALID_SUMMARY });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reason).toBe('no_bugs_jsonl');
    }
  });

  it('returns loaded with clusters on happy path', async () => {
    const bugs = [makeClusterLine('c1'), makeClusterLine('c2')].join('\n') + '\n';
    const handle = makeDir({ 'summary.json': VALID_SUMMARY, 'bugs.jsonl': bugs });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.clusters).toHaveLength(2);
      expect(result.runId).toBe('run-abc');
    }
  });

  it('skips malformed lines and continues loading (EC-1)', async () => {
    const bugs = `${makeClusterLine('c1')}\n{INVALID_JSON}\n${makeClusterLine('c2')}\n`;
    const handle = makeDir({ 'summary.json': VALID_SUMMARY, 'bugs.jsonl': bugs });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadFromHandle(handle);
    warnSpy.mockRestore();
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.clusters).toHaveLength(2);
    }
  });

  it('skips clusters with mismatched runId (EC-11)', async () => {
    const bugs = `${makeClusterLine('c1', 'run-abc')}\n${makeClusterLine('c2', 'different-run')}\n`;
    const handle = makeDir({ 'summary.json': VALID_SUMMARY, 'bugs.jsonl': bugs });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadFromHandle(handle);
    warnSpy.mockRestore();
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.clusters).toHaveLength(1);
    }
  });

  it('returns loaded with empty cluster list when bugs.jsonl is empty', async () => {
    const handle = makeDir({ 'summary.json': VALID_SUMMARY, 'bugs.jsonl': '' });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.clusters).toHaveLength(0);
    }
  });

  it('handles bugs.jsonl with no trailing newline', async () => {
    const bugs = makeClusterLine('c1'); // no trailing newline
    const handle = makeDir({ 'summary.json': VALID_SUMMARY, 'bugs.jsonl': bugs });
    const result = await loadFromHandle(handle);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.clusters).toHaveLength(1);
    }
  });
});
