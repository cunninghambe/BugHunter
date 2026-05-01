import { describe, it, expect } from 'vitest';
import { renderGitlab } from '../src/export/gitlab.js';
import { renderLinear } from '../src/export/linear.js';
import { renderJira } from '../src/export/jira.js';
import { renderGithubSarif } from '../src/export/github.js';
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
    occurrenceId: 'occ-full',
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
    replayCommand: 'bughunter replay occ-full',
    timestamp: '2026-01-01T00:00:00Z',
  };
}

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-001',
    kind: 'idor_horizontal',
    rootCause: 'TypeError: Cannot read properties of undefined',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T01:00:00Z',
    clusterSize: 1,
    occurrences: [makeSummaryOcc()],
    suspectedFiles: ['src/components/Dashboard.tsx'],
    fixHints: ['Add null check'],
    thirdPartyOrGenerated: false,
    ...overrides,
  };
}

const BASE_STATE = {
  runId: 'run-001',
  startedAt: '2026-01-01T00:00:00Z',
  projectDir: '/home/user/project',
};

// ─── GitLab ──────────────────────────────────────────────────────────────────

describe('renderGitlab', () => {
  it('outputs version 15.0.0', () => {
    const report = renderGitlab([makeCluster()], '2026-01-01T00:00:00Z');
    expect(report.version).toBe('15.0.0');
  });

  it('scan type is sast', () => {
    const report = renderGitlab([makeCluster()], '2026-01-01T00:00:00Z');
    expect(report.scan.type).toBe('sast');
  });

  it('maps major severity to High', () => {
    // idor_horizontal is major
    const report = renderGitlab([makeCluster({ kind: 'idor_horizontal' })], '2026-01-01T00:00:00Z');
    expect(report.vulnerabilities[0].severity).toBe('High');
  });

  it('maps critical severity to Critical', () => {
    // unhandled_exception is critical
    const report = renderGitlab([makeCluster({ kind: 'unhandled_exception' })], '2026-01-01T00:00:00Z');
    expect(report.vulnerabilities[0].severity).toBe('Critical');
  });

  it('uses cluster id as vuln id', () => {
    const report = renderGitlab([makeCluster({ id: 'my-cluster' })], '2026-01-01T00:00:00Z');
    expect(report.vulnerabilities[0].id).toBe('my-cluster');
  });

  it('handles empty cluster list', () => {
    const report = renderGitlab([], '2026-01-01T00:00:00Z');
    expect(report.vulnerabilities).toHaveLength(0);
  });
});

// ─── Linear ──────────────────────────────────────────────────────────────────

describe('renderLinear', () => {
  it('produces one draft per cluster', () => {
    const drafts = renderLinear([makeCluster(), makeCluster({ id: 'c2' })]);
    expect(drafts).toHaveLength(2);
  });

  it('title contains severity, kind, and root cause snippet', () => {
    const drafts = renderLinear([makeCluster({ kind: 'idor_horizontal' })]);
    expect(drafts[0].title).toMatch(/major/i);
    expect(drafts[0].title).toContain('idor_horizontal');
    expect(drafts[0].title).toContain('TypeError');
  });

  it('priority is 2 (high) for major clusters', () => {
    const drafts = renderLinear([makeCluster({ kind: 'idor_horizontal' })]);
    expect(drafts[0].priority).toBe(2);
  });

  it('priority is 1 (urgent) for critical clusters', () => {
    const drafts = renderLinear([makeCluster({ kind: 'unhandled_exception' })]);
    expect(drafts[0].priority).toBe(1);
  });

  it('includes bughunter metadata bag', () => {
    const drafts = renderLinear([makeCluster({ id: 'cid' })]);
    expect(drafts[0].bughunter.clusterId).toBe('cid');
    expect(drafts[0].bughunter.runId).toBe('run-001');
  });

  it('includes replayCommand when fullArtifacts is true', () => {
    const drafts = renderLinear([makeCluster({ occurrences: [makeFullOcc()] })]);
    expect(drafts[0].bughunter.replayCommand).toBe('bughunter replay occ-full');
  });

  it('replayCommand is undefined for summary occurrence', () => {
    const drafts = renderLinear([makeCluster()]);
    expect(drafts[0].bughunter.replayCommand).toBeUndefined();
  });

  it('description is capped at 32KB', () => {
    const bigHints = Array.from({ length: 1000 }, (_, i) => `Hint ${i}: ${'x'.repeat(100)}`);
    const drafts = renderLinear([makeCluster({ fixHints: bigHints })]);
    expect(drafts[0].description.length).toBeLessThanOrEqual(32 * 1024 + 100);
  });
});

// ─── Jira ────────────────────────────────────────────────────────────────────

describe('renderJira', () => {
  it('produces one draft per cluster', () => {
    const drafts = renderJira([makeCluster(), makeCluster({ id: 'c2' })]);
    expect(drafts).toHaveLength(2);
  });

  it('priority is High for major severity', () => {
    const drafts = renderJira([makeCluster({ kind: 'idor_horizontal' })]);
    expect(drafts[0].fields.priority.name).toBe('High');
  });

  it('priority is Highest for critical severity', () => {
    const drafts = renderJira([makeCluster({ kind: 'unhandled_exception' })]);
    expect(drafts[0].fields.priority.name).toBe('Highest');
  });

  it('includes bughunter labels', () => {
    const drafts = renderJira([makeCluster({ kind: 'idor_horizontal' })]);
    expect(drafts[0].fields.labels).toContain('bughunter');
    expect(drafts[0].fields.labels.some(l => l.startsWith('severity-'))).toBe(true);
    expect(drafts[0].fields.labels).toContain('kind-idor_horizontal');
  });

  it('includes extra labels when provided', () => {
    const drafts = renderJira([makeCluster()], ['team-backend']);
    expect(drafts[0].fields.labels).toContain('team-backend');
  });

  it('description is an ADF document with version 1', () => {
    const drafts = renderJira([makeCluster()]);
    expect(drafts[0].fields.description.version).toBe(1);
    expect(drafts[0].fields.description.type).toBe('doc');
  });

  it('bughunter.clusterId matches cluster id', () => {
    const drafts = renderJira([makeCluster({ id: 'xyz' })]);
    expect(drafts[0].bughunter.clusterId).toBe('xyz');
  });
});

// ─── GitHub SARIF ────────────────────────────────────────────────────────────

describe('renderGithubSarif', () => {
  it('truncates clusters when over limit', () => {
    const clusters = Array.from({ length: 10 }, (_, i) => makeCluster({ id: `c${i}` }));
    const result = renderGithubSarif(clusters, BASE_STATE, 5);
    expect(result.truncated).toBe(true);
    expect(result.originalCount).toBe(10);
    expect(result.sarif.runs[0].results).toHaveLength(5);
  });

  it('does not truncate when under limit', () => {
    const clusters = [makeCluster()];
    const result = renderGithubSarif(clusters, BASE_STATE, 5000);
    expect(result.truncated).toBe(false);
    expect(result.originalCount).toBe(1);
  });
});
