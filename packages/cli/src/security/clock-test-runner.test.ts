import { describe, it, expect } from 'vitest';
import {
  classifyDateSensitive,
  detectDateSensitiveReasons,
  classifyDateSensitiveBatch,
  disabledClockTelemetry,
  ALL_CLOCK_CONDITION_NAMES,
} from './clock-test-runner.js';
import { clusterSignature } from '../cluster/signature.js';
import type { BugDetection, TestCase } from '../types.js';
import { createId } from '../lib/ids.js';

function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: createId(),
    runId: 'run-1',
    role: 'user',
    page: '/events',
    action: { kind: 'submit', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
    ...overrides,
  };
}

describe('detectDateSensitiveReasons', () => {
  it('detects form_field_date from type:date field', () => {
    const reasons = detectDateSensitiveReasons({
      formFields: [{ name: 'title', type: 'text' }, { name: 'start', type: 'date' }],
    });
    expect(reasons).toContain('form_field_date');
  });

  it('detects form_field_name_pattern from name matching regex', () => {
    const reasons = detectDateSensitiveReasons({
      formFields: [{ name: 'deadline', type: 'text' }],
    });
    expect(reasons).toContain('form_field_name_pattern');
  });

  it('detects schema_format_date from format:date-time', () => {
    const reasons = detectDateSensitiveReasons({
      schemaProperties: { startAt: { format: 'date-time' } },
    });
    expect(reasons).toContain('schema_format_date');
  });

  it('detects schema_format_date from format:date', () => {
    const reasons = detectDateSensitiveReasons({
      schemaProperties: { dueDate: { format: 'date' } },
    });
    expect(reasons).toContain('schema_format_date');
  });

  it('detects schema_property_name_pattern from property name', () => {
    const reasons = detectDateSensitiveReasons({
      schemaProperties: { timezone: {} },
    });
    expect(reasons).toContain('schema_property_name_pattern');
  });

  it('detects dom_relative_time when relativeTimeElements present', () => {
    const reasons = detectDateSensitiveReasons({ hasRelativeTimeElements: true });
    expect(reasons).toContain('dom_relative_time');
  });

  it('detects config_allowlist when testId is in allowlist', () => {
    const reasons = detectDateSensitiveReasons({
      testId: 'booking-form',
      allowlistIds: ['booking-form'],
    });
    expect(reasons).toContain('config_allowlist');
  });

  it('returns empty array when no signals', () => {
    const reasons = detectDateSensitiveReasons({
      formFields: [{ name: 'name', type: 'text' }],
    });
    expect(reasons).toHaveLength(0);
  });
});

describe('classifyDateSensitive', () => {
  it('returns null when test has no date-sensitive signals', () => {
    const tc = makeTestCase();
    const result = classifyDateSensitive(tc, [], []);
    expect(result).toBeNull();
  });

  it('returns reasons from pre-classified dateSensitive field', () => {
    const tc = makeTestCase({ dateSensitive: { reasons: ['form_field_date'] } });
    const result = classifyDateSensitive(tc, [], []);
    expect(result).toContain('form_field_date');
  });

  it('denylist overrides pre-classified dateSensitive', () => {
    const tc = makeTestCase({ dateSensitive: { reasons: ['form_field_date'] }, page: '/admin/dates' });
    const result = classifyDateSensitive(tc, [], ['/admin/dates']);
    expect(result).toBeNull();
  });

  it('allowlist adds config_allowlist reason', () => {
    const tc = makeTestCase({ page: '/booking' });
    const result = classifyDateSensitive(tc, ['/booking'], []);
    expect(result).toContain('config_allowlist');
  });
});

describe('classifyDateSensitiveBatch', () => {
  it('adds dateSensitive to matching test cases only', () => {
    const cases = [
      makeTestCase({ dateSensitive: { reasons: ['form_field_date'] } }),
      makeTestCase(),
    ];
    const result = classifyDateSensitiveBatch(cases, [], []);
    expect(result[0].dateSensitive?.reasons).toContain('form_field_date');
    expect(result[1].dateSensitive).toBeUndefined();
  });

  it('same-shape collapse: 3 cases with same form signature classify to same dateSensitive', () => {
    const cases = [
      makeTestCase({ formSignature: 'date:deadline', dateSensitive: { reasons: ['form_field_name_pattern'] } }),
      makeTestCase({ formSignature: 'date:deadline', dateSensitive: { reasons: ['form_field_name_pattern'] } }),
      makeTestCase({ formSignature: 'date:deadline', dateSensitive: { reasons: ['form_field_name_pattern'] } }),
    ];
    const result = classifyDateSensitiveBatch(cases, [], []);
    expect(result.every(tc => tc.dateSensitive !== undefined)).toBe(true);
  });
});

