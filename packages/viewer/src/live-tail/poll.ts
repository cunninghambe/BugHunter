import type { BugCluster, RunSummary, RunPhase } from '../types.ts';
import { loadFromHandle } from '../fs/directory-loader.ts';

const POLL_INTERVAL_MS = 1500;
const STABLE_STOP_MS = 30_000;

export type PollEvent =
  | { kind: 'clusters_updated'; clusters: BugCluster[]; newCount: number }
  | { kind: 'phase_changed'; phase: RunPhase }
  | { kind: 'stopped' }
  | { kind: 'error'; reason: string };

export type PollController = {
  stop: () => void;
};

// RunSummary doesn't carry `phase` — we read it from the summary file where
// the CLI may write it as an extra field (forward-compat). Typed as unknown here.
type SummaryWithOptionalPhase = RunSummary & { phase?: RunPhase };

export function startFsPoll(
  handle: FileSystemDirectoryHandle,
  initialClusters: BugCluster[],
  initialSummary: RunSummary,
  onEvent: (event: PollEvent) => void,
): PollController {
  let stopped = false;
  let lastBugsFiled = initialSummary.bugs_filed;
  let lastPhase: RunPhase = (initialSummary as SummaryWithOptionalPhase).phase ?? 'execute';
  let stableMs = 0;
  let lastPollTime = Date.now();

  const clusterMap = new Map<string, BugCluster>(initialClusters.map(c => [c.id, c]));

  async function poll(): Promise<void> {
    if (stopped) return;

    const now = Date.now();
    const elapsed = now - lastPollTime;
    lastPollTime = now;

    try {
      const result = await loadFromHandle(handle);
      if (result.kind !== 'loaded') {
        onEvent({ kind: 'error', reason: `directory load failed: ${result.kind}` });
        stopped = true;
        return;
      }

      const summary = result.summary as SummaryWithOptionalPhase;
      const { clusters } = result;

      // Phase change
      const newPhase = summary.phase ?? lastPhase;
      if (newPhase !== lastPhase) {
        lastPhase = newPhase;
        onEvent({ kind: 'phase_changed', phase: newPhase });
      }

      // New clusters
      if (summary.bugs_filed > lastBugsFiled) {
        const newClusters: BugCluster[] = [];
        for (const c of clusters) {
          if (!clusterMap.has(c.id)) {
            clusterMap.set(c.id, c);
            newClusters.push(c);
          }
        }
        lastBugsFiled = summary.bugs_filed;
        stableMs = 0;
        onEvent({ kind: 'clusters_updated', clusters: Array.from(clusterMap.values()), newCount: newClusters.length });
      } else {
        stableMs += elapsed;
      }

      // Stop when run is done or bugs_filed has been stable for 30s
      const isDone = summary.phase === 'done' || stableMs >= STABLE_STOP_MS;
      if (isDone) {
        onEvent({ kind: 'stopped' });
        stopped = true;
        return;
      }
    } catch (err) {
      // EC-8: handle revoked
      const reason = err instanceof Error ? err.message : String(err);
      onEvent({ kind: 'error', reason });
      stopped = true;
      return;
    }

    setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
  }

  setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);

  return { stop: () => { stopped = true; } };
}
