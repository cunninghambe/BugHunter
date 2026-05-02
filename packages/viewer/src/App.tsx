import { useState, useCallback, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary.tsx';
import { ClusterList } from './components/ClusterList/ClusterList.tsx';
import { ClusterDetail } from './components/ClusterDetail/ClusterDetail.tsx';
import { FilterBar } from './components/FilterBar/FilterBar.tsx';
import { SearchBox } from './components/SearchBox/SearchBox.tsx';
import { EmptyState } from './components/EmptyState/EmptyState.tsx';
import { LiveTailIndicator } from './components/LiveTailIndicator/LiveTailIndicator.tsx';
import { useUrlState } from './state/url-state.ts';
import { applyFilters } from './state/filters.ts';
import {
  pickRunDirectory,
  loadOccurrenceArtifacts,
  persistHandle,
} from './fs/directory-loader.ts';
import { loadFromFileList } from './fs/fallback-input.ts';
import { startFsPoll } from './live-tail/poll.ts';
import { startMcpStream } from './live-tail/mcp-stream.ts';
import type { DirectoryLoadResult } from './fs/directory-loader.ts';
import type { BugCluster, RunSummary, RunPhase } from './types.ts';
import type { PollEvent } from './live-tail/poll.ts';
import styles from './App.module.css';

const VIEWER_VERSION = '0.1.0';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; handle: FileSystemDirectoryHandle | null; summary: RunSummary; allClusters: BugCluster[] }
  | { kind: 'error'; message: string };

type LiveTailState =
  | { active: false }
  | { active: true; mode: 'mcp' | 'poll' | 'degraded'; phase: RunPhase; newCount: number };

