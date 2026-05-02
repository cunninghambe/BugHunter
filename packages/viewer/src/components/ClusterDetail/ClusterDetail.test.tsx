import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClusterDetail } from './ClusterDetail.tsx';
import type { BugCluster } from '../../types.ts';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'c1',
    runId: 'run1',
    kind: 'console_error',
    rootCause: 'TypeError: Cannot read property',
    firstSeenAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    clusterSize: 2,
    occurrences: [
      { occurrenceId: 'o1', role: 'admin', page: '/dashboard', fullArtifacts: false as const, timestamp: '', action: { kind: 'click' as const, via: 'ui' as const, expectedOutcome: 'success' as const, palette: 'happy' as const } },
    ],
    suspectedFiles: ['src/Dashboard.tsx'],
    fixHints: ['Check null safety'],
    thirdPartyOrGenerated: false,
    severity: 'major',
    ...overrides,
  } as BugCluster;
}

const noopLoader = vi.fn().mockResolvedValue({});

describe('ClusterDetail', () => {
  it('renders overview tab content', () => {
    const cluster = makeCluster();
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('console_error')).toBeDefined();
    expect(screen.getByText('TypeError: Cannot read property')).toBeDefined();
    expect(screen.getByText('major')).toBeDefined();
  });

  it('renders suspected files', () => {
    const cluster = makeCluster({ suspectedFiles: ['src/Dashboard.tsx'] });
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('src/Dashboard.tsx')).toBeDefined();
  });

  it('renders fix hints', () => {
    const cluster = makeCluster({ fixHints: ['Check null safety'] });
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('Check null safety')).toBeDefined();
  });

  it('shows occurrences count in tab label', () => {
    const baseAction = { kind: 'click' as const, via: 'ui' as const, expectedOutcome: 'success' as const, palette: 'happy' as const };
    const cluster = makeCluster({
      occurrences: [
        { occurrenceId: 'o1', role: 'admin', page: '/', fullArtifacts: false as const, timestamp: '', action: baseAction },
        { occurrenceId: 'o2', role: 'user', page: '/', fullArtifacts: false as const, timestamp: '', action: baseAction },
      ],
    });
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('Occurrences (2)')).toBeDefined();
  });

  it('renders verdict when present', () => {
    const cluster = makeCluster({ verdict: 'verified_fixed' });
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('verified_fixed')).toBeDefined();
  });

  it('renders unknown severity when severity is absent', () => {
    const cluster = makeCluster({ severity: undefined });
    render(<ClusterDetail cluster={cluster} loadArtifacts={noopLoader} />);
    expect(screen.getByText('unknown')).toBeDefined();
  });
});
