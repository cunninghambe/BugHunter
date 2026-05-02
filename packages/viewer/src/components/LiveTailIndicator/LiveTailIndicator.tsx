import type { RunPhase } from '../../types.ts';
import styles from './LiveTailIndicator.module.css';

type Props = {
  phase: RunPhase;
  newCount: number;
  mode: 'mcp' | 'poll' | 'degraded';
};

export function LiveTailIndicator({ phase, newCount, mode }: Props) {
  const label = mode === 'degraded' ? 'live-tail downgraded' : mode === 'mcp' ? 'live (MCP)' : 'live (poll)';
  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label={`Live tail: ${label}, phase ${phase}`}>
      <span className={`${styles.dot} ${mode === 'degraded' ? styles.dotWarn : styles.dotLive}`} aria-hidden="true" />
      <span className={styles.label}>{label} — {phase}</span>
      {newCount > 0 && (
        <span className={styles.badge}>+{newCount} new</span>
      )}
    </div>
  );
}
