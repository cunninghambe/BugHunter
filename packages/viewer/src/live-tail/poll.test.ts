import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BugCluster, RunSummary } from '../types.ts';

// We need to mock the directory loader before importing poll.ts
const mockLoadFromHandle = vi.fn();
vi.mock('../fs/directory-loader.ts', () => ({
  loadFromHandle: (...args: unknown[]) => mockLoadFromHandle(...args),
}));

// Import after mock setup
const { startFsPoll } = await import('./poll.ts');

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
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
    ...overrides,
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

const fakeHandle = {} as FileSystemDirectoryHandle;

describe('startFsPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadFromHandle.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits clusters_updated when bugs_filed increases', async () => {
    const events: Array<{ kind: string }> = [];
    const initialSummary = makeSummary({ bugs_filed: 1 });
    const newCluster = makeCluster('c2');

    mockLoadFromHandle.mockResolvedValue({
      kind: 'loaded',
      summary: makeSummary({ bugs_filed: 2 }),
      clusters: [makeCluster('c1'), newCluster],
      runId: 'run-1',
      handle: fakeHandle,
    });

    startFsPoll(fakeHandle, [makeCluster('c1')], initialSummary, e => events.push(e));

    // First poll
    await vi.advanceTimersByTimeAsync(1500);
    // Flush promises
    await Promise.resolve();
    await Promise.resolve();

    const updateEvent = events.find(e => e.kind === 'clusters_updated');
    expect(updateEvent).toBeDefined();
  });

  it('emits stopped when bugs_filed is stable for 30s', async () => {
    const events: Array<{ kind: string }> = [];
    const initialSummary = makeSummary({ bugs_filed: 1 });

    mockLoadFromHandle.mockResolvedValue({
      kind: 'loaded',
      summary: makeSummary({ bugs_filed: 1 }),
      clusters: [makeCluster('c1')],
      runId: 'run-1',
      handle: fakeHandle,
    });

    startFsPoll(fakeHandle, [makeCluster('c1')], initialSummary, e => events.push(e));

    // Advance past 30s stable threshold
    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      await Promise.resolve();
      await Promise.resolve();
    }

    const stoppedEvent = events.find(e => e.kind === 'stopped');
    expect(stoppedEvent).toBeDefined();
  });

  it('emits error when loadFromHandle throws', async () => {
    const events: Array<{ kind: string }> = [];
    mockLoadFromHandle.mockRejectedValue(new Error('Permission denied'));

    startFsPoll(fakeHandle, [], makeSummary(), e => events.push(e));

    await vi.advanceTimersByTimeAsync(1500);
    await Promise.resolve();
    await Promise.resolve();

    const errorEvent = events.find(e => e.kind === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('stop() prevents further polling', async () => {
    let callCount = 0;
    mockLoadFromHandle.mockImplementation(async () => {
      callCount++;
      return { kind: 'loaded', summary: makeSummary({ bugs_filed: 0 }), clusters: [], runId: 'run-1', handle: fakeHandle };
    });

    const controller = startFsPoll(fakeHandle, [], makeSummary(), () => {});
    controller.stop();

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(callCount).toBe(0);
  });
});
