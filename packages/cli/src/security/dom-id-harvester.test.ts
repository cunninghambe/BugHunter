// Tests for dom-id-harvester (v0.5 Gap 2).

import { describe, it, expect } from 'vitest';
import { harvestIdsFromDom } from './dom-id-harvester.js';

describe('harvestIdsFromDom — link harvesting', () => {
  it('extracts route IDs from hrefs', () => {
    const ids = harvestIdsFromDom('', ['/trades/abc-123', '/users/42ab/edit']);
    expect(ids.some(r => r.value === 'abc-123')).toBe(true);
    expect(ids.some(r => r.value === '42ab')).toBe(true);
  });

  it('skips /static/ and similar reserved segments', () => {
    const ids = harvestIdsFromDom('', ['/static/x.png', '/assets/logo.svg', '/api/list']);
    expect(ids).toHaveLength(0);
  });

  it('handles absolute URLs', () => {
    const ids = harvestIdsFromDom('', ['http://localhost:8787/trades/abc-123']);
    expect(ids.some(r => r.value === 'abc-123')).toBe(true);
  });

  it('returns empty for links with no id-shaped segments', () => {
    const ids = harvestIdsFromDom('', ['/trades', '/', '/users/new']);
    expect(ids).toHaveLength(0);
  });
});

describe('harvestIdsFromDom — data-* attribute harvesting', () => {
  it('extracts data-id and data-uuid attributes', () => {
    const snapshot = '<div data-id="trade-1" data-uuid="u-1">content</div>';
    const ids = harvestIdsFromDom(snapshot, []);
    expect(ids.some(r => r.field === 'id' && r.value === 'trade-1')).toBe(true);
    expect(ids.some(r => r.field === 'uuid' && r.value === 'u-1')).toBe(true);
  });

  it('extracts data-trade-id attribute', () => {
    const snapshot = '<div data-trade-id="t-1">content</div>';
    const ids = harvestIdsFromDom(snapshot, []);
    expect(ids.some(r => r.value === 't-1')).toBe(true);
  });

  it('does NOT harvest data-testid', () => {
    const snapshot = '<button data-testid="submit-btn">Submit</button>';
    const ids = harvestIdsFromDom(snapshot, []);
    expect(ids).toHaveLength(0);
  });

  it('does NOT harvest data-dismiss or data-toggle', () => {
    const snapshot = '<div data-dismiss="modal" data-toggle="dropdown">x</div>';
    const ids = harvestIdsFromDom(snapshot, []);
    expect(ids).toHaveLength(0);
  });
});

describe('harvestIdsFromDom — error resilience', () => {
  it('returns [] on malformed snapshot without throwing', () => {
    // Passing garbage that could trip a real parser
    expect(() => harvestIdsFromDom('<<<<>>>>>&&&&', [])).not.toThrow();
    expect(harvestIdsFromDom('<<<<>>>>>&&&&', [])).toEqual([]);
  });

  it('returns [] on empty inputs', () => {
    expect(harvestIdsFromDom('', [])).toEqual([]);
  });
});

describe('harvestIdsFromDom — performance', () => {
  it('completes within 5ms on a 50KB snapshot', () => {
    // Build a ~50KB snapshot with repeated elements
    const element = '<div data-id="trade-abc-123" data-testid="item">Item content goes here for padding</div>\n';
    const snapshot = element.repeat(Math.ceil(50 * 1024 / element.length));

    const start = Date.now();
    harvestIdsFromDom(snapshot, []);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5);
  });
});
