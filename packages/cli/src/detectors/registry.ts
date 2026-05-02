import type { BugKind } from '../types.js';

export type DetectorStatus = 'wired' | 'deferred' | 'dead';

export type DetectorInputSource = 'production' | 'synthetic-only' | 'unknown';

export type DetectorRegistryEntry = {
  kind: BugKind;
  status: DetectorStatus;
  /**
   * file:line where the BugDetection literal `kind: '<kind>'` is constructed.
   * For `status: 'wired'` this is the canonical detector site.
   * For `status: 'deferred' | 'dead'` this is undefined.
   */
  detectorSite?: string;
  /**
   * file:line where the runner that supplies input to the detector lives.
   * Same as detectorSite when the detector is also the runner (e.g. the
   * pen-test runner emits its own detections inline). Undefined for static
   * analysis kinds where no runtime runner is involved.
   */
  runnerSite?: string;
  /**
   * Whether the input is observed during a real navigation/test
   * (`production`) or synthesised by an explicit probe (`synthetic-only`).
   * Static analysis kinds are `production` (source files are real input).
   */
  inputSource: DetectorInputSource;
  /** Spec file the kind was promised by, e.g. 'SPEC_V05_SECURITY_HYGIENE.md'. */
  specReference: string;
  /**
   * Human-readable note. Required for non-'wired' entries to explain why.
   */
  note?: string;
};

