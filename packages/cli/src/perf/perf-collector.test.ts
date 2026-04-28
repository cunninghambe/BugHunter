// Tests for PerfCollector orchestrator — mocked CdpSession.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createPerfCollector } from './perf-collector.js';
import type { PerfCollectorOptions } from './perf-collector.js';

// Mock web-vitals-injector so tests don't read from filesystem
vi.mock('./web-vitals-injector.js', () => ({
  getInjectionScript: () => 'window.__bughunter_vitals__ = [];',
}));

function makeEmptyDrainResult() {
  return {
    webVitals: [],
    longTasks: [],
    heap: [],
    networkEvents: [],
    renderEvents: [],
    navigationEvents: [],
  };
}

function makeMockCdpSession() {
  let currentWindowId = 'init';
  const drainFn = vi.fn().mockResolvedValue(makeEmptyDrainResult());
  const newTabFn = vi.fn().mockResolvedValue({
    navigate: vi.fn(),
    evaluate: vi.fn().mockResolvedValue(undefined),
    sampleHeap: vi.fn().mockResolvedValue({
      capturedAtMs: 1000,
      jsHeapUsedSize: 52428800,
      jsHeapTotalSize: 67108864,
    }),
  });
  const closeFn = vi.fn().mockResolvedValue(undefined);
  const setCookiesFn = vi.fn().mockResolvedValue(undefined);

  return {
    newTab: newTabFn,
    drain: drainFn,
    close: closeFn,
    setCookies: setCookiesFn,
    setActionWindowId: (id: string) => { currentWindowId = id; },
    _getCurrentWindowId: () => currentWindowId,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bughunter-perf-test-'));
}

describe('createPerfCollector', () => {
  let tmpDir: string;
  let perfDir: string;
  let networkDir: string;
  let mockSession: ReturnType<typeof makeMockCdpSession>;

  beforeEach(() => {
    tmpDir = makeTempDir();
    perfDir = path.join(tmpDir, 'perf');
    networkDir = path.join(tmpDir, 'network');
    mockSession = makeMockCdpSession();
  });

  function makeOpts(overrides: Partial<PerfCollectorOptions> = {}): PerfCollectorOptions {
    return {
      cdpSession: mockSession,
      perfDir,
      networkDir,
      ...overrides,
    };
  }

  it('observe calls cdpSession.newTab with the given URL', async () => {
    const collector = await createPerfCollector(makeOpts());
    await collector.observe('http://localhost/dashboard');
    expect(mockSession.newTab).toHaveBeenCalledWith('http://localhost/dashboard');
  });

  it('drain writes perf artifact JSON to perfDir', async () => {
    const collector = await createPerfCollector(makeOpts());
    await collector.observe('http://localhost/');
    await collector.drain('occ-123');
    const file = path.join(perfDir, 'occ-123.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.occurrenceId).toBe('occ-123');
  });

  it('drain writes HAR artifact to networkDir', async () => {
    const collector = await createPerfCollector(makeOpts());
    await collector.observe('http://localhost/');
    await collector.drain('occ-456');
    const harFile = path.join(networkDir, 'occ-456.har');
    expect(fs.existsSync(harFile)).toBe(true);
    const har = JSON.parse(fs.readFileSync(harFile, 'utf-8'));
    expect(har.log.version).toBe('1.2');
  });

  it('drain returns perf artifact with webVitals from cdpSession', async () => {
    const vitals = [{ name: 'LCP', value: 3500, rating: 'poor', capturedAtMs: 500 }];
    mockSession.drain.mockResolvedValueOnce({
      ...makeEmptyDrainResult(),
      webVitals: vitals,
    });
    const collector = await createPerfCollector(makeOpts());
    await collector.observe('http://localhost/');
    const { perf } = await collector.drain('occ-789');
    expect(perf.webVitals).toHaveLength(1);
    expect(perf.webVitals[0].name).toBe('LCP');
    expect(perf.webVitals[0].value).toBe(3500);
  });

  it('tick sets the action window id on the cdpSession', async () => {
    const collector = await createPerfCollector(makeOpts());
    collector.tick('my-window-id');
    expect(mockSession._getCurrentWindowId()).toBe('my-window-id');
  });

  it('heapSampling=false skips sampleHeap calls', async () => {
    const collector = await createPerfCollector(makeOpts({ heapSampling: false }));
    const tab = await mockSession.newTab.mock.results[0]?.value ?? { sampleHeap: vi.fn() };
    await collector.observe('http://localhost/');
    const { perf } = await collector.drain('occ-heap');
    expect(perf.heapSamples).toHaveLength(0);
  });

  it('heapSampling=true calls sampleHeap and includes in perf', async () => {
    const collector = await createPerfCollector(makeOpts({ heapSampling: true }));
    await collector.observe('http://localhost/');
    const { perf } = await collector.drain('occ-heap2');
    expect(perf.heapSamples.length).toBeGreaterThan(0);
  });

  it('drain returns empty vitals when observe not called', async () => {
    const collector = await createPerfCollector(makeOpts());
    // No observe — drain should not throw
    const { perf } = await collector.drain('occ-no-nav');
    expect(perf.webVitals).toEqual([]);
    expect(perf.occurrenceId).toBe('occ-no-nav');
  });
});
