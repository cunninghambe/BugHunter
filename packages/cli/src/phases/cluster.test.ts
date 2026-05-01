// Tests for cluster phase (v0.5 Gap 3 — stateByTestId warning carve-out).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCluster, replayKindForBugKind } from './cluster.js';
import type { ClusterOptions } from './cluster.js';
import type { BugDetection, TestCase } from '../types.js';
import { log } from '../log.js';

function makeDetection(overrides: Partial<BugDetection> = {}): BugDetection {
  return {
    kind: 'missing_csp_header',
    rootCause: 'CSP absent',
    ...overrides,
  };
}

function makeTestCase(id: string, role: string, page = '/test'): TestCase {
  return {
    id,
    runId: 'run-1',
    role,
    page,
    action: { kind: 'render', via: 'api', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function makeClusterOpts(overrides: Partial<ClusterOptions> = {}): ClusterOptions {
  const testId = 'test-id-1';
  const occurrenceId = 'occ-id-1';

  const detection = makeDetection();
  const tc = makeTestCase(testId, 'system');

  return {
    detections: [{ testId, detection }],
    testCases: [tc],
    runId: 'run-1',
    projectDir: '/tmp',
    actionLogsDir: '/tmp/action-logs',
    screenshotsDir: '/tmp/screenshots',
    domDir: '/tmp/dom',
    consoleDir: '/tmp/console',
    networkDir: '/tmp/network',
    maxClusters: 50,
    occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
    stateByTestId: undefined,
    ...overrides,
  };
}

describe('runCluster — stateByTestId warning carve-out', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn');
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('does NOT warn when role=system and stateByTestId is undefined', () => {
    const opts = makeClusterOpts();
    // system role, no stateByTestId — synthetic occurrence, no warning expected
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeUndefined();
  });

  it('does NOT warn when role=anonymous and stateByTestId is undefined', () => {
    const testId = 'test-id-anon';
    const occurrenceId = 'occ-id-anon';
    const opts = makeClusterOpts({
      detections: [{ testId, detection: makeDetection({ kind: 'visual_anomaly', rootCause: 'visual issue' }) }],
      testCases: [makeTestCase(testId, 'anonymous')],
      occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
      stateByTestId: undefined,
    });
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeUndefined();
  });

  it('DOES warn when role=owner and stateByTestId lookup misses', () => {
    const testId = 'test-id-owner';
    const occurrenceId = 'occ-id-owner';
    const opts = makeClusterOpts({
      detections: [{ testId, detection: makeDetection({ kind: 'console_error', rootCause: 'err' }) }],
      testCases: [makeTestCase(testId, 'owner')],
      occurrenceIdByTestId: new Map([[testId, occurrenceId]]),
      stateByTestId: new Map(), // empty — lookup will miss
    });
    runCluster(opts);
    const warnCalls = warnSpy.mock.calls as Array<[string, ...unknown[]]>;
    const missedWarn = warnCalls.find(([msg]) => msg === 'cluster: testId present but stateByTestId lookup missed');
    expect(missedWarn).toBeDefined();
  });
});


describe('replayKindForBugKind — mapping table', () => {
  // action_log kinds (require live browser/server)
  const ACTION_LOG_KINDS = [
    'console_error', 'react_error', 'hydration_mismatch', 'network_5xx',
    'network_4xx_unexpected', '404_for_linked_route', 'missing_state_change',
    'unhandled_exception', 'accessibility_critical', 'dom_error_text',
    'surface_call_failed', 'idor_horizontal', 'idor_vertical_role_escalate',
    'auth_bypass_via_unauthed_route', 'no_rate_limit_on_login',
    'race_condition_double_submit', 'race_condition_click_navigate',
    'race_condition_optimistic_revert', 'race_condition_interleaved_mutations',
    'race_condition_cross_tab', 'csrf_missing_on_mutating_route',
    'xss_reflected', 'xss_dom', 'xss_stored', 'auth_session_fixation',
    'password_reset_token_reuse', 'sql_injection', 'command_injection',
    'path_traversal', 'jwt_weak_alg', 'focus_lost_after_action',
    'interactive_element_missing_accessible_name',
  ] as const;

  // static_rerun kinds (no live browser/server needed)
  const STATIC_RERUN_KINDS = [
    'axe_color_contrast_strong', 'image_missing_alt', 'form_input_unlabeled', 'keyboard_trap',
    'seo_title_missing', 'seo_title_duplicate_across_routes', 'seo_meta_description_missing',
    'seo_canonical_missing', 'seo_h1_missing_or_multiple', 'seo_robots_blocking_crawl',
    'visual_anomaly',
    'slow_lcp', 'slow_inp', 'high_cls', 'unbounded_list_render', 'n_plus_one_api_calls',
    'request_dedup_missing', 'request_cancellation_missing', 'main_thread_blocked',
    'oversized_bundle', 'excessive_re_renders', 'memory_leak_suspected', 'memory_leak_attributed',
    'vulnerable_dependency_high', 'hardcoded_credentials_in_source', 'swallowed_error_empty_catch',
    'missing_csp_header', 'permissive_cors', 'cookie_security_flags', 'open_redirect',
    'sensitive_data_in_url', 'stack_trace_leak_in_response', 'hallucinated_route',
  ] as const;

  for (const kind of ACTION_LOG_KINDS) {
    it(`${kind} → action_log`, () => {
      expect(replayKindForBugKind(kind)).toBe('action_log');
    });
  }

  for (const kind of STATIC_RERUN_KINDS) {
    it(`${kind} → static_rerun`, () => {
      expect(replayKindForBugKind(kind)).toBe('static_rerun');
    });
  }
});

describe('runCluster — replayKind and signatureKey tagging', () => {
  it('tags action_log clusters with replayKind=action_log', () => {
    const opts = makeClusterOpts({
      detections: [{ testId: 'test-id-1', detection: makeDetection({ kind: 'console_error', rootCause: 'err' }) }],
      testCases: [makeTestCase('test-id-1', 'owner')],
      occurrenceIdByTestId: new Map([['test-id-1', 'occ-id-1']]),
    });
    const { clusters } = runCluster(opts);
    expect(clusters[0]?.replayKind).toBe('action_log');
  });

  it('tags static_rerun clusters with replayKind=static_rerun', () => {
    const opts = makeClusterOpts({
      detections: [{ testId: 'test-id-1', detection: makeDetection({ kind: 'vulnerable_dependency_high', rootCause: 'cve' }) }],
      testCases: [makeTestCase('test-id-1', 'system')],
      occurrenceIdByTestId: new Map([['test-id-1', 'occ-id-1']]),
    });
    const { clusters } = runCluster(opts);
    expect(clusters[0]?.replayKind).toBe('static_rerun');
  });

  it('stores a non-empty signatureKey on each minted cluster', () => {
    const opts = makeClusterOpts({
      detections: [{ testId: 'test-id-1', detection: makeDetection({ kind: 'missing_csp_header', rootCause: 'no csp' }) }],
      testCases: [makeTestCase('test-id-1', 'system')],
      occurrenceIdByTestId: new Map([['test-id-1', 'occ-id-1']]),
    });
    const { clusters } = runCluster(opts);
    expect(typeof clusters[0]?.signatureKey).toBe('string');
    expect(clusters[0]?.signatureKey?.length).toBeGreaterThan(0);
  });
});
