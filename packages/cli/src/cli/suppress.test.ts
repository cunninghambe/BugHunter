// AC-2 through AC-5, AC-9, AC-19: suppressCommand and unsuppressCommand unit tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { suppressCommand } from './suppress.js';
import { unsuppressCommand } from './unsuppress.js';
import type { SuppressionEntry, AuditEvent } from '../suppress/types.js';

let tmpDir: string;
let bughunterDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-suppress-test-'));
  bughunterDir = path.join(tmpDir, '.bughunter');
  process.exitCode = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
  process.exitCode = 0;
});

function readSuppressions(): SuppressionEntry[] {
  const file = path.join(bughunterDir, 'suppressions.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as SuppressionEntry[];
}

function readAuditLog(): AuditEvent[] {
  const file = path.join(bughunterDir, 'suppressions-audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as AuditEvent);
}

// AC-2: valid suppress writes entry + audit event
describe('suppressCommand', () => {
  it('creates suppressions.json with a valid entry', () => {
    suppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt', reason: 'decorative' });

    const entries = readSuppressions();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pattern).toBe('kind:image_missing_alt');
    expect(entries[0]?.reason).toBe('decorative');
    expect(entries[0]?.id).toBeTruthy();
    expect(entries[0]?.addedAt).toBeTruthy();
  });

  it('writes a suppress audit event', () => {
    suppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt', reason: 'decorative' });

    const events = readAuditLog();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('suppress');
    if (events[0]?.kind === 'suppress') {
      expect(events[0].pattern).toBe('kind:image_missing_alt');
      expect(events[0].reason).toBe('decorative');
    }
  });

  // AC-3: missing reason exits 2
  it('exits 2 when reason is empty', () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => {
      stderrLines.push(String(data));
      return true;
    };

    suppressCommand({ projectDir: tmpDir, pattern: 'kind:console_error', reason: '' });

    process.stderr.write = origWrite;
    expect(process.exitCode).toBe(2);
    expect(stderrLines.join('')).toContain('--reason is required');
  });

  // AC-4: newline in reason exits 2
  it('exits 2 when reason contains newline', () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => {
      stderrLines.push(String(data));
      return true;
    };

    suppressCommand({ projectDir: tmpDir, pattern: 'kind:console_error', reason: 'foo\nbar' });

    process.stderr.write = origWrite;
    expect(process.exitCode).toBe(2);
    expect(stderrLines.join('')).toContain('newlines');
  });

  it('exits 2 for invalid pattern', () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array) => {
      stderrLines.push(String(data));
      return true;
    };

    suppressCommand({ projectDir: tmpDir, pattern: 'notaprefix:foo', reason: 'test' });

    process.stderr.write = origWrite;
    expect(process.exitCode).toBe(2);
  });

  it('no-ops within 60s dedup window for same (pattern, addedBy)', () => {
    suppressCommand({ projectDir: tmpDir, pattern: 'kind:console_error', reason: 'first' });
    suppressCommand({ projectDir: tmpDir, pattern: 'kind:console_error', reason: 'second' });
    // Should still be only 1 entry (dedup window of 60s)
    const entries = readSuppressions();
    expect(entries).toHaveLength(1);
  });

  it('sets sourceClusterId when clusterId is provided', () => {
    suppressCommand({
      projectDir: tmpDir,
      pattern: 'kind:console_error',
      reason: 'test',
      clusterId: 'cluster-abc',
    });
    const entries = readSuppressions();
    expect(entries[0]?.sourceClusterId).toBe('cluster-abc');
  });

  // AC-19: severity:critical stores fine, just never matches in v0.28
  it('accepts severity:critical and writes valid entry', () => {
    suppressCommand({ projectDir: tmpDir, pattern: 'severity:critical', reason: 'testing severity' });

    const entries = readSuppressions();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pattern).toBe('severity:critical');
    expect(process.exitCode).toBe(0);
  });
});

// AC-5: unsuppress removes all matching entries + writes audit event
describe('unsuppressCommand', () => {
  beforeEach(() => {
    // Pre-populate with two entries for kind:image_missing_alt
    suppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt', reason: 'first' });
  });

  it('removes all entries with the given pattern', () => {
    unsuppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt' });

    const entries = readSuppressions();
    expect(entries).toHaveLength(0);
  });

  it('writes an unsuppress audit event', () => {
    unsuppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt' });

    const events = readAuditLog();
    const unsuppressEvents = events.filter(e => e.kind === 'unsuppress');
    expect(unsuppressEvents).toHaveLength(1);
    if (unsuppressEvents[0]?.kind === 'unsuppress') {
      expect(unsuppressEvents[0].removedCount).toBe(1);
      expect(unsuppressEvents[0].removedSuppressionIds).toHaveLength(1);
    }
  });

  // EC-7: no-op when no matching entries
  it('does NOT write audit event when no entries match (EC-7)', () => {
    const initialEvents = readAuditLog().length;
    unsuppressCommand({ projectDir: tmpDir, pattern: 'kind:network_5xx' });
    const finalEvents = readAuditLog().length;
    expect(finalEvents).toBe(initialEvents);
  });

  // AC-9: suppress + unsuppress = 2 lines in audit log
  it('produces exactly 2 audit events after suppress + unsuppress', () => {
    unsuppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt' });

    const events = readAuditLog();
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('suppress');
    expect(events[1]?.kind).toBe('unsuppress');
  });

  it('audit event is written BEFORE the entry is removed (write-then-delete)', () => {
    // After unsuppress succeeds, both the event and the removal should be consistent
    unsuppressCommand({ projectDir: tmpDir, pattern: 'kind:image_missing_alt' });

    const events = readAuditLog();
    const entries = readSuppressions();
    const unsuppressEvent = events.find(e => e.kind === 'unsuppress');

    expect(unsuppressEvent).toBeDefined();
    expect(entries).toHaveLength(0);
  });
});
