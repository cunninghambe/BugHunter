// V34: per-run coverage.json schema, derivation, and builder.

import type { BugKind, RunState } from '../types.js';
import type { BugCluster } from '../types.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';

export type CoverageStatus =
  | 'fired'
  | 'input-absent'
  | 'detector-dead'
  | 'detector-deferred';

export type CoverageEntry = {
  detectorWired: boolean;
  inputObserved: boolean;
  clustersEmitted: number;
  status: CoverageStatus;
  /** When status is 'detector-deferred', the spec ID that owns the gap. */
  deferredTo?: string;
  /** Free-form, ≤120 chars. Surfaces as "why is this status?" tooltip. */
  reason?: string;
};

export type Coverage = {
  version: 1;
  runId: string;
  generatedAt: string;
  byKind: Record<BugKind, CoverageEntry>;
  summary: {
    kindsTotal: number;
    kindsWiredAndFired: number;
    kindsWiredButInputAbsent: number;
    kindsDead: number;
    kindsDeferred: number;
  };
};

/** Input-source families used in §4.2 predicates. Internal to V34. */
type InputFamily =
  | 'console-and-runtime'
  | 'perf'
  | 'a11y'
  | 'seo'
  | 'security-static'
  | 'security-dynamic'
  | 'vision'
  | 'race'
  | 'browser-platform'
  | 'agent'
  | 'i18n';

/** Canonical kind → input family mapping (spec §4.2). */
const KIND_INPUT_FAMILY: Readonly<Record<BugKind, InputFamily>> = {
  console_error: 'console-and-runtime',
  react_error: 'console-and-runtime',
  hydration_mismatch: 'console-and-runtime',
  unhandled_exception: 'console-and-runtime',
  dom_error_text: 'console-and-runtime',
  '404_for_linked_route': 'console-and-runtime',
  network_5xx: 'console-and-runtime',
  network_4xx_unexpected: 'console-and-runtime',
  missing_state_change: 'console-and-runtime',
  surface_call_failed: 'console-and-runtime',
  hallucinated_route: 'console-and-runtime',
  nav_state_corruption: 'console-and-runtime',
  nav_resubmit_on_back: 'console-and-runtime',
  nav_refresh_double_mutation: 'console-and-runtime',
  nav_form_state_lost: 'console-and-runtime',
  nav_form_state_stale: 'console-and-runtime',
  slow_lcp: 'perf',
  slow_inp: 'perf',
  high_cls: 'perf',
  unbounded_list_render: 'perf',
  n_plus_one_api_calls: 'perf',
  request_dedup_missing: 'perf',
  request_cancellation_missing: 'perf',
  main_thread_blocked: 'perf',
  oversized_bundle: 'perf',
  excessive_re_renders: 'perf',
  memory_leak_suspected: 'perf',
  memory_leak_attributed: 'perf',
  axe_color_contrast_strong: 'a11y',
  keyboard_trap: 'a11y',
  focus_lost_after_action: 'a11y',
  image_missing_alt: 'a11y',
  form_input_unlabeled: 'a11y',
  interactive_element_missing_accessible_name: 'a11y',
  accessibility_critical: 'a11y',
  seo_title_missing: 'seo',
  seo_title_duplicate_across_routes: 'seo',
  seo_meta_description_missing: 'seo',
  seo_canonical_missing: 'seo',
  seo_h1_missing_or_multiple: 'seo',
  seo_robots_blocking_crawl: 'seo',
  vulnerable_dependency_high: 'security-static',
  hardcoded_credentials_in_source: 'security-static',
  swallowed_error_empty_catch: 'security-static',
  stack_trace_leak_in_response: 'security-static',
  sensitive_data_in_url: 'security-static',
  xss_reflected: 'security-dynamic',
  xss_dom: 'security-dynamic',
  xss_stored: 'security-dynamic',
  csrf_missing_on_mutating_route: 'security-dynamic',
  missing_csp_header: 'security-dynamic',
  permissive_cors: 'security-dynamic',
  cookie_security_flags: 'security-dynamic',
  open_redirect: 'security-dynamic',
  idor_horizontal: 'security-dynamic',
  idor_vertical_role_escalate: 'security-dynamic',
  auth_bypass_via_unauthed_route: 'security-dynamic',
  no_rate_limit_on_login: 'security-dynamic',
  auth_session_fixation: 'security-dynamic',
  password_reset_token_reuse: 'security-dynamic',
  sql_injection: 'security-dynamic',
  command_injection: 'security-dynamic',
  path_traversal: 'security-dynamic',
  jwt_weak_alg: 'security-dynamic',
  idor_horizontal_read: 'security-dynamic',
  idor_horizontal_mutate: 'security-dynamic',
  idor_vertical_suspicious: 'security-dynamic',
  visual_anomaly: 'vision',
  agent_response_hallucinated: 'agent',
  agent_action_timeout: 'agent',
  prompt_injection_executed: 'agent',
  streaming_response_truncated: 'agent',
  tool_call_failure_unhandled: 'agent',
  agent_cost_per_turn_high: 'agent',
  race_condition_double_submit: 'race',
  race_condition_click_navigate: 'race',
  race_condition_optimistic_revert: 'race',
  race_condition_interleaved_mutations: 'race',
  race_condition_cross_tab: 'race',
  clock_dst_corruption: 'security-dynamic',
  clock_leap_day_failure: 'security-dynamic',
  clock_skew_token_invalid: 'security-dynamic',
  clock_timezone_display: 'security-dynamic',
  clock_overflow: 'security-dynamic',
  // v0.36 browser-platform kinds
  service_worker_stale: 'browser-platform',
  web_worker_error: 'browser-platform',
  iframe_postmessage_unguarded: 'browser-platform',
  shadow_dom_a11y_violation: 'browser-platform',
  permission_denied_unhandled: 'browser-platform',
  webrtc_ice_failure: 'browser-platform',
  subresource_integrity_violation: 'browser-platform',
  coop_coep_violation: 'browser-platform',
  trusted_types_violation: 'browser-platform',
  // v0.20 network-fault kinds
  network_fault_unhandled: 'security-dynamic',
  network_fault_optimistic_no_revert: 'security-dynamic',
  infinite_loading: 'security-dynamic',
  // v0.37 i18n kinds
  i18n_rtl_layout_break: 'i18n',
  i18n_long_string_overflow: 'i18n',
  i18n_date_format_ambiguous: 'i18n',
  i18n_hardcoded_string: 'i18n',
  i18n_pluralization_broken: 'i18n',
  i18n_currency_format_broken: 'i18n',
  i18n_timezone_display_wrong: 'i18n',
};

