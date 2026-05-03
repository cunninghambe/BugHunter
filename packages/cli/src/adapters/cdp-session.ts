// CDP session adapter — sole import point for playwright-core.
// Creates a parallel Playwright Chromium instance for performance observation.
// The existing camofox adapter (browser-mcp.ts) is NOT modified.

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, CDPSession as PlaywrightCdpSession, Cookie } from 'playwright-core';
import type { Protocol } from 'playwright-core/types/protocol';
import type { WebVitalSample, LongTaskSample, HeapSample, RenderEvent, ConsoleError, HeapSnapshotRaw } from '../types.js';
import { log } from '../log.js';

// Minimal CDP network event types (subset we actually use for HAR building).
export type NetworkRequestEvent = {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  timestamp: number;
  type: string;
  initiator?: { type: string };
  postData?: string;
};

export type NetworkResponseEvent = {
  requestId: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  timestamp: number;
  timing?: {
    requestTime: number;
    sendStart: number;
    sendEnd: number;
    receiveHeadersEnd: number;
  };
};

export type NetworkLoadingFinishedEvent = {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
};

export type NetworkLoadingFailedEvent = {
  requestId: string;
  timestamp: number;
  canceled?: boolean;
  errorText: string;
};

export type NetworkEvent =
  | { type: 'requestWillBeSent'; event: NetworkRequestEvent; actionWindowId: string }
  | { type: 'responseReceived'; event: NetworkResponseEvent; actionWindowId: string }
  | { type: 'loadingFinished'; event: NetworkLoadingFinishedEvent; actionWindowId: string }
  | { type: 'loadingFailed'; event: NetworkLoadingFailedEvent; actionWindowId: string };

export type NavigationEvent = {
  url: string;
  timestamp: number;
};

export type DrainResult = {
  webVitals: WebVitalSample[];
  longTasks: LongTaskSample[];
  heap: HeapSample[];
  networkEvents: NetworkEvent[];
  renderEvents: RenderEvent[];
  navigationEvents: NavigationEvent[];
  /** Console errors collected via CDP Console.messageAdded (level: 'error'). */
  consoleErrors: ConsoleError[];
};

export interface CdpTabScope {
  navigate(url: string): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  sampleHeap(): Promise<HeapSample>;
}

export interface CdpSession {
  newTab(url: string): Promise<CdpTabScope>;
  drain(): Promise<DrainResult>;
  setCookies(cookies: Cookie[]): Promise<void>;
  close(): Promise<void>;
  takeHeapSnapshot(): Promise<HeapSnapshotRaw>;
  collectGarbage(): Promise<void>;
}

type CollectedData = {
  networkEvents: NetworkEvent[];
  navigationEvents: NavigationEvent[];
  consoleErrors: ConsoleError[];
  currentActionWindowId: string;
};

