// Tests for HarWriter — fixture-driven.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventsToHar } from './har-writer.js';
import type { NetworkEvent } from './cdp-session.js';

const FIXTURE_PATH = join(import.meta.dirname, '../../../../tests/fixtures/cdp-network-events.json');

function loadFixture(): NetworkEvent[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as NetworkEvent[];
}

describe('eventsToHar', () => {
  it('produces a valid HAR 1.2 log from the fixture', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('bughunter');
  });

  it('fixture produces 5 entries (one per unique requestId)', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    expect(har.log.entries).toHaveLength(5);
  });

  it('each entry has _bughunter namespace with cdpSessionRole: observer', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    for (const entry of har.log.entries) {
      expect(entry._bughunter.cdpSessionRole).toBe('observer');
      expect(typeof entry._bughunter.actionWindowId).toBe('string');
      expect(typeof entry._bughunter.requestId).toBe('string');
    }
  });

  it('first entry is a GET to /api/trades with status 200', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    const entry = har.log.entries.find(e => e.request.url === 'https://example.com/api/trades');
    expect(entry).toBeDefined();
    expect(entry!.request.method).toBe('GET');
    expect(entry!.response.status).toBe(200);
    expect(entry!.response.content.size).toBe(1234);
  });

  it('POST entry includes postData', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    const entry = har.log.entries.find(e => e.request.url === 'https://example.com/api/save');
    expect(entry).toBeDefined();
    expect(entry!.request.method).toBe('POST');
    expect(entry!.request.postData?.text).toBe('{"name":"test"}');
  });

  it('cancelled request (loadingFailed) still appears as entry with status 0', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    const entry = har.log.entries.find(e => e.request.url === 'https://example.com/api/user');
    expect(entry).toBeDefined();
    expect(entry!.response.status).toBe(0);
  });

  it('query string is parsed from URL', () => {
    const events: NetworkEvent[] = [
      {
        type: 'requestWillBeSent',
        actionWindowId: 'w1',
        event: {
          requestId: 'r1',
          url: 'https://example.com/api/search?q=hello&page=1',
          method: 'GET',
          headers: {},
          timestamp: 1.0,
          type: 'XHR',
        },
      },
    ];
    const har = eventsToHar(events);
    const qs = har.log.entries[0].request.queryString;
    expect(qs).toContainEqual({ name: 'q', value: 'hello' });
    expect(qs).toContainEqual({ name: 'page', value: '1' });
  });

  it('actionWindowId is preserved per entry', () => {
    const events = loadFixture();
    const har = eventsToHar(events);
    const action1Entries = har.log.entries.filter(e => e._bughunter.actionWindowId === 'action-1');
    const action2Entries = har.log.entries.filter(e => e._bughunter.actionWindowId === 'action-2');
    const action3Entries = har.log.entries.filter(e => e._bughunter.actionWindowId === 'action-3');
    expect(action1Entries).toHaveLength(2);
    expect(action2Entries).toHaveLength(2);
    expect(action3Entries).toHaveLength(1);
  });

  it('returns empty entries array for empty input', () => {
    const har = eventsToHar([]);
    expect(har.log.entries).toHaveLength(0);
  });
});
