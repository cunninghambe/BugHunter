/**
 * v0.23 clock-test smoke tests.
 *
 * These tests exercise the clock-testing subsystem without a live browser.
 * Full end-to-end smoke (fixture server + camofox) is deferred to the
 * manual smoke criteria in SPEC_V23_TIME_CLOCK.md §13.
 *
 * What we test here:
 *   - Clock conditions resolve correct unix-ms / TZ
 *   - Date-sensitivity classifier fires on expected inputs
 *   - Polyfill source compiles and contains sentinel
 *   - Cluster signatures are stable for each new BugKind
 *   - Telemetry block shape is correct
 *   - Kind priority ordering (clock above IDOR, below pen-testing)
 */

import { describe, it, expect } from 'vitest';
import { CLOCK_CONDITIONS, defaultConditionsForReasons, getClockCondition } from '../../packages/cli/src/security/clock-conditions.js';
import { buildClockPolyfill } from '../../packages/cli/src/security/clock-polyfill-source.js';
import { detectDateSensitiveReasons, disabledClockTelemetry, ALL_CLOCK_CONDITION_NAMES } from '../../packages/cli/src/security/clock-test-runner.js';
import { clusterSignature } from '../../packages/cli/src/cluster/signature.js';
import type { BugDetection } from '../../packages/cli/src/types.js';

// KIND_PRIORITY is not exported, but we can test it indirectly via runClassify
import { runClassify } from '../../packages/cli/src/phases/classify.js';
import type { TestResult } from '../../packages/cli/src/types.js';

