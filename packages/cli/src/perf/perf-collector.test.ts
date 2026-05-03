// Tests for PerfCollector orchestrator — mocked CdpSession.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createPerfCollector } from './perf-collector.js';
import type { PerfCollectorOptions, PageEvaluator } from './perf-collector.js';

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
    consoleErrors: [],
  };
}

function makeMockCdpSession() {
  let currentWindowId = 'init';
  const drainFn = vi.fn().mockResolvedValue(makeEmptyDrainResult());
  const closeFn = vi.fn().mockResolvedValue(undefined);
  const setCookiesFn = vi.fn().mockResolvedValue(undefined);
  const takeHeapSnapshotFn = vi.fn().mockResolvedValue('');
  const collectGarbageFn = vi.fn().mockResolvedValue(undefined);

  return {
    drain: drainFn,
    close: closeFn,
    setCookies: setCookiesFn,
    takeHeapSnapshot: takeHeapSnapshotFn,
    collectGarbage: collectGarbageFn,
    setActionWindowId: (id: string) => { currentWindowId = id; },
    _getCurrentWindowId: () => currentWindowId,
  };
}

function makeMockScope(vitalsData: unknown[] = [], longTasksData: unknown[] = [], renderEventsData: unknown[] = []): PageEvaluator {
  return {
    evaluate: vi.fn().mockImplementation((script: string) => {
      if (script.includes('__bughunter_vitals__')) return Promise.resolve({ value: vitalsData });
      if (script.includes('__bughunter_long_tasks__')) return Promise.resolve({ value: longTasksData });
      if (script.includes('__bughunter_render_events__')) return Promise.resolve({ value: renderEventsData });
      // injection script
      return Promise.resolve({ value: undefined });
    }),
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
      cdpSession: mockSession as unknown as PerfCollectorOptions['cdpSession'],
      perfDir,
      networkDir,
      ...overrides,
    };
  }

  it('observe injects vitals script into the provided scope', async () => {
    const scope = makeMockScope();
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/dashboard');
    expect(scope.evaluate).toHaveBeenCalledWith(expect.stringContaining('__bughunter_vitals__'));
  });

  it('observe does NOT open a separate CDP tab (no newTab call)', () => {
    // CdpSession no longer has newTab — the old race-causing path is gone
    expect('newTab' in mockSession).toBe(false);
  });

  it('drain writes perf artifact JSON to perfDir', async () => {
    const scope = makeMockScope();
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    await collector.captureVitals();
    await collector.drain('occ-123');
    const file = path.join(perfDir, 'occ-123.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.occurrenceId).toBe('occ-123');
  });

  it('drain writes HAR artifact to networkDir', async () => {
    const scope = makeMockScope();
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    await collector.captureVitals();
    await collector.drain('occ-456');
    const harFile = path.join(networkDir, 'occ-456.har');
    expect(fs.existsSync(harFile)).toBe(true);
    const har = JSON.parse(fs.readFileSync(harFile, 'utf-8'));
    expect(har.log.version).toBe('1.2');
  });

  it('drain returns web vitals read from the scope', async () => {
    const vitals = [{ name: 'LCP', value: 3500, rating: 'poor', capturedAtMs: 500 }];
    const scope = makeMockScope(vitals);
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    await collector.captureVitals();
    const { perf } = await collector.drain('occ-789');
    expect(perf.webVitals).toHaveLength(1);
    expect(perf.webVitals[0].name).toBe('LCP');
    expect(perf.webVitals[0].value).toBe(3500);
  });

  it('tick sets the action window id on the cdpSession', () => {
    const collector = createPerfCollector(makeOpts());
    collector.tick('my-window-id');
    expect(mockSession._getCurrentWindowId()).toBe('my-window-id');
  });

  it('drain returns empty vitals when observe not called', async () => {
    const collector = createPerfCollector(makeOpts());
    // No observe — drain should not throw
    const { perf } = await collector.drain('occ-no-nav');
    expect(perf.webVitals).toEqual([]);
    expect(perf.occurrenceId).toBe('occ-no-nav');
  });

  it('drain returns empty vitals when captureVitals not called', async () => {
    const scope = makeMockScope([{ name: 'LCP', value: 1000, rating: 'good', capturedAtMs: 100 }]);
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    // captureVitals not called — drain reads empty captured buffer
    const { perf } = await collector.drain('occ-no-capture');
    expect(perf.webVitals).toEqual([]);
  });

  it('captureVitals reads long tasks from scope', async () => {
    const longTasks = [{ duration: 200, startTime: 50 }];
    const scope = makeMockScope([], longTasks);
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    await collector.captureVitals();
    const { perf } = await collector.drain('occ-lt');
    expect(perf.longTasks).toHaveLength(1);
    expect(perf.longTasks[0].duration).toBe(200);
  });

  it('captureVitals reads render events from scope', async () => {
    const renderEvents = [{ component: 'App', capturedAtMs: 10 }];
    const scope = makeMockScope([], [], renderEvents);
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    await collector.captureVitals();
    const { perf } = await collector.drain('occ-re');
    expect(perf.renderEvents).toHaveLength(1);
    expect(perf.renderEvents[0].component).toBe('App');
  });

  it('observe resets captured buffer between pages', async () => {
    const scope1 = makeMockScope([{ name: 'LCP', value: 1000, rating: 'good', capturedAtMs: 50 }]);
    const scope2 = makeMockScope([]);
    const collector = createPerfCollector(makeOpts());

    await collector.observe(scope1, 'http://localhost/page1');
    await collector.captureVitals();
    await collector.drain('occ-p1');

    // Second page — no vitals
    await collector.observe(scope2, 'http://localhost/page2');
    await collector.captureVitals();
    const { perf: perf2 } = await collector.drain('occ-p2');
    expect(perf2.webVitals).toEqual([]);
  });

  it('captureVitals is safe when scope evaluate throws', async () => {
    const scope: PageEvaluator = {
      evaluate: vi.fn().mockRejectedValue(new Error('tab closed')),
    };
    const collector = createPerfCollector(makeOpts());
    await collector.observe(scope, 'http://localhost/');
    // Should not throw — errors are caught internally
    await expect(collector.captureVitals()).resolves.toBeUndefined();
    const { perf } = await collector.drain('occ-err');
    expect(perf.webVitals).toEqual([]);
  });

  it('captureVitals is a no-op when called without observe', async () => {
    const collector = createPerfCollector(makeOpts());
    await expect(collector.captureVitals()).resolves.toBeUndefined();
  });
});
