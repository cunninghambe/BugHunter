// Tests for CdpSession adapter — all using mocked playwright-core.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateCdpSessionResult } from './cdp-session.js';

// Mock playwright-core before importing the module under test
const mockCdpSend = vi.fn();
const mockPageEvaluate = vi.fn();
const mockPageGoto = vi.fn();
const mockPageClose = vi.fn();
const mockPageOn = vi.fn();
const mockPageMainFrame = vi.fn(() => ({ url: () => 'http://localhost/' }));
const mockContextNewPage = vi.fn();
const mockContextNewCdpSession = vi.fn();
const mockContextAddCookies = vi.fn();
const mockContextClose = vi.fn();
const mockBrowserNewContext = vi.fn();
const mockBrowserClose = vi.fn();
const mockChromiumLaunch = vi.fn();

vi.mock('playwright-core', () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

function makeMockCdp(handlers: Record<string, (payload: unknown) => void> = {}) {
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  return {
    send: mockCdpSend,
    on: (event: string, handler: (payload: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
      if (handlers[event] !== undefined) {
        // Store for manual triggering in tests
      }
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      if (listeners[event] !== undefined) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
    },
    removeAllListeners: () => {
      for (const key of Object.keys(listeners)) {
        delete listeners[key];
      }
    },
    emit: (event: string, payload: unknown) => {
      (listeners[event] ?? []).forEach(h => h(payload));
    },
    listenerCount: (event: string) => listeners[event]?.length ?? 0,
    _listeners: listeners,
  };
}

function makeMockPage(cdp: ReturnType<typeof makeMockCdp>) {
  return {
    goto: mockPageGoto,
    evaluate: mockPageEvaluate,
    close: mockPageClose,
    on: mockPageOn,
    mainFrame: mockPageMainFrame,
    context: () => ({
      newCDPSession: () => Promise.resolve(cdp),
    }),
  };
}

describe('createCdpSession', () => {
  let mockCdp: ReturnType<typeof makeMockCdp>;
  let mockPage: ReturnType<typeof makeMockPage>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockCdp = makeMockCdp();
    mockPage = makeMockPage(mockCdp);

    mockCdpSend.mockResolvedValue({
      metrics: [
        { name: 'JSHeapUsedSize', value: 52428800 },
        { name: 'JSHeapTotalSize', value: 67108864 },
      ],
    });
    mockPageEvaluate.mockResolvedValue([]);
    mockPageGoto.mockResolvedValue(null);
    mockPageClose.mockResolvedValue(undefined);
    mockContextNewPage.mockResolvedValue(mockPage);
    mockContextNewCdpSession.mockResolvedValue(mockCdp);
    mockContextAddCookies.mockResolvedValue(undefined);
    mockContextClose.mockResolvedValue(undefined);
    mockBrowserNewContext.mockResolvedValue({
      newPage: mockContextNewPage,
      newCDPSession: mockContextNewCdpSession,
      addCookies: mockContextAddCookies,
      close: mockContextClose,
    });
    mockBrowserClose.mockResolvedValue(undefined);
    mockChromiumLaunch.mockResolvedValue({
      newContext: mockBrowserNewContext,
      close: mockBrowserClose,
    });
  });

  it('returns ok:true when browser launches successfully', async () => {
    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false when browser launch fails', async () => {
    mockChromiumLaunch.mockRejectedValueOnce(new Error('browser failed to launch'));
    const { createCdpSession } = await import('./cdp-session.js');
    const result: CreateCdpSessionResult = await createCdpSession();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Failed to launch CDP browser');
    }
  });

  it('imports cookies when cookieJar is provided', async () => {
    const { createCdpSession } = await import('./cdp-session.js');
    await createCdpSession({
      cookieJar: [{
        name: 'session',
        value: 'abc',
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      }],
    });
    expect(mockContextAddCookies).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'session' })])
    );
  });

  it('calls Network.enable and Performance.enable on newTab', async () => {
    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    if (!result.ok) throw new Error('Expected ok');
    await result.session.newTab('http://localhost/');
    expect(mockCdpSend).toHaveBeenCalledWith('Network.enable', {});
    expect(mockCdpSend).toHaveBeenCalledWith('Performance.enable', {});
  });

  it('drain returns empty arrays when no events collected', async () => {
    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    if (!result.ok) throw new Error('Expected ok');
    await result.session.newTab('http://localhost/');
    const drained = await result.session.drain();
    expect(drained.webVitals).toEqual([]);
    expect(drained.longTasks).toEqual([]);
    expect(drained.networkEvents).toEqual([]);
    expect(drained.renderEvents).toEqual([]);
  });

  it('close is idempotent', async () => {
    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    if (!result.ok) throw new Error('Expected ok');
    await result.session.close();
    await result.session.close();
    // Second close should not throw or call close again
    expect(mockBrowserClose).toHaveBeenCalledTimes(1);
  });

  it('sampleHeap returns heap metrics from CDP Performance.getMetrics', async () => {
    mockCdpSend.mockImplementation((method: string) => {
      if (method === 'Performance.getMetrics') {
        return Promise.resolve({
          metrics: [
            { name: 'JSHeapUsedSize', value: 52428800 },
            { name: 'JSHeapTotalSize', value: 67108864 },
          ],
        });
      }
      return Promise.resolve({});
    });

    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    if (!result.ok) throw new Error('Expected ok');
    const tab = await result.session.newTab('http://localhost/');
    const sample = await tab.sampleHeap();
    expect(sample.jsHeapUsedSize).toBe(52428800);
    expect(sample.jsHeapTotalSize).toBe(67108864);
    expect(sample.capturedAtMs).toBeGreaterThan(0);
  });

  // Regression test for #141: CDP session must not leak abort listeners on long runs.
  it('repeated newTab calls do not accumulate listeners on retired CDP sessions (#141)', async () => {
    const cdpInstances: ReturnType<typeof makeMockCdp>[] = [];

    mockContextNewCdpSession.mockImplementation(() => {
      const cdp = makeMockCdp();
      cdpInstances.push(cdp);
      return Promise.resolve(cdp);
    });

    const { createCdpSession } = await import('./cdp-session.js');
    const result = await createCdpSession();
    if (!result.ok) throw new Error('Expected ok');

    const N = 100;
    for (let i = 0; i < N; i++) {
      await result.session.newTab(`http://localhost/page-${i}`);
    }

    // Every CDP instance except the last one should have zero listeners — they were
    // cleared by removeAllListeners() before the next newTab replaced them.
    const retiredCdps = cdpInstances.slice(0, -1);
    const totalRetiredListeners = retiredCdps.reduce((sum, cdp) => {
      return sum + Object.values(cdp._listeners).reduce((s, arr) => s + arr.length, 0);
    }, 0);

    expect(retiredCdps).toHaveLength(N - 1);
    expect(totalRetiredListeners).toBe(0);

    // The active (last) CDP session should have exactly the expected listeners attached.
    const activeCdp = cdpInstances[cdpInstances.length - 1];
    const activeListenerCount = Object.values(activeCdp._listeners).reduce((s, arr) => s + arr.length, 0);
    expect(activeListenerCount).toBeGreaterThan(0);
  });
});
