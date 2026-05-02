/**
 * v0.23 clock-condition palette and default-condition selection.
 *
 * Clock instants are static and do not travel forward with the calendar.
 * US DST rules have been stable since 2007; the dst_forward / dst_backward
 * UTC instants are valid until the rules change. When they become stale,
 * update the table here and in SPEC_V23_TIME_CLOCK.md.
 *
 * EC-10 clarification (from spec): client_skew_plus_1h runs two probes:
 *   - +30s probe for clock_skew_token_invalid (within reasonable server tolerance)
 *   - +1h for DST-adjacency clock_dst_corruption check
 * The condition name client_skew_plus_1h is the stress condition shown to the user.
 */

import type { DateSensitiveReason } from '../types.js';

export type ClockConditionName =
  | 'dst_forward'
  | 'dst_backward'
  | 'leap_day'
  | 'y2038_edge'
  | 'far_future'
  | 'client_skew_plus_1h'
  | 'tz_skew_negative_8h';

export type ClockCondition = {
  name: ClockConditionName;
  /** unix-ms the polyfill sets page clock to; undefined for tz-only conditions */
  injectedNowMs?: number;
  /** IANA timezone override; undefined for clock-only conditions */
  injectedTimezone?: string;
  /** The BugKind this condition primarily targets */
  targetKind: string;
};

/** The seven canonical clock conditions per §6 of the spec. */
export const CLOCK_CONDITIONS: readonly ClockCondition[] = [
  {
    name: 'dst_forward',
    // 2026-03-08T06:30:00Z — 30 min before US Eastern spring-forward
    injectedNowMs: Date.UTC(2026, 2, 8, 6, 30, 0),
    injectedTimezone: 'America/New_York',
    targetKind: 'clock_dst_corruption',
  },
  {
    name: 'dst_backward',
    // 2026-11-01T05:30:00Z — 30 min before US Eastern fall-back
    injectedNowMs: Date.UTC(2026, 10, 1, 5, 30, 0),
    injectedTimezone: 'America/New_York',
    targetKind: 'clock_dst_corruption',
  },
  {
    name: 'leap_day',
    // 2024-02-29T12:00:00Z — Feb 29 of a known leap year, near midday UTC
    injectedNowMs: Date.UTC(2024, 1, 29, 12, 0, 0),
    injectedTimezone: 'UTC',
    targetKind: 'clock_leap_day_failure',
  },
  {
    name: 'y2038_edge',
    // 2038-01-19T03:13:07Z — 1 minute before int32 unix-seconds overflow
    injectedNowMs: Date.UTC(2038, 0, 19, 3, 13, 7),
    injectedTimezone: 'UTC',
    targetKind: 'clock_overflow',
  },
  {
    name: 'far_future',
    // 2099-01-01T12:00:00Z (2099 is NOT a leap year)
    injectedNowMs: Date.UTC(2099, 0, 1, 12, 0, 0),
    injectedTimezone: 'UTC',
    targetKind: 'clock_overflow',
  },
  {
    name: 'client_skew_plus_1h',
    // wall clock unchanged — runner adds serverNowMs + 3_600_000 at probe time
    // Internal: +30s probe for token-skew, +1h for DST-adjacency (see EC-10 note above)
    injectedTimezone: undefined,
    targetKind: 'clock_skew_token_invalid',
  },
  {
    name: 'tz_skew_negative_8h',
    // wall clock unchanged; TZ override to LA while user profile TZ is New York
    injectedTimezone: 'America/Los_Angeles',
    targetKind: 'clock_timezone_display',
  },
];

const CONDITION_MAP = new Map<ClockConditionName, ClockCondition>(
  CLOCK_CONDITIONS.map(c => [c.name, c]),
);

export function getClockCondition(name: ClockConditionName): ClockCondition {
  const c = CONDITION_MAP.get(name);
  if (c === undefined) throw new Error(`Unknown clock condition: ${name}`);
  return c;
}

/**
 * Return the minimal set of clock conditions for a given set of date-sensitivity reasons.
 * Per §3.3 of the spec.
 */
export function defaultConditionsForReasons(reasons: DateSensitiveReason[]): ClockConditionName[] {
  const conditions = new Set<ClockConditionName>();

  for (const reason of reasons) {
    switch (reason) {
      case 'form_field_date':
      case 'schema_format_date':
      case 'schema_property_name_pattern':
      case 'form_field_name_pattern':
        conditions.add('dst_forward');
        conditions.add('dst_backward');
        conditions.add('leap_day');
        conditions.add('far_future');
        break;
      case 'dom_relative_time':
        conditions.add('tz_skew_negative_8h');
        conditions.add('client_skew_plus_1h');
        break;
      case 'config_allowlist':
        for (const c of CLOCK_CONDITIONS) conditions.add(c.name);
        break;
      // config_denylist is a negative signal — handled by caller (not a reason that adds conditions)
    }
  }

  return [...conditions];
}