type CounterSnapshot = {
  perfSummary?: unknown;
  vision?: { called: number };
  raceConditions?: unknown;
};

function isConsoleAndRuntimeObserved(runState: RunState): boolean {
  return runState.testResults !== undefined && runState.testResults.length > 0;
}

function isPerfObserved(runState: RunState, counters: CounterSnapshot | undefined): boolean {
  return runState.config.perf?.enabled === true && counters?.perfSummary !== undefined;
}

function isA11yObserved(runState: RunState): boolean {
  return runState.config.enableA11y === true || runState.config.a11yStrict === true;
}

function isSeoObserved(runState: RunState): boolean {
  return runState.config.seoEnabled === true;
}

function isSecurityStaticObserved(runState: RunState): boolean {
  return runState.config.staticAnalysis?.enabled !== false;
}

function isSecurityDynamicObserved(runState: RunState): boolean {
  return runState.testResults !== undefined && runState.testResults.length > 0;
}

function isVisionObserved(counters: CounterSnapshot | undefined): boolean {
  return counters?.vision !== undefined && counters.vision.called > 0;
}

function isRaceObserved(counters: CounterSnapshot | undefined): boolean {
  return counters?.raceConditions !== undefined;
}

function isBrowserPlatformObserved(runState: RunState): boolean {
  return runState.config.browserPlatform?.enabled !== false;
}

function isAgentObserved(runState: RunState): boolean {
  return runState.config.agent?.enabled === true;
}

function isI18nObserved(runState: RunState): boolean {
  return runState.config.localeStress === true;
}

