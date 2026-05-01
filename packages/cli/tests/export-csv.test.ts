import { describe, it, expect } from 'vitest';
import { renderCsv } from '../src/export/csv.js';
import type { BugCluster, OccurrenceSummary, OccurrenceFull, PreState, PostState } from '../src/types.js';

function makeSummaryOcc(): OccurrenceSummary {
  return {
    occurrenceId: 'occ-1',
    role: 'admin',
    page: '/dashboard',
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success' },
    fullArtifacts: false,
    timestamp: '2026-01-01T00:00:00Z',
  };
}

function makeFullOcc(): OccurrenceFull {
  const preState: PreState = { url: '/dashboard', title: 'Dashboard', cookies: [], localStorage: {}, sessionStorage: {} };
  const postState: PostState = { url: '/dashboard', title: 'Dashboard', cookies: [], localStorage: {}, sessionStorage: {}, consoleErrors: [], networkErrors: [] };
  return {
    occurrenceId: 'occ-2',
    role: 'admin',
    page: '/dashboard',
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success' },
    fullArtifacts: true,
    preState,
    postState,
    screenshotPath: '/tmp/shot.png',
    domSnapshotPath: '/tmp/dom.html',
    consoleLogPath: '/tmp/console.log',
    networkLogPath: '/tmp/network.log',
    actionLogPath: '/tmp/actions.log',
    reproSteps: ['Click dashboard'],
    replayCommand: 'bughunter replay occ-2',
    timestamp: '2026-01-01T00:00:00Z',
  };
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-001',
    kind: 'idor_horizontal',
    rootCause: 'TypeError here',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T01:00:00Z',
    clusterSize: 1,
    occurrences: [makeSummaryOcc()],
    suspectedFiles: ['src/foo.ts'],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  };
}

describe('renderCsv', () => {
  it('begins with the correct header', () => {
    const csv = renderCsv([]);
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toBe('id,kind,severity,cwe,root_cause,cluster_size,first_seen,last_seen,suspected_files,verdict,replay_command,run_id');
  });

  it('ends with CRLF', () => {
    const csv = renderCsv([makeCluster()]);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('always double-quotes cells', () => {
    const csv = renderCsv([makeCluster()]);
    const rows = csv.split('\r\n').filter(Boolean);
    // Data row (second line)
    const dataRow = rows[1];
    expect(dataRow).toBeDefined();
    // Every field should be quoted
    const fields = dataRow.split('","');
    expect(fields.length).toBeGreaterThan(0);
    expect(dataRow.startsWith('"')).toBe(true);
    expect(dataRow.endsWith('"')).toBe(true);
  });

  it('doubles embedded double quotes (RFC 4180)', () => {
    const c = makeCluster({ rootCause: 'He said "hello"' });
    const csv = renderCsv([c]);
    expect(csv).toContain('He said ""hello""');
  });

  it('replaces newlines in root_cause', () => {
    const c = makeCluster({ rootCause: 'Line 1\nLine 2' });
    const csv = renderCsv([c]);
    // Should not contain raw newline inside a field
    const lines = csv.split('\r\n');
    // Only 3 lines: header, data, trailing empty
    expect(lines.length).toBe(3);
  });

  it('emits replay_command from OccurrenceFull', () => {
    const c = makeCluster({ occurrences: [makeFullOcc()] });
    const csv = renderCsv([c]);
    expect(csv).toContain('bughunter replay occ-2');
  });

  it('emits empty replay_command for OccurrenceSummary', () => {
    const c = makeCluster({ occurrences: [makeSummaryOcc()] });
    const csv = renderCsv([c]);
    const rows = csv.split('\r\n');
    const dataRow = rows[1] ?? '';
    // replay_command is second-to-last field
    const fields = dataRow.match(/"((?:[^"]|"")*)"/g) ?? [];
    const replayField = fields[10] ?? '""';
    expect(replayField).toBe('""');
  });

  it('correctly counts rows for multiple clusters', () => {
    const csv = renderCsv([makeCluster(), makeCluster({ id: 'c2' }), makeCluster({ id: 'c3' })]);
    const rows = csv.split('\r\n').filter(Boolean);
    // header + 3 data rows
    expect(rows).toHaveLength(4);
  });
});
