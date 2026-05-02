import { describe, it, expect } from 'vitest';
import { CLOCK_CONDITIONS, defaultConditionsForReasons, getClockCondition } from './clock-conditions.js';
import type { ClockConditionName } from './clock-conditions.js';

describe('CLOCK_CONDITIONS palette', () => {
  it('has exactly 7 conditions', () => {
    expect(CLOCK_CONDITIONS).toHaveLength(7);
  });

  it('all named conditions are unique', () => {
    const names = CLOCK_CONDITIONS.map(c => c.name);
    expect(new Set(names).size).toBe(7);
  });

  it('dst_forward produces correct unix-ms (2026-03-08T06:30:00Z)', () => {
    const c = getClockCondition('dst_forward');
    expect(c.injectedNowMs).toBe(Date.UTC(2026, 2, 8, 6, 30, 0));
    expect(c.injectedTimezone).toBe('America/New_York');
  });

  it('dst_backward produces correct unix-ms (2026-11-01T05:30:00Z)', () => {
    const c = getClockCondition('dst_backward');
    expect(c.injectedNowMs).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    expect(c.injectedTimezone).toBe('America/New_York');
  });

  it('leap_day is on 2024-02-29 at midday UTC', () => {
    const c = getClockCondition('leap_day');
    expect(c.injectedNowMs).toBe(Date.UTC(2024, 1, 29, 12, 0, 0));
    const d = new Date(c.injectedNowMs!);
    expect(d.getUTCMonth()).toBe(1); // February
    expect(d.getUTCDate()).toBe(29);
  });

  it('y2038_edge is 1 minute before int32 overflow', () => {
    const c = getClockCondition('y2038_edge');
    // 2038-01-19T03:14:07Z is the overflow; -60s = 03:13:07Z
    const overflow = Date.UTC(2038, 0, 19, 3, 14, 7);
    expect(c.injectedNowMs).toBe(overflow - 60_000);
  });

  it('far_future is 2099-01-01 (not a leap year)', () => {
    const c = getClockCondition('far_future');
    const d = new Date(c.injectedNowMs!);
    expect(d.getUTCFullYear()).toBe(2099);
    // Confirm 2099 is not a leap year
    const leapCheck = new Date(Date.UTC(2099, 1, 29)); // If leap, day=29; else day wraps to March 1
    expect(leapCheck.getUTCDate()).not.toBe(29);
  });

  it('client_skew_plus_1h has no injectedNowMs (computed at runtime)', () => {
    const c = getClockCondition('client_skew_plus_1h');
    expect(c.injectedNowMs).toBeUndefined();
    expect(c.injectedTimezone).toBeUndefined();
  });

  it('tz_skew_negative_8h overrides TZ to America/Los_Angeles', () => {
    const c = getClockCondition('tz_skew_negative_8h');
    expect(c.injectedTimezone).toBe('America/Los_Angeles');
    expect(c.injectedNowMs).toBeUndefined();
  });

  it('getClockCondition throws for unknown name', () => {
    expect(() => getClockCondition('not_a_condition' as ClockConditionName)).toThrow();
  });
});

describe('defaultConditionsForReasons', () => {
  it('form_field_date → dst_forward, dst_backward, leap_day, far_future', () => {
    const result = defaultConditionsForReasons(['form_field_date']);
    expect(result).toContain('dst_forward');
    expect(result).toContain('dst_backward');
    expect(result).toContain('leap_day');
    expect(result).toContain('far_future');
    expect(result).not.toContain('client_skew_plus_1h');
    expect(result).not.toContain('tz_skew_negative_8h');
  });

  it('schema_format_date → same 4 conditions as form_field_date', () => {
    const result = defaultConditionsForReasons(['schema_format_date']);
    expect(result).toContain('dst_forward');
    expect(result).toContain('far_future');
    expect(result.length).toBeGreaterThanOrEqual(4);
  });

  it('schema_property_name_pattern → 4 conditions', () => {
    const result = defaultConditionsForReasons(['schema_property_name_pattern']);
    expect(result).toContain('leap_day');
    expect(result).toContain('dst_backward');
  });

  it('form_field_name_pattern → 4 conditions', () => {
    const result = defaultConditionsForReasons(['form_field_name_pattern']);
    expect(result).toContain('dst_forward');
  });

  it('dom_relative_time → tz_skew_negative_8h and client_skew_plus_1h', () => {
    const result = defaultConditionsForReasons(['dom_relative_time']);
    expect(result).toContain('tz_skew_negative_8h');
    expect(result).toContain('client_skew_plus_1h');
    expect(result).not.toContain('leap_day');
    expect(result).not.toContain('y2038_edge');
  });

  it('config_allowlist → all 7 conditions', () => {
    const result = defaultConditionsForReasons(['config_allowlist']);
    expect(result).toHaveLength(7);
  });

  it('deduplicates when multiple reasons overlap', () => {
    const result = defaultConditionsForReasons(['form_field_date', 'schema_format_date']);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
    // Both map to same 4; no duplicates
    expect(result.length).toBe(4);
  });

  it('empty reasons → no conditions', () => {
    expect(defaultConditionsForReasons([])).toHaveLength(0);
  });
});
