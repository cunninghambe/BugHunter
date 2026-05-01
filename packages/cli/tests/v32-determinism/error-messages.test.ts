// §6.7 Help text + error messages: bad inputs produce the specified error strings.
//
// Spec requirements:
//   --seed abc (non-numeric): "Error: --seed must be a 32-bit non-negative integer; got 'abc'"
//   --frozen-clock 2026-13-99 (invalid): "Error: --frozen-clock: invalid ISO 8601: '2026-13-99'"
//   --frozen-network missing.har: "Error: --frozen-network: file not found: missing.har"
//   --seed 1234 --resume <runId>: "Error: --seed cannot be combined with --resume"

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { parseSeed } from '../../src/lib/rng.js';
import { makeClock } from '../../src/lib/clock.js';
import { loadHar, makeHarReplayer } from '../../src/adapters/har-replay.js';
import { resetIdFactory } from '../../src/lib/ids.js';
import { runCommand } from '../../src/cli/run.js';
import type { HarLog } from '../../src/adapters/har-writer.js';

afterEach(() => resetIdFactory());

describe('error messages: --seed flag', () => {
  it('rejects non-numeric input with specified message', () => {
    expect(() => parseSeed('abc'))
      .toThrow("--seed must be a 32-bit non-negative integer; got 'abc'");
  });

  it('rejects float with specified message', () => {
    expect(() => parseSeed('1.5'))
      .toThrow("--seed must be a 32-bit non-negative integer; got '1.5'");
  });

  it('rejects negative integer', () => {
    expect(() => parseSeed('-1'))
      .toThrow("--seed must be a 32-bit non-negative integer; got '-1'");
  });

  it('rejects overflow (> 0xFFFFFFFF)', () => {
    expect(() => parseSeed('4294967296'))
      .toThrow("--seed must be a 32-bit non-negative integer; got '4294967296'");
  });

  it('accepts zero (EC-10)', () => {
    expect(parseSeed('0')).toBe(0);
  });

  it('accepts max 32-bit unsigned integer (EC-11)', () => {
    expect(parseSeed('4294967295')).toBe(0xFFFFFFFF);
  });

  it('accepts a typical seed', () => {
    expect(parseSeed('1234')).toBe(1234);
  });
});

describe('error messages: --frozen-clock flag', () => {
  it('rejects 2026-13-99 with specified message', () => {
    expect(() => makeClock({ frozenClock: '2026-13-99' }))
      .toThrow("--frozen-clock: invalid ISO 8601: '2026-13-99'");
  });

  it('rejects non-date string', () => {
    expect(() => makeClock({ frozenClock: 'not-a-date' }))
      .toThrow("--frozen-clock: invalid ISO 8601: 'not-a-date'");
  });

  it('rejects empty string', () => {
    expect(() => makeClock({ frozenClock: '' }))
      .toThrow("--frozen-clock: invalid ISO 8601: ''");
  });

  it('accepts valid ISO 8601 with Z suffix', () => {
    expect(() => makeClock({ frozenClock: '2026-05-01T12:00:00.000Z' })).not.toThrow();
  });

  it('accepts valid ISO 8601 without milliseconds', () => {
    // Date.parse accepts many valid ISO 8601 forms
    expect(() => makeClock({ frozenClock: '2026-05-01T12:00:00Z' })).not.toThrow();
  });
});

describe('error messages: --frozen-network flag', () => {
  it('rejects a missing HAR file with specified message', () => {
    expect(() => loadHar('/nonexistent/path/missing.har'))
      .toThrow('--frozen-network: file not found: /nonexistent/path/missing.har');
  });

  it('rejects a corrupted HAR file with JSON parse error message', () => {
    const tmpPath = '/tmp/bh-test-invalid.har';
    fs.writeFileSync(tmpPath, 'not-valid-json');
    try {
      expect(() => loadHar(tmpPath))
        .toThrow('--frozen-network: HAR file is not valid JSON:');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

describe('error messages: --seed + --resume mutex (EC-13)', () => {
  it('runCommand rejects --seed combined with --resume', async () => {
    await expect(
      runCommand({ projectDir: '/tmp/proj', seed: 1234, resume: 'some-run-id' })
    ).rejects.toThrow('--seed cannot be combined with --resume');
  });
});

describe('error messages: HAR replay match/miss', () => {
  const emptyHar: HarLog = {
    log: {
      version: '1.2',
      creator: { name: 'test', version: '1' },
      entries: [],
    },
  };

  it('makeHarReplayer returns undefined on miss', () => {
    const replayer = makeHarReplayer(emptyHar, { stripQueryParams: [] });
    const result = replayer.match({ method: 'GET', url: 'https://example.com/api/test' });
    expect(result).toBeUndefined();
    expect(replayer.telemetry().missed).toBe(1);
    expect(replayer.telemetry().matched).toBe(0);
  });

  it('makeHarReplayer matches by method + url', () => {
    const har: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'test', version: '1' },
        entries: [
          {
            startedDateTime: '2026-05-01T12:00:00.000Z',
            time: 10,
            request: {
              method: 'GET',
              url: 'https://example.com/api/test',
              headers: [],
              queryString: [],
              cookies: [],
              headersSize: 0,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              headers: [],
              cookies: [],
              content: { size: 13, mimeType: 'application/json', text: '{"ok":true}' },
              redirectURL: '',
              headersSize: 0,
              bodySize: 13,
            },
            cache: {},
            timings: { send: 0, wait: 10, receive: 0 },
          },
        ],
      },
    };
    const replayer = makeHarReplayer(har, { stripQueryParams: [] });
    const result = replayer.match({ method: 'GET', url: 'https://example.com/api/test' });
    expect(result).toBeDefined();
    expect(result?.response.status).toBe(200);
    expect(replayer.telemetry().matched).toBe(1);
    expect(replayer.telemetry().missed).toBe(0);
    expect(replayer.telemetry().unmatchedRecorded).toBe(0);
  });

  it('unmatched() returns entries not yet consumed', () => {
    const har: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'test', version: '1' },
        entries: [
          {
            startedDateTime: '2026-05-01T12:00:00.000Z',
            time: 10,
            request: {
              method: 'GET',
              url: 'https://example.com/api/unused',
              headers: [],
              queryString: [],
              cookies: [],
              headersSize: 0,
              bodySize: 0,
            },
            response: {
              status: 200,
              statusText: 'OK',
              headers: [],
              cookies: [],
              content: { size: 0, mimeType: 'text/plain', text: '' },
              redirectURL: '',
              headersSize: 0,
              bodySize: 0,
            },
            cache: {},
            timings: { send: 0, wait: 5, receive: 0 },
          },
        ],
      },
    };
    const replayer = makeHarReplayer(har, { stripQueryParams: [] });
    // Make a miss (wrong URL) so the entry stays unmatched
    replayer.match({ method: 'GET', url: 'https://example.com/api/different' });
    expect(replayer.unmatched().length).toBe(1);
    expect(replayer.telemetry().unmatchedRecorded).toBe(1);
  });
});