/** Compute inputObserved for a given kind, given run state and counters. */
function inputObservedForFamily(
  family: InputFamily,
  runState: RunState,
  counters: CounterSnapshot | undefined,
): boolean {
  switch (family) {
    case 'console-and-runtime': return isConsoleAndRuntimeObserved(runState);
    case 'perf': return isPerfObserved(runState, counters);
    case 'a11y': return isA11yObserved(runState);
    case 'seo': return isSeoObserved(runState);
    case 'security-static': return isSecurityStaticObserved(runState);
    case 'security-dynamic': return isSecurityDynamicObserved(runState);
    case 'vision': return isVisionObserved(counters);
    case 'race': return isRaceObserved(counters);
    case 'browser-platform': return isBrowserPlatformObserved(runState);
    case 'agent': return isAgentObserved(runState);
    case 'i18n': return isI18nObserved(runState);
  }
}

/** Compute inputObserved for every BugKind. */
export function inputObservedByKind(
  runState: RunState,
  counters: CounterSnapshot | undefined,
): Record<BugKind, boolean> {
  const result = {} as Record<BugKind, boolean>;
  for (const kind of Object.keys(KIND_INPUT_FAMILY) as BugKind[]) {
    result[kind] = inputObservedForFamily(KIND_INPUT_FAMILY[kind], runState, counters);
  }
  return result;
}

/** Derive CoverageStatus per §4. Priority order matters. */
export function deriveStatus(
  wired: boolean,
  deferred: boolean,
  inputObserved: boolean,
  clustersEmitted: number,
): CoverageStatus {
  if (deferred) return 'detector-deferred';
  if (!wired) return 'detector-dead';
  if (clustersEmitted > 0) return 'fired';
  if (!inputObserved) return 'input-absent';
  return 'fired';
}

/** Build the full Coverage object. Enforces the sum invariant. */
export function buildCoverage(
  runId: string,
  generatedAt: string,
  runState: RunState,
  clusters: BugCluster[],
  counters: CounterSnapshot | undefined,
): Coverage {
  const byKindCounts = new Map<BugKind, number>();
  for (const c of clusters) {
    byKindCounts.set(c.kind, (byKindCounts.get(c.kind) ?? 0) + 1);
  }

  const observedMap = inputObservedByKind(runState, counters);

  const byKind = {} as Record<BugKind, CoverageEntry>;
  let kindsWiredAndFired = 0;
  let kindsWiredButInputAbsent = 0;
  let kindsDead = 0;
  let kindsDeferred = 0;

  for (const entry of DETECTOR_REGISTRY) {
    const kind = entry.kind;
    const deferred = entry.status === 'deferred';
    const wired = entry.status === 'wired';
    const clustersEmitted = byKindCounts.get(kind) ?? 0;
    const inputObserved = observedMap[kind];

    const status = deriveStatus(wired, deferred, inputObserved, clustersEmitted);

    const coverageEntry: CoverageEntry = {
      detectorWired: wired,
      inputObserved,
      clustersEmitted,
      status,
    };

    if (entry.note !== undefined && entry.note.length > 0) {
      coverageEntry.reason = entry.note.slice(0, 120);
    }

    if (status === 'detector-deferred') {
      // Pull deferredTo from specReference if it looks like a spec ID (e.g. 'SPEC_V08_...')
      const match = /SPEC_(V\d+)/.exec(entry.specReference);
      if (match !== null) {
        coverageEntry.deferredTo = match[1];
      }
      kindsDeferred++;
    } else if (status === 'detector-dead') {
      kindsDead++;
    } else if (status === 'input-absent') {
      kindsWiredButInputAbsent++;
    } else {
      kindsWiredAndFired++;
    }

    byKind[kind] = coverageEntry;
  }

  const kindsTotal = DETECTOR_REGISTRY.length;
  const bucketSum = kindsWiredAndFired + kindsWiredButInputAbsent + kindsDead + kindsDeferred;

  if (bucketSum !== kindsTotal) {
    throw new Error(
      `coverage_registry_drift: bucket sum ${bucketSum} !== kindsTotal ${kindsTotal}`,
    );
  }

  return {
    version: 1,
    runId,
    generatedAt,
    byKind,
    summary: {
      kindsTotal,
      kindsWiredAndFired,
      kindsWiredButInputAbsent,
      kindsDead,
      kindsDeferred,
    },
  };
}
