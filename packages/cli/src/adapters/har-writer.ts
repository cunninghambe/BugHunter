// HarWriter — converts CDP Network.* events to HAR 1.2 format.
// Pure function; no playwright-core dependency.

import type { NetworkEvent, NetworkRequestEvent, NetworkResponseEvent } from './cdp-session.js';

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
    } else if (ev.type === 'loadingFailed') {
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

    const waitMs = response?.timing
      ? Math.max(0, response.timing.receiveHeadersEnd - response.timing.sendEnd)
      : 0;

    const totalMs = response?.timing
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
