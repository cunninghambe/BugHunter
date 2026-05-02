import type { BugCluster, RunSummary, RunPhase } from '../types.ts';
import type { PollController, PollEvent } from './poll.ts';
import { startFsPoll } from './poll.ts';

// v0.30 streaming MCP resource subscriber.
// Opens SSE EventSource connections to the three resource streams.
// Falls back to FS poll on connection error.

type McpStreamOptions = {
  mcpUrl: string;
  runId: string;
  handle: FileSystemDirectoryHandle | null;
  initialClusters: BugCluster[];
  initialSummary: RunSummary;
  onEvent: (event: PollEvent) => void;
};

export type McpStreamController = {
  stop: () => void;
};

export function startMcpStream({
  mcpUrl,
  runId,
  handle,
  initialClusters,
  initialSummary,
  onEvent,
}: McpStreamOptions): McpStreamController {
  let stopped = false;
  let fallbackController: PollController | null = null;
  const sources: EventSource[] = [];

  const clusterStreamUrl = `${mcpUrl}/bughunter/runs/${encodeURIComponent(runId)}/clusters/stream`;
  const phaseStreamUrl = `${mcpUrl}/bughunter/runs/${encodeURIComponent(runId)}/phase/stream`;

  const clusterMap = new Map<string, BugCluster>(initialClusters.map(c => [c.id, c]));

  function degradeToFsPoll(): void {
    if (handle === null || fallbackController !== null) return;
    onEvent({ kind: 'phase_changed', phase: 'execute' });
    fallbackController = startFsPoll(handle, Array.from(clusterMap.values()), initialSummary, onEvent);
  }

  // Cluster stream
  const clusterSource = new EventSource(clusterStreamUrl);
  sources.push(clusterSource);

  clusterSource.onmessage = (e: MessageEvent) => {
    if (stopped) return;
    try {
      const cluster = JSON.parse(e.data as string) as BugCluster;
      if (!clusterMap.has(cluster.id)) {
        clusterMap.set(cluster.id, cluster);
        onEvent({ kind: 'clusters_updated', clusters: Array.from(clusterMap.values()), newCount: 1 });
      }
    } catch (err) {
      console.warn('[viewer/mcp-stream] Failed to parse cluster event', err);
    }
  };

  clusterSource.onerror = () => {
    if (stopped) return;
    console.warn('[viewer/mcp-stream] Cluster stream error — degrading to FS poll');
    clusterSource.close();
    degradeToFsPoll();
  };

  // Phase stream
  const phaseSource = new EventSource(phaseStreamUrl);
  sources.push(phaseSource);

  phaseSource.onmessage = (e: MessageEvent) => {
    if (stopped) return;
    try {
      const data = JSON.parse(e.data as string) as { phase: RunPhase };
      onEvent({ kind: 'phase_changed', phase: data.phase });
      if (data.phase === 'done') {
        onEvent({ kind: 'stopped' });
        stopped = true;
        sources.forEach(s => s.close());
      }
    } catch (err) {
      console.warn('[viewer/mcp-stream] Failed to parse phase event', err);
    }
  };

  phaseSource.onerror = () => {
    if (stopped) return;
    console.warn('[viewer/mcp-stream] Phase stream error');
    phaseSource.close();
  };

  return {
    stop: () => {
      stopped = true;
      sources.forEach(s => s.close());
      fallbackController?.stop();
    },
  };
}
