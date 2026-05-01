// HarWriter — converts CDP Network.* events to HAR 1.2 format.
// Pure function; no playwright-core dependency.

import type { NetworkEvent, NetworkRequestEvent, NetworkResponseEvent } from './cdp-session.js';
import type { NetworkRequest } from '../types.js';

export type HarEntry = {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: unknown[];
    content: { size: number; mimeType: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
  _bughunter: {
    actionWindowId: string;
    cdpSessionRole: 'observer';
    requestId: string;
  };
};

export type HarLog = {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
};

type RequestState = {
  request: NetworkRequestEvent;
  actionWindowId: string;
  response?: NetworkResponseEvent;
  encodedDataLength?: number;
  failed?: boolean;
};

function headersToArray(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function cdpTimestampToMs(ts: number): number {
  // CDP timestamps are in seconds since epoch
  return ts * 1000;
}

/**
 * Convert HAR entries into the NetworkRequest shape consumed by classifiers.
 * Used by the UI execute path to feed classifyNetworkRequests / classifyMissingStateChange
 * with real HAR-captured data instead of an empty array (audit-found defect).
 */
export function harEntriesToNetworkRequests(entries: HarEntry[]): NetworkRequest[] {
  const out: NetworkRequest[] = [];
  for (const e of entries) {
    let path: string;
    try {
      const u = new URL(e.request.url);
      path = u.pathname + u.search;
    } catch {
      path = e.request.url;
    }
    out.push({
      method: e.request.method,
      path,
      status: e.response.status,
      duration: e.time,
    });
  }
  return out;
}

// --- V25: CsrfObservation projection ---

/** A single mutating HTTP request as captured by the HAR pipeline. */
export type CsrfObservation = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  requestHeaders: Record<string, string>;
  cookieJar: string[];
  responseSetCookieHeaders: string[];
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Project HAR entries into CsrfObservation structs for the CSRF detector.
 * Filters to mutating methods only. Lowercases all request header keys.
 * Skips entries where `request.headers` is missing (logs at debug level).
 */
export function harEntriesToCsrfObservations(entries: HarEntry[]): CsrfObservation[] {
  const observations: CsrfObservation[] = [];

  for (const entry of entries) {
    const method = entry.request.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;

    let requestHeaders: Record<string, string>;
    try {
      requestHeaders = Object.fromEntries(
        entry.request.headers.map(({ name, value }) => [name.toLowerCase(), value])
      );
    } catch (err) {
      // Log at debug level per spec § 3.1.3 EC-CSRF-8
      // eslint-disable-next-line no-console
      console.debug('[csrf-detector] har-entry: malformed request.headers; skipping', String(err));
      continue;
    }

    const cookieHeader = requestHeaders['cookie'] ?? '';
    const cookieJar = cookieHeader.length > 0
      ? cookieHeader.split('; ').map(c => c.trim()).filter(c => c.length > 0)
      : [];

    const responseSetCookieHeaders = entry.response.headers
      .filter(h => h.name.toLowerCase() === 'set-cookie')
      .map(h => h.value);

    observations.push({
      method: method as CsrfObservation['method'],
      url: entry.request.url,
      requestHeaders,
      cookieJar,
      responseSetCookieHeaders,
    });
  }

  return observations;

/** Convert a set of CDP Network.* events into a HAR 1.2 log. */
export function eventsToHar(events: NetworkEvent[], creatorVersion = '0.6'): HarLog {
  const requests = new Map<string, RequestState>();

  for (const ev of events) {
    if (ev.type === 'requestWillBeSent') {
      requests.set(ev.event.requestId, {
        request: ev.event,
        actionWindowId: ev.actionWindowId,
      });
    } else if (ev.type === 'responseReceived') {
      const state = requests.get(ev.event.requestId);
      if (state !== undefined) {
        state.response = ev.event;
      }
    } else if (ev.type === 'loadingFinished') {
      const state = requests.get(ev.event.requestId);
      if (state !== undefined) {
        state.encodedDataLength = ev.event.encodedDataLength;
      }
    } else {
      const state = requests.get(ev.event.requestId);
      if (state !== undefined) {
        state.failed = true;
      }
    }
  }

  const entries: HarEntry[] = [];

  for (const [, state] of requests) {
    const { request, response, actionWindowId, encodedDataLength } = state;

    const startMs = cdpTimestampToMs(request.timestamp);
    const startedDateTime = new Date(startMs).toISOString();

    const waitMs = response?.timing != null
      ? Math.max(0, response.timing.receiveHeadersEnd - response.timing.sendEnd)
      : 0;

    const totalMs = response?.timing != null
      ? Math.max(0, response.timing.receiveHeadersEnd)
      : 0;

    const entry: HarEntry = {
      startedDateTime,
      time: totalMs,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: 'HTTP/1.1',
        headers: headersToArray(request.headers),
        queryString: parseQueryString(request.url),
        cookies: [],
        headersSize: -1,
        bodySize: request.postData !== undefined ? request.postData.length : 0,
        ...(request.postData !== undefined ? {
          postData: {
            mimeType: request.headers['content-type'] ?? 'application/octet-stream',
            text: request.postData,
          },
        } : {}),
      },
      response: {
        status: response?.status ?? 0,
        statusText: response?.statusText ?? '',
        httpVersion: 'HTTP/1.1',
        headers: response !== undefined ? headersToArray(response.headers) : [],
        cookies: [],
        content: {
          size: encodedDataLength ?? -1,
          mimeType: response?.mimeType ?? 'application/octet-stream',
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: encodedDataLength ?? -1,
      },
      timings: {
        send: 0,
        wait: waitMs,
        receive: 0,
      },
      _bughunter: {
        actionWindowId,
        cdpSessionRole: 'observer',
        requestId: request.requestId,
      },
    };

    entries.push(entry);
  }

  return {
    log: {
      version: '1.2',
      creator: { name: 'bughunter', version: creatorVersion },
      entries,
    },
  };
}
