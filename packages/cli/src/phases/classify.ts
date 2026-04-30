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
  'network_5xx',
  'react_error',
  'hydration_mismatch',
  'surface_call_failed',
  'network_4xx_unexpected',
  '404_for_linked_route',
  // v0.16 pen-testing kinds (unconditionally critical when tagged proof fires — above idor)
  'sql_injection',
  'command_injection',
  'path_traversal',
  'jwt_weak_alg',
  // v0.5 security kinds (ranked above visual but below network errors)
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
  'dom_error_text',
  'visual_anomaly',
  'missing_state_change',
  'console_error',
  'accessibility_critical',
  // v0.6 a11y baseline kinds (same tier as accessibility_critical)
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

export function runClassify(results: TestResult[]): ClassifyResult {
  const bugs: Array<{ testId: string; detection: BugDetection }> = [];
  const infraFailures: InfrastructureFailure[] = [];

  for (const result of results) {
    if (result.infrastructureFailure !== undefined) {
      infraFailures.push(result.infrastructureFailure);
      // Infrastructure failures do NOT enter bugs
      continue;
    }
    const canonical = applyPriorityFilter(result.bugs);
    if (canonical !== null) {
      bugs.push({ testId: result.testId, detection: canonical });
    }
  }

  return { bugs, infraFailures };
}