describe('Clock smoke: conditions', () => {
  it('all 7 conditions are present', () => {
    expect(CLOCK_CONDITIONS).toHaveLength(7);
    expect(ALL_CLOCK_CONDITION_NAMES).toHaveLength(7);
  });

  it('each condition has a targetKind', () => {
    for (const c of CLOCK_CONDITIONS) {
      expect(c.targetKind).toBeTruthy();
    }
  });

  it('dst_forward unix-ms is a valid future date', () => {
    const c = getClockCondition('dst_forward');
    expect(c.injectedNowMs).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it('leap_day unix-ms falls on 2024-02-29', () => {
    const c = getClockCondition('leap_day');
    const d = new Date(c.injectedNowMs!);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(1); // February = 1
    expect(d.getUTCDate()).toBe(29);
  });
});

describe('Clock smoke: polyfill', () => {
  it('contains sentinel __BUGHUNTER_CLOCK_INSTALLED', () => {
    const script = buildClockPolyfill(Date.UTC(2026, 2, 8, 6, 30, 0));
    expect(script).toContain('__BUGHUNTER_CLOCK_INSTALLED');
  });

  it('contains the injected unix-ms', () => {
    const ms = Date.UTC(2024, 1, 29, 12, 0, 0);
    const script = buildClockPolyfill(ms);
    expect(script).toContain(String(ms));
  });

  it('does not patch performance or Intl', () => {
    const script = buildClockPolyfill(0);
    expect(script).not.toContain('performance');
    expect(script).not.toContain('DateTimeFormat');
  });
});

describe('Clock smoke: date-sensitivity detection', () => {
  it('FormField type:date → form_field_date', () => {
    const r = detectDateSensitiveReasons({ formFields: [{ name: 'birthday', type: 'date' }] });
    expect(r).toContain('form_field_date');
  });

  it('schema format:date-time → schema_format_date', () => {
    const r = detectDateSensitiveReasons({ schemaProperties: { createdAt: { format: 'date-time' } } });
    expect(r).toContain('schema_format_date');
  });

  it('tool name "deadline" → schema_property_name_pattern', () => {
    const r = detectDateSensitiveReasons({ schemaProperties: { deadline: {} } });
    expect(r).toContain('schema_property_name_pattern');
  });

  it('relativeTimeElements → dom_relative_time', () => {
    const r = detectDateSensitiveReasons({ hasRelativeTimeElements: true });
    expect(r).toContain('dom_relative_time');
  });

  it('no signals → empty', () => {
    const r = detectDateSensitiveReasons({ formFields: [{ name: 'name', type: 'text' }] });
    expect(r).toHaveLength(0);
  });
});

describe('Clock smoke: defaultConditionsForReasons', () => {
  it('form_field_date → 4 conditions', () => {
    const c = defaultConditionsForReasons(['form_field_date']);
    expect(c.length).toBe(4);
    expect(c).toContain('dst_forward');
    expect(c).toContain('leap_day');
  });

  it('dom_relative_time → tz + skew conditions', () => {
    const c = defaultConditionsForReasons(['dom_relative_time']);
    expect(c).toContain('tz_skew_negative_8h');
    expect(c).toContain('client_skew_plus_1h');
    expect(c).not.toContain('leap_day');
  });

  it('config_allowlist → all 7', () => {
    const c = defaultConditionsForReasons(['config_allowlist']);
    expect(c).toHaveLength(7);
  });
});

describe('Clock smoke: cluster signatures', () => {
  function clockDetection(kind: BugDetection['kind'], opts: Partial<NonNullable<BugDetection['clockContext']>> = {}): BugDetection {
    return {
      kind,
      rootCause: 'test',
      pageRoute: '/events',
      endpoint: '/api/events',
      clockContext: {
        condition: opts.condition ?? 'dst_forward',
        injectedNowMs: opts.injectedNowMs,
        injectedTimezone: opts.injectedTimezone ?? 'America/New_York',
        baselineNowMs: Date.now(),
        proof: opts.proof ?? 'dst_value_drift',
        evidence: 'test evidence',
      },
    };
  }

  it('clock_dst_corruption includes condition in signature', () => {
    const sig = clusterSignature(clockDetection('clock_dst_corruption', { condition: 'dst_forward' }));
    expect(sig).toMatch(/^clock_dst_corruption\|/);
    expect(sig).toContain('dst_forward');
  });

  it('clock_leap_day_failure includes proof in signature', () => {
    const sig = clusterSignature(clockDetection('clock_leap_day_failure', { condition: 'leap_day', proof: 'leap_day_input_rejected' }));
    expect(sig).toContain('clock_leap_day_failure');
    expect(sig).toContain('leap_day_input_rejected');
  });

  it('clock_skew_token_invalid includes condition', () => {
    const sig = clusterSignature(clockDetection('clock_skew_token_invalid', { condition: 'client_skew_plus_1h', proof: 'token_rejected_under_skew' }));
    expect(sig).toContain('clock_skew_token_invalid');
    expect(sig).toContain('client_skew_plus_1h');
  });

  it('clock_timezone_display includes injectedTimezone', () => {
    const d = clockDetection('clock_timezone_display', { condition: 'tz_skew_negative_8h', injectedTimezone: 'America/Los_Angeles', proof: 'timezone_display_drift' });
    const sig = clusterSignature(d);
    expect(sig).toContain('clock_timezone_display');
    expect(sig).toContain('America/Los_Angeles');
  });

  it('clock_overflow includes condition', () => {
    const sig = clusterSignature(clockDetection('clock_overflow', { condition: 'y2038_edge', proof: 'int32_overflow_nan' }));
    expect(sig).toContain('clock_overflow');
    expect(sig).toContain('y2038_edge');
  });

  it('different conditions on same route produce different signatures', () => {
    const s1 = clusterSignature(clockDetection('clock_dst_corruption', { condition: 'dst_forward' }));
    const s2 = clusterSignature(clockDetection('clock_dst_corruption', { condition: 'dst_backward' }));
    expect(s1).not.toBe(s2);
  });
});

describe('Clock smoke: telemetry block', () => {
  it('disabledClockTelemetry has correct shape', () => {
    const t = disabledClockTelemetry();
    expect(t.enabled).toBe(false);
    expect(t.expandedTests).toBe(0);
    expect(Array.isArray(t.conditionsApplied)).toBe(true);
    expect(Array.isArray(t.testsSkipped)).toBe(true);
    expect(typeof t.detectionsByKind).toBe('object');
    expect(typeof t.degradedModeCount).toBe('number');
    expect(typeof t.durationMs).toBe('number');
  });
});

describe('Clock smoke: KIND_PRIORITY ordering (clock above IDOR, below pen-testing)', () => {
  function makeResult(kind: BugDetection['kind']): TestResult {
    return {
      testId: 'test-1',
      occurrenceId: 'occ-1',
      passed: false,
      durationMs: 100,
      bugs: [{ kind, rootCause: 'test' }],
    };
  }

  it('clock_skew_token_invalid ranks above idor_horizontal_mutate', () => {
    // When both fire, clock_skew_token_invalid should be the canonical detection
    const result: TestResult = {
      testId: 'test-1',
      occurrenceId: 'occ-1',
      passed: false,
      durationMs: 100,
      bugs: [
        { kind: 'idor_horizontal_mutate', rootCause: 'idor' },
        { kind: 'clock_skew_token_invalid', rootCause: 'clock' },
      ],
    };
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('clock_skew_token_invalid');
  });

  it('jwt_weak_alg ranks above clock_overflow (pen-testing > clock)', () => {
    const result: TestResult = {
      testId: 'test-2',
      occurrenceId: 'occ-2',
      passed: false,
      durationMs: 100,
      bugs: [
        { kind: 'clock_overflow', rootCause: 'clock' },
        { kind: 'jwt_weak_alg', rootCause: 'pen', injectionContext: { paramName: 'alg', variant: 'none', nonce: 'abc', proof: 'unsigned_accepted', evidence: 'test' } },
      ],
    };
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('jwt_weak_alg');
  });
});