export function App() {
  const [urlState, updateUrl] = useUrlState();
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [liveTail, setLiveTail] = useState<LiveTailState>({ active: false });
  const [persistDir, setPersistDir] = useState(false);
  const liveTailStopRef = useRef<(() => void) | null>(null);
  const focusSearchRef = useRef<(() => void) | null>(null);

  const mcpUrl = new URLSearchParams(window.location.search).get('mcp');

  const handlePollEvent = useCallback((event: PollEvent) => {
    if (event.kind === 'clusters_updated') {
      setLoadState(prev => {
        if (prev.kind !== 'loaded') return prev;
        setLiveTail(lt => lt.active ? { ...lt, newCount: lt.newCount + event.newCount } : lt);
        return { ...prev, allClusters: event.clusters };
      });
    } else if (event.kind === 'phase_changed') {
      setLiveTail(lt => lt.active ? { ...lt, phase: event.phase } : lt);
    } else if (event.kind === 'stopped') {
      setLiveTail({ active: false });
      liveTailStopRef.current = null;
    } else {
      console.error('[viewer] Live-tail error:', event.reason);
      setLiveTail(lt => lt.active ? { ...lt, mode: 'degraded' } : lt);
    }
  }, []);

  const startLiveTail = useCallback((
    handle: FileSystemDirectoryHandle | null,
    clusters: BugCluster[],
    summary: RunSummary,
  ) => {
    liveTailStopRef.current?.();

    if (mcpUrl !== null) {
      const controller = startMcpStream({
        mcpUrl,
        runId: summary.runId,
        handle,
        initialClusters: clusters,
        initialSummary: summary,
        onEvent: handlePollEvent,
      });
      liveTailStopRef.current = controller.stop;
      setLiveTail({ active: true, mode: 'mcp', phase: 'execute', newCount: 0 });
    } else if (handle !== null) {
      const controller = startFsPoll(handle, clusters, summary, handlePollEvent);
      liveTailStopRef.current = controller.stop;
      setLiveTail({ active: true, mode: 'poll', phase: 'execute', newCount: 0 });
    }
  }, [mcpUrl, handlePollEvent]);

  const applyLoadResult = useCallback((result: DirectoryLoadResult) => {
    if (result.kind === 'unsupported') {
      setLoadState({ kind: 'error', message: 'File System Access API is not supported in this browser. Use Chrome or Edge.' });
      return;
    }
    if (result.kind === 'cancelled') {
      // User cancelled — stay idle
      return;
    }
    if (result.kind === 'denied') {
      setLoadState({ kind: 'error', message: `Permission denied: ${result.reason}` });
      return;
    }
    if (result.kind === 'invalid') {
      const messages: Record<string, string> = {
        no_summary_json: "This doesn't look like a BugHunter run directory. Try .bughunter/runs/<id>/ instead.",
        no_bugs_jsonl: "Missing bugs.jsonl in this directory.",
        malformed_summary: "summary.json could not be parsed.",
      };
      setLoadState({ kind: 'error', message: messages[result.reason] ?? 'Invalid directory.' });
      return;
    }
    if (result.kind === 'loaded') {
      if (persistDir) {
        void persistHandle(result.handle);
      }
      setLoadState({ kind: 'loaded', handle: result.handle, summary: result.summary, allClusters: result.clusters });
      startLiveTail(result.handle, result.clusters, result.summary);
    }
  }, [persistDir, startLiveTail]);

  const handleOpenDirectory = useCallback(async () => {
    setLoadState({ kind: 'loading' });
    const result = await pickRunDirectory();
    applyLoadResult(result);
  }, [applyLoadResult]);

  const handleFallbackInput = useCallback(async (files: FileList) => {
    setLoadState({ kind: 'loading' });
    const result = await loadFromFileList(files);
    if (result.kind === 'loaded') {
      setLoadState({ kind: 'loaded', handle: null, summary: result.summary, allClusters: result.clusters });
    } else if (result.kind === 'cancelled') {
      setLoadState({ kind: 'idle' });
    } else {
      const messages: Record<string, string> = {
        no_summary_json: "This doesn't look like a BugHunter run directory.",
        no_bugs_jsonl: "Missing bugs.jsonl.",
        malformed_summary: "summary.json could not be parsed.",
      };
      setLoadState({ kind: 'error', message: messages[result.reason] ?? 'Invalid directory.' });
    }
  }, []);

  const selectedCluster = loadState.kind === 'loaded'
    ? loadState.allClusters.find(c => c.id === urlState.selectedClusterId) ?? null
    : null;

  const filteredClusters = loadState.kind === 'loaded'
    ? applyFilters(loadState.allClusters, urlState.filters, urlState.search)
    : [];

  const loadArtifactsForOccurrence = useCallback(async (occurrenceId: string) => {
    if (loadState.kind !== 'loaded' || loadState.handle === null) return {};
    return loadOccurrenceArtifacts(loadState.handle, occurrenceId);
  }, [loadState]);

  // Non-null only when there is an actual mismatch — carries the CLI version for the banner.
  const mismatchedCliVersion: string | null =
    loadState.kind === 'loaded' &&
    loadState.summary.viewerVersion !== undefined &&
    loadState.summary.viewerVersion !== VIEWER_VERSION
      ? loadState.summary.viewerVersion
      : null;

  return (
    <div className={styles.app} data-theme={urlState.theme}>
      <ErrorBoundary>
        <header className={styles.header}>
          <h1 className={styles.title}>BugHunter Viewer</h1>
          <div className={styles.headerActions}>
            {loadState.kind !== 'loaded' && (
              <>
                <button className={styles.openBtn} onClick={() => void handleOpenDirectory()}>
                  Open run directory
                </button>
                <label className={styles.fallbackLabel}>
                  or pick files:
                  <input
                    type="file"
                    // @ts-expect-error — webkitdirectory is non-standard but widely supported
                    webkitdirectory=""
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => {
                      if (e.target.files !== null && e.target.files.length > 0) {
                        void handleFallbackInput(e.target.files);
                      }
                    }}
                  />
                </label>
                <label className={styles.persistLabel}>
                  <input
                    type="checkbox"
                    checked={persistDir}
                    onChange={e => setPersistDir(e.target.checked)}
                  />
                  Remember directory
                </label>
              </>
            )}
            {loadState.kind === 'loaded' && (
              <button className={styles.openBtn} onClick={() => {
                liveTailStopRef.current?.();
                setLoadState({ kind: 'idle' });
              }}>
                Close
              </button>
            )}
          </div>
        </header>

        {mismatchedCliVersion !== null && (
          <div className={styles.versionBanner} role="alert">
            This run was produced by CLI v{mismatchedCliVersion}; the viewer is on v{VIEWER_VERSION}. Some fields may not render correctly.
          </div>
        )}

        {liveTail.active && (
          <LiveTailIndicator
            phase={liveTail.phase}
            newCount={liveTail.newCount}
            mode={liveTail.mode}
          />
        )}

        <main className={styles.main}>
          {loadState.kind === 'idle' && (
            <div className={styles.idleState}>
              <p>No directory loaded. Click &apos;Open run directory&apos; to begin.</p>
            </div>
          )}

          {loadState.kind === 'loading' && (
            <div className={styles.loadingState} aria-live="polite">
              <p>Loading run directory…</p>
            </div>
          )}

          {loadState.kind === 'error' && (
            <div className={styles.errorState} role="alert">
              <p>{loadState.message}</p>
              <button onClick={() => setLoadState({ kind: 'idle' })}>Try again</button>
            </div>
          )}

          {loadState.kind === 'loaded' && loadState.allClusters.length === 0 && (
            <EmptyState summary={loadState.summary} />
          )}

          {loadState.kind === 'loaded' && loadState.allClusters.length > 0 && (
            <div className={styles.layout}>
              <aside className={styles.sidebar}>
                <SearchBox
                  value={urlState.search}
                  onChange={q => updateUrl(prev => ({ ...prev, search: q }))}
                  onFocusRequested={cb => { focusSearchRef.current = cb; }}
                />
                <FilterBar
                  filters={urlState.filters}
                  onChange={filters => updateUrl(prev => ({ ...prev, filters }))}
                />
                <ClusterList
                  clusters={filteredClusters}
                  selectedId={urlState.selectedClusterId}
                  onSelect={id => {
                    updateUrl(prev => ({ ...prev, selectedClusterId: id }));
                    setLiveTail(lt => lt.active ? { ...lt, newCount: 0 } : lt);
                  }}
                  onFocusSearch={() => focusSearchRef.current?.()}
                />
              </aside>

              <section className={styles.detail} aria-label="Cluster detail">
                {selectedCluster !== null ? (
                  <ErrorBoundary>
                    <ClusterDetail
                      cluster={selectedCluster}
                      loadArtifacts={loadArtifactsForOccurrence}
                    />
                  </ErrorBoundary>
                ) : (
                  <div className={styles.noSelection}>
                    <p>Select a cluster from the list to see details.</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </ErrorBoundary>
    </div>
  );
}
