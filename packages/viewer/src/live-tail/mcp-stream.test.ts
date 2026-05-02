import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BugCluster, RunSummary } from '../types.ts';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type EventSourceHandler = (e: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: EventSourceHandler | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  dispatch(data: unknown): void {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
  }

  triggerError(): void {
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
  }
}

// We can't easily mock EventSource globally in vitest without a proper setup.
// These tests validate the controller logic at the module level.

// Mock the poll module
const mockStartFsPoll = vi.fn();
vi.mock('./poll.ts', () => ({
  startFsPoll: (...args: unknown[]) => mockStartFsPoll(...args),
}));

const { startMcpStream } = await import('./mcp-stream.ts');

function makeSummary(): RunSummary {
  return {
    runId: 'run-1',
    bugs_filed: 0,
    bugs_specced: 0,
    bugs_attempted_fix: 0,
    bugs_architect_refused: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
    byKind: {},
    byRole: {},
    actualRuntimeMs: 0,
    testsPlanned: 0,
    testsRan: 0,
    testsSkipped: 0,
    skippedReasons: [],
    suppressedClusters: 0,
  };
}

function makeCluster(id: string): BugCluster {
  return {
    id,
    runId: 'run-1',
    kind: 'console_error',
    rootCause: 'test',
    firstSeenAt: '',
    lastSeenAt: '',
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
  } as BugCluster;
}

describe('startMcpStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    mockStartFsPoll.mockReset();
    mockStartFsPoll.mockReturnValue({ stop: vi.fn() });
    // Replace global EventSource with our mock
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appends new clusters from cluster stream event', () => {
    const events: Array<{ kind: string }> = [];
    const controller = startMcpStream({
      mcpUrl: 'http://127.0.0.1:3107',
      runId: 'run-1',
      handle: null,
      initialClusters: [],
      initialSummary: makeSummary(),
      onEvent: e => events.push(e),
    });

    // Find the cluster stream EventSource
    const clusterSource = MockEventSource.instances.find(s => s.url.includes('clusters/stream'));
    expect(clusterSource).toBeDefined();

    clusterSource?.dispatch(makeCluster('new-c1'));

    const updateEvent = events.find(e => e.kind === 'clusters_updated');
    expect(updateEvent).toBeDefined();

    controller.stop();
  });

  it('does not emit duplicate clusters', () => {
    const events: Array<{ kind: string }> = [];
    const existingCluster = makeCluster('existing');
    const controller = startMcpStream({
      mcpUrl: 'http://127.0.0.1:3107',
      runId: 'run-1',
      handle: null,
      initialClusters: [existingCluster],
      initialSummary: makeSummary(),
      onEvent: e => events.push(e),
    });

    const clusterSource = MockEventSource.instances.find(s => s.url.includes('clusters/stream'));
    // Send the same cluster again
    clusterSource?.dispatch(existingCluster);

    const updateEvents = events.filter(e => e.kind === 'clusters_updated');
    expect(updateEvents).toHaveLength(0);

    controller.stop();
  });

  it('emits stopped when phase stream emits done', () => {
    const events: Array<{ kind: string }> = [];
    const controller = startMcpStream({
      mcpUrl: 'http://127.0.0.1:3107',
      runId: 'run-1',
      handle: null,
      initialClusters: [],
      initialSummary: makeSummary(),
      onEvent: e => events.push(e),
    });

    const phaseSource = MockEventSource.instances.find(s => s.url.includes('phase/stream'));
    phaseSource?.dispatch({ phase: 'done' });

    const stoppedEvent = events.find(e => e.kind === 'stopped');
    expect(stoppedEvent).toBeDefined();

    controller.stop();
  });

  it('degrades to FS poll on cluster stream error when handle is provided', () => {
    const fakeHandle = {} as FileSystemDirectoryHandle;
    const events: Array<{ kind: string }> = [];

    const controller = startMcpStream({
      mcpUrl: 'http://127.0.0.1:3107',
      runId: 'run-1',
      handle: fakeHandle,
      initialClusters: [],
      initialSummary: makeSummary(),
      onEvent: e => events.push(e),
    });

    const clusterSource = MockEventSource.instances.find(s => s.url.includes('clusters/stream'));
    clusterSource?.triggerError();

    expect(mockStartFsPoll).toHaveBeenCalledOnce();

    controller.stop();
  });
});