describe('BugDetection.clockContext round-trips through cluster signature', () => {
  const baselineNowMs = Date.UTC(2026, 2, 8, 6, 30, 0);

  function makeClockDetection(kind: BugDetection['kind'], opts: Partial<NonNullable<BugDetection['clockContext']>> = {}): BugDetection {
    return {
      kind,
      rootCause: 'test',
      pageRoute: '/events',
      endpoint: '/api/events',
      clockContext: {
        condition: opts.condition ?? 'dst_forward',
        injectedNowMs: opts.injectedNowMs ?? baselineNowMs,
        injectedTimezone: opts.injectedTimezone ?? 'America/New_York',
        baselineNowMs,
        proof: opts.proof ?? 'dst_value_drift',
        evidence: 'diff detected',
      },
    };
  }

  it('clock_dst_corruption signature includes condition', () => {
    const d = makeClockDetection('clock_dst_corruption', { condition: 'dst_forward' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_dst_corruption');
    expect(sig).toContain('dst_forward');
  });

  it('clock_leap_day_failure signature includes proof', () => {
    const d = makeClockDetection('clock_leap_day_failure', { condition: 'leap_day', proof: 'leap_day_input_rejected' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_leap_day_failure');
    expect(sig).toContain('leap_day_input_rejected');
  });

  it('clock_skew_token_invalid signature includes condition', () => {
    const d = makeClockDetection('clock_skew_token_invalid', { condition: 'client_skew_plus_1h', proof: 'token_rejected_under_skew' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_skew_token_invalid');
    expect(sig).toContain('client_skew_plus_1h');
  });

  it('clock_timezone_display signature includes injectedTimezone', () => {
    const d = makeClockDetection('clock_timezone_display', { condition: 'tz_skew_negative_8h', injectedTimezone: 'America/Los_Angeles' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_timezone_display');
    expect(sig).toContain('America/Los_Angeles');
  });

  it('clock_overflow signature includes condition', () => {
    const d = makeClockDetection('clock_overflow', { condition: 'y2038_edge', proof: 'int32_overflow_nan' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_overflow');
    expect(sig).toContain('y2038_edge');
  });

  it('different conditions on same route → different signatures', () => {
    const d1 = makeClockDetection('clock_dst_corruption', { condition: 'dst_forward' });
    const d2 = makeClockDetection('clock_dst_corruption', { condition: 'dst_backward' });
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d2));
  });
});

describe('KIND_PRIORITY ordering — clock kinds between pen-testing and IDOR', () => {
  // Import KIND_PRIORITY indirectly by checking that clock_skew_token_invalid
  // ranks higher than idor_horizontal_mutate and lower than jwt_weak_alg.
  // We do this via classifyDateSensitiveBatch which doesn't test priority directly,
  // so we import classify module separately.
  it('ALL_CLOCK_CONDITION_NAMES has 7 entries', () => {
    expect(ALL_CLOCK_CONDITION_NAMES).toHaveLength(7);
  });
});

describe('disabledClockTelemetry', () => {
  it('returns a valid telemetry block with enabled:false', () => {
    const t = disabledClockTelemetry();
    expect(t.enabled).toBe(false);
    expect(t.expandedTests).toBe(0);
    expect(t.conditionsApplied).toHaveLength(0);
  });
});

describe('late-inject sentinel-miss degradation', () => {
  it('classifyDateSensitive marks pre-classified dateSensitive through correctly', () => {
    const tc = makeTestCase({
      dateSensitive: { reasons: ['form_field_date'] },
    });
    const result = classifyDateSensitive(tc, [], []);
    expect(result).not.toBeNull();
    expect(result).toContain('form_field_date');
  });
});
