import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { renderSarif } from '../src/export/sarif.js';
import type { BugCluster, OccurrenceSummary } from '../src/types.js';
import sarifSchema from '../../../fixtures/sarif-2.1.0.json' with { type: 'json' };

const ajv = new Ajv({ schemaId: 'auto' });

function makeSummaryOcc(): OccurrenceSummary {
  return {
    occurrenceId: 'occ-1',
    role: 'admin',
    page: '/dashboard',
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success' },
    fullArtifacts: false,
    timestamp: new Date().toISOString(),
  };
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-abc123',
    runId: 'run-001',
    kind: 'idor_horizontal',
    rootCause: 'TypeError: Cannot read property of undefined',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T01:00:00Z',
    clusterSize: 3,
    occurrences: [makeSummaryOcc()],
    suspectedFiles: ['src/components/Dashboard.tsx'],
    fixHints: ['Check null before accessing property'],
    thirdPartyOrGenerated: false,
    ...overrides,
  };
}

const baseState = {
  runId: 'run-001',
  startedAt: '2026-01-01T00:00:00Z',
  projectDir: '/home/user/project',
};

describe('renderSarif', () => {
  it('produces valid SARIF 2.1.0 per ajv schema', () => {
    const log = renderSarif([makeCluster()], baseState);
    const valid = ajv.validate(sarifSchema, log);
    if (!valid) {
      console.error('SARIF validation errors:', ajv.errors);
    }
    expect(valid).toBe(true);
  });

  it('sets $schema and version correctly', () => {
    const log = renderSarif([], baseState);
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.version).toBe('2.1.0');
  });

  it('creates one rule per unique kind', () => {
    const clusters = [
      makeCluster({ kind: 'idor_horizontal' }),
      makeCluster({ id: 'c2', kind: 'idor_horizontal' }),
      makeCluster({ id: 'c3', kind: 'unhandled_exception' }),
    ];
    const log = renderSarif(clusters, baseState);
    const rules = log.runs[0].tool.driver.rules;
    expect(rules).toHaveLength(2);
    expect(rules.map(r => r.id)).toContain('idor_horizontal');
    expect(rules.map(r => r.id)).toContain('unhandled_exception');
  });

  it('sets partialFingerprints from signatureKey when present', () => {
    const c = makeCluster({ signatureKey: 'my-sig-key' });
    const log = renderSarif([c], baseState);
    const fp = log.runs[0].results[0].partialFingerprints;
    expect(fp['bughunter.clusterSignature/v1']).toBe('my-sig-key');
  });

  it('falls back to id in partialFingerprints when signatureKey absent', () => {
    const c = makeCluster({ id: 'cluster-abc123' });
    const log = renderSarif([c], baseState);
    const fp = log.runs[0].results[0].partialFingerprints;
    expect(fp['bughunter.clusterSignature/v1']).toBe('cluster-abc123');
  });

  it('maps security-severity correctly for critical kind (unhandled_exception is critical)', () => {
    const c = makeCluster({ kind: 'unhandled_exception' });
    const log = renderSarif([c], baseState);
    const rule = log.runs[0].tool.driver.rules[0];
    expect(rule.properties['security-severity']).toBe('9.5');
  });

  it('falls back to unknown file when suspectedFiles is empty', () => {
    const c = makeCluster({ suspectedFiles: [] });
    const log = renderSarif([c], baseState);
    const loc = log.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe('unknown');
  });

  it('normalises backslashes in file URIs', () => {
    const c = makeCluster({ suspectedFiles: ['src\\components\\Foo.tsx'] });
    const log = renderSarif([c], baseState);
    const uri = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).not.toContain('\\');
    expect(uri).toContain('src/components/Foo.tsx');
  });

  it('handles empty cluster list', () => {
    const log = renderSarif([], baseState);
    expect(log.runs[0].results).toHaveLength(0);
    expect(log.runs[0].tool.driver.rules).toHaveLength(0);
  });
});
