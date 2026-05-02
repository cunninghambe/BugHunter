import { describe, it, expect } from 'vitest';
import {
  RELATIVE_TIME_PATTERN,
  RELATIVE_TIME_HARVEST_SCRIPT,
  parseRelativeTimeElements,
} from './relative-time-elements.js';

describe('RELATIVE_TIME_PATTERN', () => {
  it('matches "just now"', () => {
    expect(RELATIVE_TIME_PATTERN.test('just now')).toBe(true);
  });

  it('matches "5 minutes ago"', () => {
    expect(RELATIVE_TIME_PATTERN.test('5 minutes ago')).toBe(true);
  });

  it('matches "1 second ago"', () => {
    expect(RELATIVE_TIME_PATTERN.test('1 second ago')).toBe(true);
  });

  it('matches "in 3 days"', () => {
    expect(RELATIVE_TIME_PATTERN.test('in 3 days')).toBe(true);
  });

  it('matches "2 hours ago"', () => {
    expect(RELATIVE_TIME_PATTERN.test('2 hours ago')).toBe(true);
  });

  it('does not match absolute date strings', () => {
    expect(RELATIVE_TIME_PATTERN.test('2024-02-29')).toBe(false);
    expect(RELATIVE_TIME_PATTERN.test('March 1, 2024')).toBe(false);
  });

  it('does not match arbitrary numbers', () => {
    expect(RELATIVE_TIME_PATTERN.test('You have 5 items in your cart')).toBe(false);
  });
});

describe('RELATIVE_TIME_HARVEST_SCRIPT', () => {
  it('is a non-empty string', () => {
    expect(typeof RELATIVE_TIME_HARVEST_SCRIPT).toBe('string');
    expect(RELATIVE_TIME_HARVEST_SCRIPT.length).toBeGreaterThan(50);
  });

  it('references the MAX cap (50)', () => {
    expect(RELATIVE_TIME_HARVEST_SCRIPT).toContain('50');
  });
});

describe('parseRelativeTimeElements', () => {
  it('returns empty array for null', () => {
    expect(parseRelativeTimeElements(null)).toEqual([]);
  });

  it('returns empty array for non-array', () => {
    expect(parseRelativeTimeElements('string')).toEqual([]);
    expect(parseRelativeTimeElements(42)).toEqual([]);
  });

  it('parses valid array correctly', () => {
    const raw = [
      { selector: 'time#ts1', text: '5 minutes ago' },
      { selector: 'span', text: 'just now' },
    ];
    const result = parseRelativeTimeElements(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ selector: 'time#ts1', text: '5 minutes ago' });
  });

  it('filters out malformed items', () => {
    const raw = [
      { selector: 'span', text: 'just now' },
      null,
      'string',
      { selector: 'time' }, // missing text
    ];
    const result = parseRelativeTimeElements(raw);
    // Only the first item has both selector and text; third item lacks text
    expect(result.some(r => r.selector === 'span')).toBe(true);
  });

  it('caps at 50 elements', () => {
    const raw = Array.from({ length: 100 }, (_, i) => ({ selector: `span${i}`, text: 'just now' }));
    const result = parseRelativeTimeElements(raw);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
