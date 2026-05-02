// Phase 4: classify — heuristic bug classification (§ 3.5).
// Deduplicates bugs from test results and marks infrastructure failures.
// Applies priority hierarchy (§ 3.5.1) per test result before clustering.

import type { TestResult, BugDetection, InfrastructureFailure, BugKind } from '../types.js';

export type ClassifyResult = {
  bugs: Array<{ testId: string; detection: BugDetection }>;
  infraFailures: InfrastructureFailure[];
};

// Priority order: index 0 = highest priority (§ 3.5.1).
// Security kinds rank between unhandled_exception and visual_anomaly.
const KIND_PRIORITY: BugKind[] = [
  'unhandled_exception',
  'xss_dom',         // confirmed JS exec
  'xss_reflected',   // confirmed echo
  'xss_stored',      // v0.8 placeholder, never fires
  // v0.19 race-condition kinds: critical (data corruption / silent failure) but below XSS exec
  // click_then_navigate is lowest-of-family (most flake-prone)
  'race_condition_double_submit',
  'race_condition_optimistic_revert',
  'race_condition_interleaved_mutations',
  'race_condition_cross_tab',
  'race_condition_click_navigate',
  // v0.36 browser-platform security-critical kinds (below race, above network errors)
  'trusted_types_violation',
  'web_worker_error',
  'iframe_postmessage_unguarded',
  'service_worker_stale',
  'network_5xx',
  'react_error',
  'hydration_mismatch',
  'surface_call_failed',
  // v0.22 nav-state kinds (§4.1): resubmit + double-mutation rank above generic 4xx
  'nav_resubmit_on_back',
  'nav_refresh_double_mutation',
  'network_4xx_unexpected',
  '404_for_linked_route',
  // v0.16 pen-testing kinds (unconditionally critical when tagged proof fires — above idor)
  'sql_injection',
  'command_injection',
  'path_traversal',
  'jwt_weak_alg',
  // v0.23 clock kinds (above IDOR; clock_skew_token_invalid can lock real users out)
  'clock_skew_token_invalid',
  'clock_overflow',
  'clock_dst_corruption',
  'clock_leap_day_failure',
  'clock_timezone_display',
  // v0.21 IDOR kinds (above legacy idor entries; mutate > read > suspicious)
  'idor_horizontal_mutate',
  'idor_horizontal_read',
  'idor_vertical_suspicious',
  // v0.5 legacy IDOR kinds (kept for backward compat; not emitted by v0.21 classifier)
  'idor_horizontal',
  'idor_vertical_role_escalate',
  'auth_bypass_via_unauthed_route',
  'auth_session_fixation',
  'password_reset_token_reuse',
  'missing_csp_header',
  'permissive_cors',
  'cookie_security_flags',
  'csrf_missing_on_mutating_route',
  'open_redirect',
  'sensitive_data_in_url',
  'stack_trace_leak_in_response',
  'vulnerable_dependency_high',
  'hardcoded_credentials_in_source',
  'no_rate_limit_on_login',
  'hallucinated_route',
  'swallowed_error_empty_catch',
  // v0.36 browser-platform infrastructure/policy kinds
  'permission_denied_unhandled',
  'webrtc_ice_failure',
  'coop_coep_violation',
  'subresource_integrity_violation',
  // v0.22 nav-state catch-all (§4.1)
  'nav_state_corruption',
  // v0.22 form stale (§4.1)
  'nav_form_state_stale',
  'dom_error_text',
  // v0.20 network-fault kinds: above visual_anomaly / missing_state_change,
  // below network_4xx_unexpected (which we suppress under fault anyway).
  'network_fault_optimistic_no_revert',  // most actionable — UI lied to user
  'network_fault_unhandled',
  'infinite_loading',
  'visual_anomaly',
  'missing_state_change',
  // v0.22 form lost (§4.1) — UX-grade, lower priority
  'nav_form_state_lost',
  'console_error',
  'accessibility_critical',
  // v0.6 a11y baseline kinds (same tier as accessibility_critical)
  'shadow_dom_a11y_violation',
  'axe_color_contrast_strong',
  'keyboard_trap',
  'focus_lost_after_action',
  'image_missing_alt',
  'form_input_unlabeled',
  // v0.6 SEO hygiene kinds (above visual_anomaly, below security)
  'seo_title_missing',
  'seo_title_duplicate_across_routes',
  'seo_meta_description_missing',
  'seo_canonical_missing',
  'seo_h1_missing_or_multiple',
  'seo_robots_blocking_crawl',
  // v0.6 performance kinds (below security, above nothing)
  'slow_lcp',
  'slow_inp',
  'high_cls',
  'unbounded_list_render',
  'n_plus_one_api_calls',
  'request_dedup_missing',
  'request_cancellation_missing',
  'main_thread_blocked',
  'oversized_bundle',
  'excessive_re_renders',
  'memory_leak_attributed',
  'memory_leak_suspected',
];

function priorityOf(kind: BugKind): number {
  const idx = KIND_PRIORITY.indexOf(kind);
  return idx === -1 ? KIND_PRIORITY.length : idx;
}

/**
 * v0.20: suppress detections that are caused by the fault injection, not by app bugs.
 * Called when the parent TestCase has faultInjected !== undefined.
 *
 * Suppressed: network_5xx, network_4xx_unexpected, surface_call_failed.
 * Console errors are suppressed unless they indicate an unhandled-promise rejection
 * or parse error (which are bugs regardless of fault context).
 * unhandled_exception is always kept — exceptions are bugs.
 */
function applyFaultSuppressionFilter(detections: BugDetection[]): BugDetection[] {
  return detections.filter(d => {
    if (d.kind === 'network_5xx' || d.kind === 'network_4xx_unexpected' || d.kind === 'surface_call_failed') {
      return false;
    }
    if (d.kind === 'console_error') {
      // Keep if it's an unhandled rejection or parse error
      const text = d.rootCause;
      const isSignificant = /unhandled.*rejection|uncaught.*error|syntaxerror|parse.*error|json.*parse/i.test(text);
      return isSignificant;
    }
    return true;
  });
}

// Given multiple detections for one test result, pick the canonical (highest-priority)
// one and attach the rest as secondaryObservations.
function applyPriorityFilter(detections: BugDetection[]): BugDetection | null {
  if (detections.length === 0) return null;
  if (detections.length === 1) return detections[0];

  const sorted = [...detections].sort((a, b) => priorityOf(a.kind) - priorityOf(b.kind));
  const [canonical, ...rest] = sorted;
  return {
    ...canonical,
    secondaryObservations: rest.map(d => ({ kind: d.kind, detail: d.rootCause })),
  };
}

export function runClassify(results: TestResult[], testCaseMap?: Map<string, { faultInjected?: unknown }>): ClassifyResult {
  const bugs: Array<{ testId: string; detection: BugDetection }> = [];
  const infraFailures: InfrastructureFailure[] = [];

  for (const result of results) {
    if (result.infrastructureFailure !== undefined) {
      infraFailures.push(result.infrastructureFailure);
      // Infrastructure failures do NOT enter bugs
      continue;
    }

    let detections = result.bugs;

    // v0.20: apply fault suppression when this test had a fault injected
    const tc = testCaseMap?.get(result.testId);
    if (tc?.faultInjected !== undefined) {
      detections = applyFaultSuppressionFilter(detections);
    }

    const canonical = applyPriorityFilter(detections);
    if (canonical !== null) {
      bugs.push({ testId: result.testId, detection: canonical });
    }
  }

  return { bugs, infraFailures };
}