function makeEmptyDrain(): DrainResult {
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

class CdpTabScopeImpl implements CdpTabScope {
  constructor(private readonly page: Page, private readonly cdp: PlaywrightCdpSession) {}

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async evaluate<T>(script: string): Promise<T> {
    return this.page.evaluate(script) as Promise<T>;
  }

  async sampleHeap(): Promise<HeapSample> {
    const metrics = await this.cdp.send('Performance.getMetrics');
    const usedSize = metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0;
    const totalSize = metrics.metrics.find(m => m.name === 'JSHeapTotalSize')?.value ?? 0;
    return {
      capturedAtMs: Date.now(),
      jsHeapUsedSize: Math.round(usedSize),
      jsHeapTotalSize: Math.round(totalSize),
    };
  }
}

// Named handler types for each CDP event so they can be removed explicitly on cleanup.
type CdpHandlers = {
  onConsoleMessage: (ev: Protocol.Console.messageAddedPayload) => void;
  onRequestWillBeSent: (ev: Protocol.Network.requestWillBeSentPayload) => void;
  onResponseReceived: (ev: Protocol.Network.responseReceivedPayload) => void;
  onLoadingFinished: (ev: Protocol.Network.loadingFinishedPayload) => void;
  onLoadingFailed: (ev: Protocol.Network.loadingFailedPayload) => void;
};

class CdpSessionImpl implements CdpSession {
  private readonly collected: CollectedData = {
    networkEvents: [],
    navigationEvents: [],
    consoleErrors: [],
    currentActionWindowId: 'init',
  };

  private page: Page | null = null;
  private cdp: PlaywrightCdpSession | null = null;
  private cdpHandlers: CdpHandlers | null = null;
  private closed = false;

  constructor(private readonly browser: Browser, private readonly context: BrowserContext) {}

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
    }
  }

  private detachCdpHandlers(): void {
    if (this.cdp === null || this.cdpHandlers === null) return;
    this.cdp.off('Console.messageAdded', this.cdpHandlers.onConsoleMessage);
    this.cdp.off('Network.requestWillBeSent', this.cdpHandlers.onRequestWillBeSent);
    this.cdp.off('Network.responseReceived', this.cdpHandlers.onResponseReceived);
    this.cdp.off('Network.loadingFinished', this.cdpHandlers.onLoadingFinished);
    this.cdp.off('Network.loadingFailed', this.cdpHandlers.onLoadingFailed);
    this.cdpHandlers = null;
  }

  async newTab(url: string): Promise<CdpTabScope> {
    this.detachCdpHandlers();
    if (this.page !== null) {
      await this.page.close().catch(() => undefined);
    }
    const page = await this.context.newPage();
    this.page = page;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;

    await cdp.send('Network.enable', {});
    await cdp.send('Performance.enable', {});
    await cdp.send('Console.enable', {});

    const onConsoleMessage: CdpHandlers['onConsoleMessage'] = (ev) => {
      if (ev.message.level === 'error') {
        this.collected.consoleErrors.push({ level: 'error', text: ev.message.text });
      }
    };

    const onRequestWillBeSent: CdpHandlers['onRequestWillBeSent'] = (ev) => {
      this.collected.networkEvents.push({
        type: 'requestWillBeSent',
        event: {
          requestId: ev.requestId,
          url: ev.request.url,
          method: ev.request.method,
          headers: ev.request.headers as Record<string, string>,
          timestamp: ev.timestamp,
          type: ev.type ?? 'Other',
          initiator: { type: ev.initiator.type },
          postData: ev.request.postData ?? undefined,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    };

    const onResponseReceived: CdpHandlers['onResponseReceived'] = (ev) => {
      this.collected.networkEvents.push({
        type: 'responseReceived',
        event: {
          requestId: ev.requestId,
          url: ev.response.url,
          status: ev.response.status,
          statusText: ev.response.statusText,
          headers: ev.response.headers as Record<string, string>,
          mimeType: ev.response.mimeType,
          timestamp: ev.timestamp,
          timing: ev.response.timing != null ? {
            requestTime: ev.response.timing.requestTime,
            sendStart: ev.response.timing.sendStart,
            sendEnd: ev.response.timing.sendEnd,
            receiveHeadersEnd: ev.response.timing.receiveHeadersEnd,
          } : undefined,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    };

    const onLoadingFinished: CdpHandlers['onLoadingFinished'] = (ev) => {
      this.collected.networkEvents.push({
        type: 'loadingFinished',
        event: {
          requestId: ev.requestId,
          timestamp: ev.timestamp,
          encodedDataLength: ev.encodedDataLength,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    };

    const onLoadingFailed: CdpHandlers['onLoadingFailed'] = (ev) => {
      this.collected.networkEvents.push({
        type: 'loadingFailed',
        event: {
          requestId: ev.requestId,
          timestamp: ev.timestamp,
          canceled: ev.canceled ?? false,
          errorText: ev.errorText,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    };

    cdp.on('Console.messageAdded', onConsoleMessage);
    cdp.on('Network.requestWillBeSent', onRequestWillBeSent);
    cdp.on('Network.responseReceived', onResponseReceived);
    cdp.on('Network.loadingFinished', onLoadingFinished);
    cdp.on('Network.loadingFailed', onLoadingFailed);

    this.cdpHandlers = {
      onConsoleMessage,
      onRequestWillBeSent,
      onResponseReceived,
      onLoadingFinished,
      onLoadingFailed,
    };

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.collected.navigationEvents.push({
          url: frame.url(),
          timestamp: Date.now(),
        });
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    return new CdpTabScopeImpl(page, cdp);
  }

  setActionWindowId(id: string): void {
    this.collected.currentActionWindowId = id;
  }

  async drain(): Promise<DrainResult> {
    if (this.page === null || this.cdp === null) return makeEmptyDrain();

    // Collect web vitals from page
    let webVitals: WebVitalSample[] = [];
    let renderEvents: RenderEvent[] = [];
    let longTasks: LongTaskSample[] = [];

    try {
      const vitalsRaw = await this.page.evaluate('window.__bughunter_vitals__ || []');
      if (Array.isArray(vitalsRaw)) {
        webVitals = vitalsRaw as WebVitalSample[];
      }
    } catch (err) {
      log.warn('cdp-session: failed to drain web vitals', { err: String(err) });
    }

    try {
      const renderRaw = await this.page.evaluate('window.__bughunter_render_events__ || []');
      if (Array.isArray(renderRaw)) {
        renderEvents = renderRaw as RenderEvent[];
      }
    } catch (err) {
      log.warn('cdp-session: failed to drain render events', { err: String(err) });
    }

    try {
      const longTasksRaw = await this.page.evaluate('window.__bughunter_long_tasks__ || []');
      if (Array.isArray(longTasksRaw)) {
        longTasks = longTasksRaw as LongTaskSample[];
      }
    } catch (err) {
      log.warn('cdp-session: failed to drain long tasks', { err: String(err) });
    }

    const result: DrainResult = {
      webVitals,
      longTasks,
      heap: [],
      networkEvents: [...this.collected.networkEvents],
      renderEvents,
      navigationEvents: [...this.collected.navigationEvents],
      consoleErrors: [...this.collected.consoleErrors],
    };

    // Clear collected data for next action window
    this.collected.networkEvents = [];
    this.collected.navigationEvents = [];
    this.collected.consoleErrors = [];

    return result;
  }

  async takeHeapSnapshot(): Promise<HeapSnapshotRaw> {
    if (this.cdp === null) throw new Error('cdp-session: no active CDP session; call newTab first');
    const chunks: string[] = [];

    const onChunk = (ev: { chunk: string }) => { chunks.push(ev.chunk); };

    this.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await this.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    // Allow in-flight chunk events to arrive before detaching.
    await new Promise<void>(resolve => { setTimeout(resolve, 100); });
    this.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);

    return { capturedAtMs: Date.now(), json: chunks.join('') };
  }

  async collectGarbage(): Promise<void> {
    if (this.cdp === null) throw new Error('cdp-session: no active CDP session; call newTab first');
    await this.cdp.send('HeapProfiler.collectGarbage');
    await new Promise<void>(resolve => { setTimeout(resolve, 500); });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachCdpHandlers();
    try {
      await this.page?.close();
      await this.context.close();
      await this.browser.close();
    } catch (err) {
      log.warn('cdp-session: error during close', { err: String(err) });
    }
  }
}

export type CreateCdpSessionOptions = {
  cookieJar?: Cookie[];
};

export type CreateCdpSessionResult =
  | { ok: true; session: CdpSession & { setActionWindowId(id: string): void } }
  | { ok: false; reason: string };

export async function createCdpSession(opts: CreateCdpSessionOptions = {}): Promise<CreateCdpSessionResult> {
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const session = new CdpSessionImpl(browser, context);

    if (opts.cookieJar !== undefined && opts.cookieJar.length > 0) {
      await session.setCookies(opts.cookieJar);
    }

    return { ok: true, session };
  } catch (err) {
    return { ok: false, reason: `Failed to launch CDP browser: ${String(err)}` };
  }
}
