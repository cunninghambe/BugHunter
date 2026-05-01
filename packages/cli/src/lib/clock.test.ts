import { describe, it, expect } from 'vitest';
import { makeClock, nowIso, nowMs } from './clock.js';

describe('makeClock', () => {
  it('returns wall clock when frozenClock is undefined', () => {
    const c = makeClock({ frozenClock: undefined });
    expect(c.kind).toBe('wall');
  });

  it('returns frozen clock for valid ISO 8601 string', () => {
    const c = makeClock({ frozenClock: '2026-05-01T12:00:00.000Z' });
    expect(c.kind).toBe('frozen');
    if (c.kind === 'frozen') {
      expect(c.isoTime).toBe('2026-05-01T12:00:00.000Z');
      expect(c.ms).toBe(Date.parse('2026-05-01T12:00:00.000Z'));
    }
  });

  it('throws for invalid ISO 8601', () => {
    expect(() => makeClock({ frozenClock: '2026-13-99' }))
      .toThrow("--frozen-clock: invalid ISO 8601: '2026-13-99'");
  });

  it('throws for non-date string', () => {
    expect(() => makeClock({ frozenClock: 'not-a-date' }))
      .toThrow("--frozen-clock: invalid ISO 8601: 'not-a-date'");
  });
});

describe('nowIso', () => {
  it('returns frozen isoTime when clock is frozen', () => {
    const c = makeClock({ frozenClock: '2026-05-01T12:00:00.000Z' });
    // Call multiple times — must be identical (strictly constant)
    expect(nowIso(c)).toBe('2026-05-01T12:00:00.000Z');
    expect(nowIso(c)).toBe('2026-05-01T12:00:00.000Z');
  });

  it('returns a live ISO string when clock is wall', () => {
    const before = Date.now();
    const result = nowIso({ kind: 'wall' });
    const after = Date.now();
    const parsed = Date.parse(result);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('nowMs', () => {
  it('returns frozen ms when clock is frozen', () => {
    const frozen = Date.parse('2026-05-01T12:00:00.000Z');
    const c = makeClock({ frozenClock: '2026-05-01T12:00:00.000Z' });
    expect(nowMs(c)).toBe(frozen);
    expect(nowMs(c)).toBe(frozen);
  });

  it('returns a live ms when clock is wall', () => {
    const before = Date.now();
    const result = nowMs({ kind: 'wall' });
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});
