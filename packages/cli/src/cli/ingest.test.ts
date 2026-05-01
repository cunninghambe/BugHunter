import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ingestCommand } from './ingest.js';
import { openHistoryDb, clustersForRun } from '../store/history.js';

const DEMO_CLUSTER = {
  id: 'cluster-001',
  runId: 'run-original',
  kind: 'console_error',
  rootCause: 'TypeError: foo is undefined',
  clusterSize: 1,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:05:00.000Z',
  occurrences: [],
  suspectedFiles: [],
  fixHints: [],
  thirdPartyOrGenerated: false,
  signatureKey: 'console_error::TypeError: foo is undefined::fp-foo-undef',
};

describe('ingestCommand', () => {
  let tmpDir: string;
  let bugsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-ingest-test-'));
    bugsFile = path.join(tmpDir, 'bugs.jsonl');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('ingests clusters from a bugs.jsonl file', () => {
    fs.writeFileSync(bugsFile, `${JSON.stringify(DEMO_CLUSTER)}\n`);
    const output: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { output.push(chunk); return true; };
    try { ingestCommand(tmpDir, { filePath: bugsFile, projectName: 'test-project' }); }
    finally { process.stdout.write = orig; }
    expect(output.join('')).toContain('Ingested 1 cluster(s)');
  });

  it('round-trips: ingest then query by identity', () => {
    fs.writeFileSync(bugsFile, `${JSON.stringify(DEMO_CLUSTER)}\n`);
    ingestCommand(tmpDir, { filePath: bugsFile, runId: 'ingest-test-run', projectName: 'test-project' });
    const db = openHistoryDb(tmpDir);
    try {
      const rows = clustersForRun(db, 'ingest-test-run');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('console_error');
      expect(rows[0]?.bug_identity).toHaveLength(16);
    } finally { db.close(); }
  });

  it('is idempotent — re-ingesting same file produces same row count', () => {
    fs.writeFileSync(bugsFile, `${JSON.stringify(DEMO_CLUSTER)}\n`);
    ingestCommand(tmpDir, { filePath: bugsFile, runId: 'dedup-run', projectName: 'test-project' });
    ingestCommand(tmpDir, { filePath: bugsFile, runId: 'dedup-run', projectName: 'test-project' });
    const db = openHistoryDb(tmpDir);
    try { expect(clustersForRun(db, 'dedup-run')).toHaveLength(1); }
    finally { db.close(); }
  });

  it('throws on missing --project-name', () => {
    fs.writeFileSync(bugsFile, `${JSON.stringify(DEMO_CLUSTER)}\n`);
    expect(() => ingestCommand(tmpDir, { filePath: bugsFile })).toThrow('--project-name');
  });

  it('throws when file does not exist', () => {
    expect(() => ingestCommand(tmpDir, { filePath: '/nonexistent/bugs.jsonl', projectName: 'p' })).toThrow('File not found');
  });
});
