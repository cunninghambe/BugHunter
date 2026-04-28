// CDP session adapter — sole import point for playwright-core.
// Creates a parallel Playwright Chromium instance for performance observation.
// The existing camofox adapter (browser-mcp.ts) is NOT modified.

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, CDPSession as PlaywrightCdpSession, Cookie } from 'playwright-core';
import type { WebVitalSample, LongTaskSample, HeapSample, RenderEvent } from '../types.js';
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
}

type CollectedData = {
  networkEvents: NetworkEvent[];
  navigationEvents: NavigationEvent[];
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

class CdpSessionImpl implements CdpSession {
  private readonly collected: CollectedData = {
    networkEvents: [],
    navigationEvents: [],
    currentActionWindowId: 'init',
  };

  private page: Page | null = null;
  private cdp: PlaywrightCdpSession | null = null;
  private closed = false;

  constructor(private readonly browser: Browser, private readonly context: BrowserContext) {}

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
    }
  }

  async newTab(url: string): Promise<CdpTabScope> {
    if (this.page !== null) {
      await this.page.close().catch(() => undefined);
    }
    const page = await this.context.newPage();
    this.page = page;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;

    await cdp.send('Network.enable', {});
    await cdp.send('Performance.enable', {});

    cdp.on('Network.requestWillBeSent', (ev) => {
      this.collected.networkEvents.push({
        type: 'requestWillBeSent',
        event: {
          requestId: ev.requestId,
          url: ev.request.url,
          method: ev.request.method,
          headers: ev.request.headers as Record<string, string>,
          timestamp: ev.timestamp,
          type: ev.type ?? 'Other',
          initiator: ev.initiator ? { type: ev.initiator.type } : undefined,
          postData: ev.request.postData ?? undefined,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    });

    cdp.on('Network.responseReceived', (ev) => {
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
          timing: ev.response.timing ? {
            requestTime: ev.response.timing.requestTime,
            sendStart: ev.response.timing.sendStart,
            sendEnd: ev.response.timing.sendEnd,
            receiveHeadersEnd: ev.response.timing.receiveHeadersEnd,
          } : undefined,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    });

    cdp.on('Network.loadingFinished', (ev) => {
      this.collected.networkEvents.push({
        type: 'loadingFinished',
        event: {
          requestId: ev.requestId,
          timestamp: ev.timestamp,
          encodedDataLength: ev.encodedDataLength,
        },
        actionWindowId: this.collected.currentActionWindowId,
      });
    });

    cdp.on('Network.loadingFailed', (ev) => {
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
    });

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
    };

    // Clear collected data for next action window
    this.collected.networkEvents = [];
    this.collected.navigationEvents = [];

    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
