import { useRef, useCallback, useEffect } from 'react';
import type { BugCluster } from '../../types.ts';
import styles from './ClusterList.module.css';

const SEVERITY_CLASSES: Record<string, string | undefined> = {
  critical: styles['badgeCritical'],
  major: styles['badgeMajor'],
  minor: styles['badgeMinor'],
  info: styles['badgeInfo'],
};

const MAX_RENDERED = 500;

type Props = {
  clusters: BugCluster[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocusSearch?: () => void;
};

export function ClusterList({ clusters, selectedId, onSelect, onFocusSearch }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const truncated = clusters.length > MAX_RENDERED;
  const visible = truncated ? clusters.slice(0, MAX_RENDERED) : clusters;

  const focusRow = useCallback((id: string) => {
    const el = listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el instanceof HTMLElement) el.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll('[role="option"]') ?? []);
    const focused = document.activeElement;
    const currentIndex = rows.indexOf(focused as Element);

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      const next = rows[currentIndex + 1] ?? rows[0];
      if (next instanceof HTMLElement) next.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const prev = rows[currentIndex - 1] ?? rows[rows.length - 1];
      if (prev instanceof HTMLElement) prev.focus();
    } else if (e.key === '/') {
      e.preventDefault();
      onFocusSearch?.();
    }
  }, [onFocusSearch]);

  // Auto-scroll to selected row on external selection change.
  useEffect(() => {
    if (selectedId === null) return;
    const el = listRef.current?.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
    if (el !== null && el !== undefined && typeof (el as Element & { scrollIntoView?: unknown }).scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId]);

  if (clusters.length === 0) {
    return <p className={styles.empty}>No clusters match the current filters.</p>;
  }

  return (
    <div className={styles.root}>
      {truncated && (
        <p className={styles.truncationBanner}>
          Showing {MAX_RENDERED} of {clusters.length} — narrow with filters or search.
        </p>
      )}
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Bug clusters"
        className={styles.list}
        onKeyDown={handleKeyDown}
      >
        {visible.map(cluster => (
          <ClusterRow
            key={cluster.id}
            cluster={cluster}
            selected={cluster.id === selectedId}
            onSelect={onSelect}
            onFocusRow={focusRow}
          />
        ))}
      </ul>
    </div>
  );
}

type RowProps = {
  cluster: BugCluster;
  selected: boolean;
  onSelect: (id: string) => void;
  onFocusRow: (id: string) => void;
};

function ClusterRow({ cluster, selected, onSelect }: RowProps) {
  const firstOcc = cluster.occurrences[0];
  const pageRoute = firstOcc?.page ?? '—';
  const severity = cluster.severity ?? 'unknown';
  const badgeClass = SEVERITY_CLASSES[severity] ?? styles.badgeUnknown;

  const label = `Cluster ${cluster.kind} on ${pageRoute}, ${cluster.clusterSize} occurrences, severity ${severity}, first seen ${cluster.firstSeenAt}`;

  return (
    <li
      role="option"
      aria-selected={selected}
      aria-label={label}
      data-id={cluster.id}
      className={`${styles.row} ${selected ? styles.selected : ''}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(cluster.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(cluster.id);
        }
      }}
    >
      <span className={`${styles.badge} ${badgeClass}`}>{severity}</span>
      <span className={styles.kind}>{cluster.kind}</span>
      <span className={styles.route}>{pageRoute}</span>
      <span className={styles.count}>{cluster.clusterSize}</span>
    </li>
  );
}