export const DETECTOR_REGISTRY: readonly DetectorRegistryEntry[] = [
  // — § Core (always wired) —
  {
    kind: 'console_error',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/console.ts:24',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'react_error',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/react.ts:45',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'hydration_mismatch',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/react.ts:38',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'network_5xx',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/network.ts:17',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'network_4xx_unexpected',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/network.ts:44',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: '404_for_linked_route',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/network.ts:55',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'missing_state_change',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/state-change.ts:27',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'unhandled_exception',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/console.ts:22',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'accessibility_critical',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/accessibility.ts:36',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'dom_error_text',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/dom-error-text.ts:28',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'surface_call_failed',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/execute.ts:925',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  {
    kind: 'visual_anomaly',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/vision.ts:411',
    runnerSite: 'packages/cli/src/phases/discover.ts',
    inputSource: 'production',
    specReference: 'SPEC.md',
  },
  // — § v0.5 security / hygiene (wired) —
  {
    kind: 'missing_csp_header',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:86',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'permissive_cors',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:121',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'cookie_security_flags',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:152',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'open_redirect',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:261',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'sensitive_data_in_url',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:231',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'stack_trace_leak_in_response',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/header-probe.ts:205',
    runnerSite: 'packages/cli/src/security/header-probe.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'vulnerable_dependency_high',
    status: 'wired',
    detectorSite: 'packages/cli/src/static/tools/npm-audit.ts:31',
    inputSource: 'production',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'hardcoded_credentials_in_source',
    status: 'wired',
    detectorSite: 'packages/cli/src/static/tools/gitleaks.ts:30',
    inputSource: 'production',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'swallowed_error_empty_catch',
    status: 'wired',
    detectorSite: 'packages/cli/src/static/tools/eslint-no-empty.ts:36',
    inputSource: 'production',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'idor_horizontal',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:164',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'idor_vertical_role_escalate',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:244',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  // — § v0.21 IDOR rewire kinds (wired) —
  {
    kind: 'idor_horizontal_read',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:348',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V21_IDOR.md',
  },
  {
    kind: 'idor_horizontal_mutate',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:345',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V21_IDOR.md',
  },
  {
    kind: 'idor_vertical_suspicious',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:271',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V21_IDOR.md',
  },
  {
    kind: 'auth_bypass_via_unauthed_route',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/cross-user.ts:328',
    runnerSite: 'packages/cli/src/phases/cross-user.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  {
    kind: 'no_rate_limit_on_login',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/auth-probes.ts:75',
    runnerSite: 'packages/cli/src/security/auth-probes.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
  },
  // — § v0.25 wired (promoted from deferred) —
  {
    kind: 'csrf_missing_on_mutating_route',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/csrf-detector.ts:73',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V25_DETECTOR_LESS_KINDS.md',
  },
  {
    kind: 'hallucinated_route',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/hallucinated-route.ts:78',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V25_DETECTOR_LESS_KINDS.md',
  },
  // — § v0.19 race-condition kinds (wired) —
  {
    kind: 'race_condition_double_submit',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/race-detectors.ts:74',
    runnerSite: 'packages/cli/src/phases/race-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V19_RACE_CONDITIONS.md',
  },
  {
    kind: 'race_condition_click_navigate',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/race-detectors.ts:114',
    runnerSite: 'packages/cli/src/phases/race-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V19_RACE_CONDITIONS.md',
  },
  {
    kind: 'race_condition_optimistic_revert',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/race-detectors.ts:198',
    runnerSite: 'packages/cli/src/phases/race-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V19_RACE_CONDITIONS.md',
  },
  {
    kind: 'race_condition_interleaved_mutations',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/race-detectors.ts:264',
    runnerSite: 'packages/cli/src/phases/race-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V19_RACE_CONDITIONS.md',
  },
  {
    kind: 'race_condition_cross_tab',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/race-detectors.ts:316',
    runnerSite: 'packages/cli/src/phases/race-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V19_RACE_CONDITIONS.md',
  },
  // — § v0.23 clock-injection kinds (wired via clock-test-runner) —
  {
    kind: 'clock_skew_token_invalid',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/clock-test-runner.ts',
    runnerSite: 'packages/cli/src/security/clock-test-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V23_TIME_CLOCK.md',
  },
  {
    kind: 'clock_overflow',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/clock-test-runner.ts',
    runnerSite: 'packages/cli/src/security/clock-test-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V23_TIME_CLOCK.md',
  },
  {
    kind: 'clock_dst_corruption',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/clock-test-runner.ts',
    runnerSite: 'packages/cli/src/security/clock-test-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V23_TIME_CLOCK.md',
  },
  {
    kind: 'clock_leap_day_failure',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/clock-test-runner.ts',
    runnerSite: 'packages/cli/src/security/clock-test-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V23_TIME_CLOCK.md',
  },
  {
    kind: 'clock_timezone_display',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/clock-test-runner.ts',
    runnerSite: 'packages/cli/src/security/clock-test-runner.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V23_TIME_CLOCK.md',
  },
  // — § v0.16 active pen-testing (wired) —
  {
    kind: 'sql_injection',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/pen-detectors.ts:96',
    runnerSite: 'packages/cli/src/security/pen-detectors.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V16_PEN_TESTING.md',
  },
  {
    kind: 'command_injection',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/pen-detectors.ts:192',
    runnerSite: 'packages/cli/src/security/pen-detectors.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V16_PEN_TESTING.md',
  },
  {
    kind: 'path_traversal',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/pen-detectors.ts:241',
    runnerSite: 'packages/cli/src/security/pen-detectors.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V16_PEN_TESTING.md',
  },
  {
    kind: 'jwt_weak_alg',
    status: 'wired',
    detectorSite: 'packages/cli/src/security/pen-detectors.ts:284',
    runnerSite: 'packages/cli/src/security/pen-detectors.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V16_PEN_TESTING.md',
  },
  // — § v0.7 XSS kinds —
  {
    kind: 'xss_reflected',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/execute.ts:1014',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V07_XSS.md',
  },
  {
    kind: 'xss_dom',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/execute.ts:688',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V07_XSS.md',
  },
  {
    kind: 'xss_stored',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC_V07_XSS.md',
    note: 'Placeholder; v0.8 deliverable.',
  },
  // — § v0.7 auth-flow kinds (wired) —
  {
    kind: 'auth_session_fixation',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/auth-flow.ts:135',
    runnerSite: 'packages/cli/src/phases/auth-flow.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V07_AUTH_FLOWS.md',
  },
  {
    kind: 'password_reset_token_reuse',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/auth-flow.ts:178',
    runnerSite: 'packages/cli/src/phases/auth-flow.ts',
    inputSource: 'synthetic-only',
    specReference: 'SPEC_V07_AUTH_FLOWS.md',
  },
  // — § v0.6 performance kinds (wired) —
  {
    kind: 'slow_lcp',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/vitals.ts:26',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'slow_inp',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/vitals.ts:45',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'high_cls',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/vitals.ts:65',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'unbounded_list_render',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/unbounded-list.ts:125',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'n_plus_one_api_calls',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/request-hygiene.ts:50',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'request_dedup_missing',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/request-hygiene.ts:114',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'request_cancellation_missing',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/request-hygiene.ts:161',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'main_thread_blocked',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/long-tasks.ts:19',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'oversized_bundle',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/bundle-probe.ts:67',
    runnerSite: 'packages/cli/src/phases/bundle-probe.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'excessive_re_renders',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/rerenders.ts:51',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_PERFORMANCE.md',
  },
  {
    kind: 'memory_leak_suspected',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/memory-leak.ts:54',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V08_MEMORY_LEAK.md',
  },
  {
    kind: 'memory_leak_attributed',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/analyze.ts:93',
    runnerSite: 'packages/cli/src/phases/analyze.ts',
    inputSource: 'production',
    specReference: 'SPEC_V08_MEMORY_LEAK.md',
  },
  // — § v0.6 a11y baseline kinds (wired) —
  {
    kind: 'axe_color_contrast_strong',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/a11y-baseline.ts:58',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'keyboard_trap',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/a11y-baseline.ts:95',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'focus_lost_after_action',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/a11y-baseline.ts:108',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'image_missing_alt',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/a11y-baseline.ts:70',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'form_input_unlabeled',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/a11y-baseline.ts:82',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  // — § v0.12 click-evaluate kinds (wired) —
  {
    kind: 'interactive_element_missing_accessible_name',
    status: 'wired',
    detectorSite: 'packages/cli/src/phases/execute.ts:538',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V12_CLICK_ACCESSIBLE_NAME.md',
  },
  // — § v0.6 SEO hygiene kinds (wired) —
  {
    kind: 'seo_title_missing',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:60',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'seo_title_duplicate_across_routes',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:131',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'seo_meta_description_missing',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:69',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'seo_canonical_missing',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:78',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'seo_h1_missing_or_multiple',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:87',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  {
    kind: 'seo_robots_blocking_crawl',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/seo.ts:100',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V06_A11Y_SEO.md',
  },
  // — § v0.22 nav-state kinds (wired) —
  {
    kind: 'nav_state_corruption',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/nav-state.ts:68',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V22_NAV_STATE.md',
  },
  {
    kind: 'nav_resubmit_on_back',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/nav-state.ts:86',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V22_NAV_STATE.md',
  },
  {
    kind: 'nav_refresh_double_mutation',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/nav-state.ts:51',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V22_NAV_STATE.md',
  },
  {
    kind: 'nav_form_state_lost',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/nav-state.ts:222',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V22_NAV_STATE.md',
  },
  {
    kind: 'nav_form_state_stale',
    status: 'wired',
    detectorSite: 'packages/cli/src/classify/nav-state.ts:233',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V22_NAV_STATE.md',
  },

  // v0.36 browser-platform surface kinds
  {
    kind: 'service_worker_stale',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'SW waiting/installing on second visit; skipWaiting not called.',
  },
  {
    kind: 'web_worker_error',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'Unhandled error/messageerror event on a Web Worker.',
  },
  {
    kind: 'iframe_postmessage_unguarded',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'postMessage listener missing event.origin guard.',
  },
  {
    kind: 'shadow_dom_a11y_violation',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'axe-core critical/serious violation inside an open shadow root.',
  },
  {
    kind: 'permission_denied_unhandled',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'Permission API denial causes unhandled UI error or console error.',
  },
  {
    kind: 'webrtc_ice_failure',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'RTCPeerConnection reaches failed/disconnected state without onfailure handler.',
  },
  {
    kind: 'subresource_integrity_violation',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'Script/style loaded without integrity= attribute from a cross-origin URL.',
  },
  {
    kind: 'coop_coep_violation',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'SharedArrayBuffer used but crossOriginIsolated is false (missing COOP/COEP headers).',
  },
  {
    kind: 'trusted_types_violation',
    status: 'wired',
    detectorSite: 'packages/cli/src/discovery/browser-platform-probe.ts',
    runnerSite: 'packages/cli/src/phases/execute.ts',
    inputSource: 'production',
    specReference: 'SPEC_V36_BROWSER_PLATFORM.md',
    note: 'Trusted Types CSP violation — unsafe DOM sink usage detected.',
  },
];

/**
 * Compile-time exhaustiveness: any BugKind not in DETECTOR_REGISTRY produces a
 * type error here. New BugKinds added to types.ts MUST add a registry entry.
 */
type _ExhaustivenessCheck = Exclude<BugKind, (typeof DETECTOR_REGISTRY)[number]['kind']> extends never
  ? true
  : ['DETECTOR_REGISTRY missing entries for BugKinds:', Exclude<BugKind, (typeof DETECTOR_REGISTRY)[number]['kind']>];

export function lookupDetector(kind: BugKind): DetectorRegistryEntry | undefined {
  return DETECTOR_REGISTRY.find(e => e.kind === kind);
}

// v0.29: severity / CWE / exploitability metadata for export emitters.
import type { Severity, ExploitabilityModel } from '../types.js';

export type DetectorMetadata = {
  kind: BugKind;
  severity: Severity;
  cwe?: string[];
  exploitabilityModel?: ExploitabilityModel;
  helpUri?: string;
  displayName: string;
  description: string;
};

/**
 * v0.29: Record-keyed view of DETECTOR_REGISTRY for O(1) lookups by kind.
 * Provides DetectorMetadata shape; severity defaults to 'info' until per-kind
 * calibration is complete.
 */
export const DETECTOR_REGISTRY_MAP: Record<string, DetectorMetadata | undefined> = Object.fromEntries(
  DETECTOR_REGISTRY.map(e => [e.kind, {
    kind: e.kind,
    severity: 'info' as Severity,
    displayName: e.kind,
    description: e.note ?? '',
  } satisfies DetectorMetadata]),
);
