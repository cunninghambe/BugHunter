// Tests for request hygiene classifiers (§4.5–4.7).

import { describe, it, expect } from 'vitest';
import { classifyNPlusOne, classifyDedupMissing, classifyCancelMissing } from './request-hygiene.js';
import type { HarLog, HarEntry } from '../adapters/har-writer.js';
import type { NavigationEvent } from '../adapters/cdp-session.js';

function makeEntry(
  method: string,
  url: string,
  actionWindowId: string,
  startedDateTime: string = new Date().toISOString(),
  status = 200,
  timeMs = 50,
  postDataText?: string,
): HarEntry {
  return {
    startedDateTime,
    time: timeMs,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: postDataText !== undefined ? postDataText.length : 0,
      ...(postDataText !== undefined ? { postData: { mimeType: 'application/json', text: postDataText } } : {}),
    },
    response: {
      status,
      statusText: status === 200 ? 'OK' : '',
      httpVersion: 'HTTP/1.1',
      headers: [],
      cookies: [],
      content: { size: 100, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 100,
    },
    timings: { send: 0, wait: timeMs, receive: 0 },
    _bughunter: { actionWindowId, cdpSessionRole: 'observer', requestId: `req-${Math.random()}` },
  };
}

function makeHar(entries: HarEntry[]): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'bughunter', version: '0.6' },
      entries,
    },
  };
}

// --- N+1 tests (§4.5) ---

describe('classifyNPlusOne', () => {
  it('T1: 12 calls to GET /api/trades/:id in one window → emit', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry('GET', `https://example.com/api/trades/${i + 1}`, 'w1')
    );
    const result = classifyNPlusOne(makeHar(entries));
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('n_plus_one_api_calls');
    expect((result[0].evidence as { count: number }).count).toBe(12);
  });

  it('T2: 5 calls to GET /api/trades/:id in one window → no emit', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry('GET', `https://example.com/api/trades/${i + 1}`, 'w1')
    );
    const result = classifyNPlusOne(makeHar(entries));
    expect(result).toHaveLength(0);
  });

  it('T3: 12 calls to distinct paths → no emit (no single group >= threshold)', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/api/resource-${i}`);
    const entries = urls.map(u => makeEntry('GET', u, 'w1'));
    const result = classifyNPlusOne(makeHar(entries));
    expect(result).toHaveLength(0);
  });

  it('T4: 12 calls split across two windows (6 each) → no emit', () => {
    const e1 = Array.from({ length: 6 }, (_, i) => makeEntry('GET', `https://example.com/api/trades/${i}`, 'w1'));
    const e2 = Array.from({ length: 6 }, (_, i) => makeEntry('GET', `https://example.com/api/trades/${i}`, 'w2'));
    const result = classifyNPlusOne(makeHar([...e1, ...e2]));
    expect(result).toHaveLength(0);
  });

  it('T5: 200 calls to one endpoint family → one finding (not 200)', () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      makeEntry('GET', `https://example.com/api/trades/${i}`, 'w1')
    );
    const result = classifyNPlusOne(makeHar(entries));
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { count: number }).count).toBe(200);
  });

  it('example URLs are capped at 5', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry('GET', `https://example.com/api/trades/${i}`, 'w1')
    );
    const result = classifyNPlusOne(makeHar(entries));
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { exampleUrls: string[] }).exampleUrls).toHaveLength(5);
  });
});

// --- Dedup tests (§4.6) ---

describe('classifyDedupMissing', () => {
  const BASE_TIME = new Date('2024-01-01T00:00:00.000Z').getTime();

  it('T1: Same GET /api/me 3 times within 50ms → emit duplicateCount:3', () => {
    const entries = [
      makeEntry('GET', 'https://example.com/api/me', 'w1', new Date(BASE_TIME).toISOString()),
      makeEntry('GET', 'https://example.com/api/me', 'w1', new Date(BASE_TIME + 20).toISOString()),
      makeEntry('GET', 'https://example.com/api/me', 'w1', new Date(BASE_TIME + 40).toISOString()),
    ];
    const result = classifyDedupMissing(makeHar(entries));
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('request_dedup_missing');
    expect((result[0].evidence as { duplicateCount: number }).duplicateCount).toBe(3);
  });

  it('T2: Same GET /api/me 2 times 500ms apart → no emit', () => {
    const entries = [
      makeEntry('GET', 'https://example.com/api/me', 'w1', new Date(BASE_TIME).toISOString()),
      makeEntry('GET', 'https://example.com/api/me', 'w1', new Date(BASE_TIME + 500).toISOString()),
    ];
    const result = classifyDedupMissing(makeHar(entries));
    expect(result).toHaveLength(0);
  });

  it('T3: POST /api/save with different bodies → no emit', () => {
    const entries = [
      makeEntry('POST', 'https://example.com/api/save', 'w1', new Date(BASE_TIME).toISOString(), 200, 50, '{"name":"a"}'),
      makeEntry('POST', 'https://example.com/api/save', 'w1', new Date(BASE_TIME + 10).toISOString(), 200, 50, '{"name":"b"}'),
    ];
    const result = classifyDedupMissing(makeHar(entries));
    expect(result).toHaveLength(0);
  });
});

// --- Cancellation tests (§4.7) ---

describe('classifyCancelMissing', () => {
  const BASE_TIME = new Date('2024-01-01T00:00:00.000Z').getTime();

  it('emits when a request in-flight during navigation completes after nav', () => {
    const navEvents: NavigationEvent[] = [
      { url: 'http://localhost/', timestamp: BASE_TIME },
      { url: 'http://localhost/next', timestamp: BASE_TIME + 200 },
    ];
    // Request starts at BASE_TIME + 100 (between navs), lasts 200ms (ends at BASE_TIME + 300 > nav)
    const entries = [
      makeEntry('GET', 'http://localhost/api/data', 'w1', new Date(BASE_TIME + 100).toISOString(), 200, 200),
    ];
    const result = classifyCancelMissing(makeHar(entries), navEvents);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('request_cancellation_missing');
    expect((result[0].evidence as { navigatedToUrl: string }).navigatedToUrl).toBe('http://localhost/next');
  });

  it('no emit when request completes before navigation', () => {
    const navEvents: NavigationEvent[] = [
      { url: 'http://localhost/', timestamp: BASE_TIME },
      { url: 'http://localhost/next', timestamp: BASE_TIME + 500 },
    ];
    // Request starts at BASE_TIME + 100, lasts 50ms → completes at BASE_TIME + 150 (before nav at +500)
    const entries = [
      makeEntry('GET', 'http://localhost/api/data', 'w1', new Date(BASE_TIME + 100).toISOString(), 200, 50),
    ];
    const result = classifyCancelMissing(makeHar(entries), navEvents);
    expect(result).toHaveLength(0);
  });

  it('no emit when fewer than 2 navigation events', () => {
    const navEvents: NavigationEvent[] = [{ url: 'http://localhost/', timestamp: BASE_TIME }];
    const entries = [makeEntry('GET', 'http://localhost/api/data', 'w1')];
    const result = classifyCancelMissing(makeHar(entries), navEvents);
    expect(result).toHaveLength(0);
  });
});
