import type { RunSummary } from '../../types.ts';
import styles from './EmptyState.module.css';

type Props = {
  summary: RunSummary;
};

export function EmptyState({ summary }: Props) {
  return (
    <div className={styles.root}>
      <p className={styles.heading}>Run completed cleanly — 0 clusters.</p>
      <dl className={styles.meta}>
        <dt>Run ID</dt><dd>{summary.runId}</dd>
        <dt>Tests ran</dt><dd>{summary.testsRan}</dd>
        <dt>Runtime</dt><dd>{(summary.actualRuntimeMs / 1000).toFixed(1)}s</dd>
      </dl>
    </div>
  );
}
