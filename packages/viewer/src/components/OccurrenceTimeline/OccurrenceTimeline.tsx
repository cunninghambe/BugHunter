import { useState } from 'react';
import type { Occurrence, OccurrenceFull, ConsoleError, NetworkRequest, PreState, PostState } from '../../types.ts';
import type { ActionLogEntry, HarFile } from '../../fs/directory-loader.ts';
import { Screenshot } from '../Screenshot/Screenshot.tsx';
import styles from './OccurrenceTimeline.module.css';

type ArtifactData = {
  screenshot?: Blob;
  actionLog?: ActionLogEntry[];
  consoleLog?: string;
  networkLog?: HarFile;
};

type Props = {
  occurrence: Occurrence;
  artifacts: ArtifactData | null;
  artifactsLoading: boolean;
};

export function OccurrenceTimeline({ occurrence, artifacts, artifactsLoading }: Props) {
  const full = occurrence.fullArtifacts ? (occurrence as OccurrenceFull) : null;

  const preState: PreState | undefined = full !== null ? (full as unknown as { preState?: PreState }).preState : undefined;
  const postState: PostState | undefined = full !== null ? (full as unknown as { postState?: PostState }).postState : undefined;
  const consoleErrors: ConsoleError[] = postState?.consoleErrors ?? [];
  const networkRequests: NetworkRequest[] = postState?.networkRequests ?? [];

  return (
    <div className={styles.root}>
      <PrePostSection label="Pre-state" state={preState} />

      <Screenshot blob={artifacts?.screenshot} loading={artifactsLoading} />

      {artifacts?.actionLog !== undefined && artifacts.actionLog.length > 0 && (
        <ActionLogSection entries={artifacts.actionLog} />
      )}

      {consoleErrors.length > 0 && <ConsoleErrorsSection errors={consoleErrors} />}

      {networkRequests.length > 0 && <NetworkRequestsSection requests={networkRequests} />}

      <PrePostSection label="Post-state" state={postState} />
    </div>
  );
}

function PrePostSection({ label, state }: { label: string; state: PreState | PostState | undefined }) {
  if (state === undefined) return null;
  return (
    <div className={styles.prePost}>
      <h4 className={styles.sectionTitle}>{label}</h4>
      <dl className={styles.dl}>
        <dt>URL</dt><dd>{state.url}</dd>
        <dt>Title</dt><dd>{state.title}</dd>
      </dl>
    </div>
  );
}

function ActionLogSection({ entries }: { entries: ActionLogEntry[] }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>Action Log ({entries.length})</h4>
      <ol className={styles.actionLog}>
        {entries.map((entry, i) => (
          <li key={i} className={styles.actionEntry}>
            <pre className={styles.entryPre}>{JSON.stringify(entry, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ConsoleErrorsSection({ errors }: { errors: ConsoleError[] }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>Console Errors ({errors.length})</h4>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Level</th>
            <th>Message</th>
            <th>Stack</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((err, i) => (
            <tr key={i}>
              <td className={styles.levelCell}>{err.level}</td>
              <td>{err.text}</td>
              <td className={styles.stack}>{err.stack ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NetworkRequestsSection({ requests }: { requests: NetworkRequest[] }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>Network Requests ({requests.length})</h4>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((req, i) => (
            <tr key={i} className={statusClass(req.status)}>
              <td>{req.method}</td>
              <td>{req.path}</td>
              <td>{req.status}</td>
              <td>{req.duration}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusClass(status: number): string {
  if (status >= 500) return styles['status5xx'] ?? '';
  if (status >= 400) return styles['status4xx'] ?? '';
  return styles['statusOk'] ?? '';
}

// Keep the ExpandableOccurrence used by ClusterDetail
type ExpandableProps = {
  occurrence: Occurrence;
  loadArtifacts: (occurrenceId: string) => Promise<ArtifactData>;
};

export function ExpandableOccurrence({ occurrence, loadArtifacts }: ExpandableProps) {
  const [expanded, setExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactData | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleExpand(): Promise<void> {
    setExpanded(prev => !prev);
    if (artifacts !== null || loading) return;
    setLoading(true);
    try {
      const data = await loadArtifacts(occurrence.occurrenceId);
      setArtifacts(data);
    } catch (err) {
      console.error('[viewer] Failed to load artifacts', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.expandable}>
      <button
        className={styles.expandBtn}
        onClick={() => { void handleExpand(); }}
        aria-expanded={expanded}
      >
        {occurrence.occurrenceId} — {occurrence.role} on {occurrence.page}
      </button>
      {expanded && (
        <OccurrenceTimeline
          occurrence={occurrence}
          artifacts={artifacts}
          artifactsLoading={loading}
        />
      )}
    </div>
  );
}
