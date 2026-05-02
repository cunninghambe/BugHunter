import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClusterList } from './ClusterList.tsx';
import type { BugCluster } from '../../types.ts';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'c1',
    runId: 'run1',
    kind: 'console_error',
    rootCause: 'TypeError',
    firstSeenAt: '2024-01-01T00:00:00Z',
    lastSeenAt: '2024-01-01T00:00:00Z',
    clusterSize: 3,
    occurrences: [{ occurrenceId: 'o1', role: 'admin', page: '/dashboard', fullArtifacts: false as const, timestamp: '', action: { kind: 'click' as const, via: 'ui' as const, expectedOutcome: 'success' as const, palette: 'happy' as const } }],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    severity: 'major',
    ...overrides,
  } as BugCluster;
}

describe('ClusterList', () => {
  it('renders all cluster rows', () => {
    const clusters = [
      makeCluster({ id: 'c1', kind: 'console_error' }),
      makeCluster({ id: 'c2', kind: 'react_error' }),
    ];
    render(<ClusterList clusters={clusters} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('console_error')).toBeDefined();
    expect(screen.getByText('react_error')).toBeDefined();
  });

  it('shows empty message when no clusters', () => {
    render(<ClusterList clusters={[]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/No clusters match/)).toBeDefined();
  });

  it('marks selected cluster with aria-selected', () => {
    const clusters = [makeCluster({ id: 'c1' })];
    render(<ClusterList clusters={clusters} selectedId="c1" onSelect={vi.fn()} />);
    const option = screen.getByRole('option');
    expect(option.getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelect when row is clicked', async () => {
    const onSelect = vi.fn();
    const clusters = [makeCluster({ id: 'c1' })];
    render(<ClusterList clusters={clusters} selectedId={null} onSelect={onSelect} />);
    const row = screen.getByRole('option');
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('calls onSelect on Enter key', async () => {
    const onSelect = vi.fn();
    const clusters = [makeCluster({ id: 'c1' })];
    render(<ClusterList clusters={clusters} selectedId="c1" onSelect={onSelect} />);
    const row = screen.getByRole('option');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('shows severity badge', () => {
    const clusters = [makeCluster({ severity: 'critical' })];
    render(<ClusterList clusters={clusters} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('critical')).toBeDefined();
  });

  it('shows truncation banner when more than 500 clusters', () => {
    const clusters = Array.from({ length: 501 }, (_, i) =>
      makeCluster({ id: `c${i}` }),
    );
    render(<ClusterList clusters={clusters} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/Showing 500 of 501/)).toBeDefined();
  });
});
