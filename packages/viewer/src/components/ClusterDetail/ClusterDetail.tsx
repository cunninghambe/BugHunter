import * as Tabs from '@radix-ui/react-tabs';
import type { BugCluster } from '../../types.ts';
import { suspectedFilePath } from '../../types.ts';
import type { ActionLogEntry, HarFile } from '../../fs/directory-loader.ts';
import { ExpandableOccurrence } from '../OccurrenceTimeline/OccurrenceTimeline.tsx';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary.tsx';
import styles from './ClusterDetail.module.css';

type ArtifactLoader = (occurrenceId: string) => Promise<{
  screenshot?: Blob;
  actionLog?: ActionLogEntry[];
  consoleLog?: string;
  networkLog?: HarFile;
}>;

type Props = {
  cluster: BugCluster;
  loadArtifacts: ArtifactLoader;
};

export function ClusterDetail({ cluster, loadArtifacts }: Props) {
  return (
    <div className={styles.root}>
      <ErrorBoundary>
        <Tabs.Root defaultValue="overview" className={styles.tabs}>
          <Tabs.List className={styles.tabList} aria-label="Cluster detail tabs">
            <Tabs.Trigger value="overview" className={styles.tabTrigger}>Overview</Tabs.Trigger>
            <Tabs.Trigger value="occurrences" className={styles.tabTrigger}>
              Occurrences ({cluster.occurrences.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="context" className={styles.tabTrigger}>Context</Tabs.Trigger>
            <Tabs.Trigger value="raw" className={styles.tabTrigger}>Raw</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="overview" className={styles.tabContent}>
            <OverviewTab cluster={cluster} />
          </Tabs.Content>

          <Tabs.Content value="occurrences" className={styles.tabContent}>
            <OccurrencesTab cluster={cluster} loadArtifacts={loadArtifacts} />
          </Tabs.Content>

          <Tabs.Content value="context" className={styles.tabContent}>
            <ContextTab cluster={cluster} />
          </Tabs.Content>

          <Tabs.Content value="raw" className={styles.tabContent}>
            <RawTab cluster={cluster} />
          </Tabs.Content>
        </Tabs.Root>
      </ErrorBoundary>
    </div>
  );
}

function OverviewTab({ cluster }: { cluster: BugCluster }) {
  return (
    <dl className={styles.overviewDl}>
      <dt>Kind</dt>
      <dd><code>{cluster.kind}</code></dd>

      <dt>Root Cause</dt>
      <dd>{cluster.rootCause}</dd>

      <dt>Severity</dt>
      <dd>{cluster.severity ?? 'unknown'}</dd>

      <dt>First Seen</dt>
      <dd>{cluster.firstSeenAt}</dd>

      <dt>Last Seen</dt>
      <dd>{cluster.lastSeenAt}</dd>

      <dt>Cluster Size</dt>
      <dd>{cluster.clusterSize}</dd>

      <dt>Third-party</dt>
      <dd>{cluster.thirdPartyOrGenerated ? 'Yes' : 'No'}</dd>

      {cluster.verdict !== undefined && (
        <>
          <dt>Verdict</dt>
          <dd>{cluster.verdict}</dd>
        </>
      )}

      {cluster.suspectedFiles.length > 0 && (
        <>
          <dt>Suspected Files</dt>
          <dd>
            <ul className={styles.fileList}>
              {cluster.suspectedFiles.map(f => { const p = suspectedFilePath(f); return <li key={p}><code>{p}</code></li>; })}
            </ul>
          </dd>
        </>
      )}

      {cluster.fixHints.length > 0 && (
        <>
          <dt>Fix Hints</dt>
          <dd>
            <ul className={styles.hintList}>
              {cluster.fixHints.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </dd>
        </>
      )}

      {cluster.relatedClusterIds !== undefined && cluster.relatedClusterIds.length > 0 && (
        <>
          <dt>Related Clusters</dt>
          <dd>{cluster.relatedClusterIds.join(', ')}</dd>
        </>
      )}
    </dl>
  );
}

function OccurrencesTab({ cluster, loadArtifacts }: { cluster: BugCluster; loadArtifacts: ArtifactLoader }) {
  return (
    <div className={styles.occurrences}>
      {cluster.occurrences.map(occ => (
        <ErrorBoundary key={occ.occurrenceId}>
          <ExpandableOccurrence occurrence={occ} loadArtifacts={loadArtifacts} />
        </ErrorBoundary>
      ))}
    </div>
  );
}

function ContextTab({ cluster }: { cluster: BugCluster }) {
  // Gather all detection-level contexts from the first occurrence's matching detection (if any).
  // Since BugCluster doesn't embed a BugDetection directly, we render what's available at cluster level.
  // BugCluster always has a kind; render the context section unconditionally.
  if (cluster.occurrences.length === 0) {
    return <p className={styles.noContext}>No additional context available for this cluster.</p>;
  }

  return (
    <div className={styles.contextSection}>
      <p className={styles.contextNote}>
        Detailed context fields (staticContext, xssContext, etc.) are available in the Raw tab.
        Structured context rendering is available for occurrences in the Occurrences tab.
      </p>
    </div>
  );
}

function RawTab({ cluster }: { cluster: BugCluster }) {
  return (
    <pre className={styles.raw} aria-label="Raw cluster JSON" tabIndex={0}>
      {JSON.stringify(cluster, null, 2)}
    </pre>
  );
}
