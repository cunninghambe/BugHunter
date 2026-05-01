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
  // — § v0.5 deferred —
  {
    kind: 'csrf_missing_on_mutating_route',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC_V05_SECURITY_HYGIENE.md',
    note: 'Phase A backlog (SPEC_PATH_TO_EXHAUSTIVE.md §9). Detector promised but never wired.',
  },
  {
    kind: 'race_double_submit',
    status: 'deferred',
    inputSource: 'synthetic-only',
    specReference: 'SPEC.md',
    note: 'Synthetic scenario flag exists in BugHunterConfig.synthetic but no detector site emits this kind.',
  },
  {
    kind: 'optimistic_update_divergence',
    status: 'deferred',
    inputSource: 'synthetic-only',
    specReference: 'SPEC.md',
    note: 'Same as race_double_submit.',
  },
  {
    kind: 'hallucinated_route',
    status: 'deferred',
    inputSource: 'unknown',
    specReference: 'SPEC.md',
    note: 'Phase A backlog. Planner-vs-served route comparison not implemented.',
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
