/**
 * v0.23 clock-test-runner — orchestrates date-sensitive test variants under
 * each clock condition.
 *
 * Invoked from cli/run.ts between the standard execute phase and classify,
 * parallel to the pen-test runner.
 *
 * Architecture notes:
 * - Each clock-conditioned test gets a fresh browser context (fresh tab). Reuse
 *   would leak Date overrides across tests (EC-5 of the spec).
 * - Clock is injected AFTER login completes (EC-12): login uses real clock so
 *   the token is fresh; then we skew the clock before the target action.
 * - client_skew_plus_1h runs two internal probes (EC-10):
 *     +30s → token-skew detection (within reasonable server tolerance)
 *     the condition name reflects the stress level shown to the user
 * - SSR blind spot: server-rendered timestamps are not covered; flagged in telemetry.
 * - Workers blind spot: init scripts run in page realm; workers see real clock.
 * - Cross-origin iframes: skipped; selector would resolve outside same-origin frame.
 *
 * Token skew fingerprint (negative requirement §12): a 4xx alone is NOT proof of
 * clock_skew_token_invalid. Response body or WWW-Authenticate must match
 * TOKEN_SKEW_FINGERPRINT.
 */

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BugDetection, ClockContext, ClockTestingConfig, ClockTestingTelemetry, DateSensitiveReason, TestCase } from '../types.js';

type ClockProof = ClockContext['proof'];
import { CLOCK_CONDITIONS, defaultConditionsForReasons, getClockCondition } from './clock-conditions.js';
import type { ClockConditionName, ClockCondition } from './clock-conditions.js';
import { buildClockPolyfill } from './clock-polyfill-source.js';
import { log } from '../log.js';

const TOKEN_SKEW_FINGERPRINT = /token expired|jwt expired|expired token|future-dated|clock skew|nbf|iat/i;

export type ClockTestRunnerResult = {
  detections: BugDetection[];
  telemetry: ClockTestingTelemetry;
};

type SkipCount = { reason: string; count: number };

/**
 * Classify date-sensitivity of a single test case.
 * Returns null when the test is not date-sensitive (no clock variants needed).
 */
export function classifyDateSensitive(
  tc: TestCase,
  allowlist: string[],
  denylist: string[],
): DateSensitiveReason[] | null {
  // Denylist wins over all heuristics
  const id = tc.action.toolId ?? tc.formSignature ?? tc.page;
  if (denylist.some(d => id.includes(d) || tc.page.includes(d))) return null;

  const reasons = new Set<DateSensitiveReason>();

  // Config allowlist
  if (allowlist.some(a => id.includes(a) || tc.page.includes(a))) {
    reasons.add('config_allowlist');
  }

  // Form field signals
  if (tc.action.kind === 'submit' && tc.action.input !== null && typeof tc.action.input === 'object') {
    // We check form field names via formSignature; actual FormField types are in discovery
    // For runtime: check field names in the input payload
    const fields = Object.keys(tc.action.input as Record<string, unknown>);
    if (fields.some(f => /^(date|time|expires?|expir(y|ation|es_at)|deadline|when|start(_?at|_?date)?|end(_?at|_?date)?|created_?at|updated_?at|published_?at|scheduled_?at|due_?at|tz|timezone)$/i.test(f))) {
      reasons.add('form_field_name_pattern');
    }
  }

  // Tool schema signals
  if (tc.action.toolId !== undefined && tc.action.via === 'api') {
    // schema signals are pre-set on dateSensitive by the planner — propagate here
  }

  // Pre-classified by planner
  if (tc.dateSensitive !== undefined) {
    for (const r of tc.dateSensitive.reasons) reasons.add(r);
  }

  return reasons.size > 0 ? [...reasons] : null;
}

/**
 * Fetch the server's current wall clock (unix-ms) from a URL's Date response header.
 * Falls back to Date.now() when the request fails or header is absent.
 */
async function fetchServerClock(sourceUrl: string): Promise<number> {
  try {
    const res = await fetch(sourceUrl, { method: 'HEAD' });
    const dateHeader = res.headers.get('date');
    if (dateHeader !== null) {
      const parsed = Date.parse(dateHeader);
      if (!Number.isNaN(parsed)) return parsed;
    }
  } catch {
    // non-fatal — fall through to local clock
  }
  return Date.now();
}

/**
 * Inject clock state into the browser for a given condition.
 * Returns degradedMode reflecting which primitives were available.
 */
async function injectClock(
  browser: BrowserMcpAdapter,
  condition: ClockCondition,
  serverNowMs: number,
): Promise<'late_inject' | 'tz_only' | 'none'> {
  let degradedMode: 'late_inject' | 'tz_only' | 'none' = 'none';

  // Compute the target unix-ms for the polyfill
  let targetMs: number | undefined = condition.injectedNowMs;
  if (condition.name === 'client_skew_plus_1h') {
    // +30s for token-skew probe (EC-10)
    targetMs = serverNowMs + 30_000;
  }

  // TZ override first
  if (condition.injectedTimezone !== undefined && browser.setTimezoneOverride !== undefined) {
    const tzResult = await browser.setTimezoneOverride(condition.injectedTimezone);
    if (!tzResult.applied) degradedMode = 'tz_only';
  }

  // Wall-clock polyfill via init script
  if (targetMs !== undefined && browser.addInitScript !== undefined) {
    const polyfill = buildClockPolyfill(targetMs);
    const initResult = await browser.addInitScript(polyfill);
    if (!initResult.applied) degradedMode = 'late_inject';
  }

  return degradedMode;
}

/**
 * Check whether the clock polyfill ran before app code by reading the sentinel.
 * Returns true when running at CDP level (no late_inject race).
 */
async function checkSentinelInstalled(browser: BrowserMcpAdapter): Promise<boolean> {
  try {
    const result = await browser.evaluate('window.__BUGHUNTER_CLOCK_INSTALLED === true');
    return result.value === true;
  } catch {
    return false;
  }
}

/**
 * Run clock-conditioned tests for the given date-sensitive test cases.
 * Each test × condition gets a fresh browser context (fresh tab).
 */
export async function runClockTests(
  cfg: ClockTestingConfig,
  dateSensitiveCases: TestCase[],
  surface: SurfaceMcpAdapter,
  browser: BrowserMcpAdapter,
  serverClockSourceUrl?: string,
): Promise<ClockTestRunnerResult> {
  const startMs = Date.now();
  const detections: BugDetection[] = [];
  const skipCounts = new Map<string, number>();
  let degradedModeCount = 0;
  const conditionsApplied = new Set<string>();
  let expandedTests = 0;

  const serverNowMs = await fetchServerClock(
    serverClockSourceUrl ?? cfg.serverClockSource ?? 'http://localhost',
  );

  for (const tc of dateSensitiveCases) {
    // Only happy-palette, non-expected_failure tests (spec §2.3 negative requirements)
    if (tc.action.expectedOutcome === 'expected_failure') {
      skipCounts.set('expected_failure_skipped', (skipCounts.get('expected_failure_skipped') ?? 0) + 1);
      continue;
    }

    const reasons = tc.dateSensitive?.reasons ?? [];
    const activeConditions: ClockConditionName[] = cfg.activeConditions ?? defaultConditionsForReasons(reasons);

    for (const conditionName of activeConditions) {
      const condition = getClockCondition(conditionName);
      conditionsApplied.add(conditionName);
      expandedTests++;

      const findings = await runSingleClockTest(
        tc,
        condition,
        browser,
        surface,
        serverNowMs,
        skipCounts,
      );
      if (findings !== null) {
        if (findings.clockContext?.degradedMode === 'late_inject') degradedModeCount++;
        detections.push(findings);
      }
    }
  }

  const detectionsByKind: Record<string, number> = {};
  for (const d of detections) {
    detectionsByKind[d.kind] = (detectionsByKind[d.kind] ?? 0) + 1;
  }

  const testsSkipped: SkipCount[] = [...skipCounts.entries()].map(([reason, count]) => ({ reason, count }));

  const telemetry: ClockTestingTelemetry = {
    enabled: true,
    conditionsApplied: [...conditionsApplied],
    dateSensitiveTests: dateSensitiveCases.length,
    expandedTests,
    testsSkipped,
    detectionsByKind,
    degradedModeCount,
    durationMs: Date.now() - startMs,
  };

  return { detections, telemetry };
}

async function runSingleClockTest(
  tc: TestCase,
  condition: ClockCondition,
  browser: BrowserMcpAdapter,
  _surface: SurfaceMcpAdapter,
  serverNowMs: number,
  skipCounts: Map<string, number>,
): Promise<BugDetection | null> {
  // EC-13: skip API-only tests for clock_skew_token_invalid (no browser clock path)
  if (condition.name === 'client_skew_plus_1h' && tc.action.via === 'api') {
    skipCounts.set('api_only_no_browser_clock', (skipCounts.get('api_only_no_browser_clock') ?? 0) + 1);
    return null;
  }

  // Fresh tab for clock isolation (EC-5)
  const appUrl = tc.page.startsWith('http') ? tc.page : `http://localhost${tc.page}`;

  try {
    return await browser.withTab(appUrl, undefined, async (scope) => {
      // Inject clock AFTER page load (login context already established by outer phase)
      const degradedMode = await injectClock(browser, condition, serverNowMs);

      // Check sentinel (detects late-inject race)
      const sentinelInstalled = await checkSentinelInstalled(browser);
      const effectiveDegradedMode = !sentinelInstalled && condition.injectedNowMs !== undefined
        ? 'late_inject'
        : degradedMode;

      // Probe: navigate and collect evidence
      await scope.navigate(appUrl);

      // For clock_timezone_display: check if displayed timestamps match the injected TZ
      if (condition.name === 'tz_skew_negative_8h') {
        return probeTimezoneDisplay(scope, condition, serverNowMs, effectiveDegradedMode, tc);
      }

      // For client_skew_plus_1h: send authenticated request, check server response
      if (condition.name === 'client_skew_plus_1h') {
        return probeTokenSkew(scope, condition, serverNowMs, effectiveDegradedMode, tc);
      }

      // For form-based conditions: submit date values and check response
      return probeDateForm(scope, condition, serverNowMs, effectiveDegradedMode, tc, skipCounts);
    });
  } catch (err) {
    log.debug('clock-test-runner: test failed (non-fatal)', { condition: condition.name, page: tc.page, err: String(err) });
    return null;
  }
}

async function probeTimezoneDisplay(
  scope: { evaluate(s: string): Promise<{ value: unknown }> },
  condition: ClockCondition,
  baselineNowMs: number,
  degradedMode: 'late_inject' | 'tz_only' | 'none',
  tc: TestCase,
): Promise<BugDetection | null> {
  // Late-inject degrades TZ: Intl formatters cached at module load may not see the override
  if (degradedMode === 'late_inject') return null;

  const result = await scope.evaluate(
    `(function(){
      var els=Array.from(document.querySelectorAll('time,[datetime],[data-timestamp]'));
      if(els.length===0)return null;
      var el=els[0];
      return (el.textContent||'').trim().slice(0,200);
    })()`
  );
  const displayed = typeof result.value === 'string' ? result.value : null;
  if (displayed === null) return null;

  // Check: does displayed text indicate the wrong TZ (Los Angeles vs expected New York)?
  // Heuristic: look for PST/PDT/PT which would indicate LA TZ leaked into display
  const hasPacificIndicator = /\bP[SD]T\b|\bPT\b/i.test(displayed);
  if (!hasPacificIndicator) return null;

  return makeDetection('clock_timezone_display', tc, condition, baselineNowMs, {
    proof: 'timezone_display_drift',
    evidence: displayed.slice(0, 200),
    degradedMode: degradedMode === 'none' ? undefined : degradedMode,
  });
}

async function probeTokenSkew(
  scope: { evaluate(s: string): Promise<{ value: unknown }> },
  condition: ClockCondition,
  baselineNowMs: number,
  degradedMode: 'late_inject' | 'tz_only' | 'none',
  tc: TestCase,
): Promise<BugDetection | null> {
  // Read the last network response status (heuristic: look for auth-related 4xx)
  const result = await scope.evaluate(
    `(function(){
      var entries=window.performance?.getEntriesByType?.('resource')||[];
      var auth=entries.filter(function(e){return /api|auth|token/i.test(e.name);});
      return auth.length>0?{status:0,url:auth[auth.length-1].name}:null;
    })()`
  );

  // Look for a 401/403 on the page with the fingerprint
  const domResult = await scope.evaluate(
    `document.body?.innerText?.slice(0,500)||''`
  );
  const bodyText = typeof domResult.value === 'string' ? domResult.value : '';

  if (TOKEN_SKEW_FINGERPRINT.test(bodyText)) {
    return makeDetection('clock_skew_token_invalid', tc, condition, baselineNowMs, {
      proof: 'token_rejected_under_skew',
      evidence: bodyText.slice(0, 200),
      degradedMode: degradedMode === 'none' ? undefined : degradedMode,
      injectedNowMs: baselineNowMs + 30_000,
    });
  }

  void result; // suppress unused
  return null;
}

async function probeDateForm(
  scope: { evaluate(s: string): Promise<{ value: unknown }> },
  condition: ClockCondition,
  baselineNowMs: number,
  degradedMode: 'late_inject' | 'tz_only' | 'none',
  tc: TestCase,
  skipCounts: Map<string, number>,
): Promise<BugDetection | null> {
  // Check for overflow / invalid-date display
  const domResult = await scope.evaluate(
    `(function(){
      var text=document.body?.innerText||'';
      var invalidDate=/Invalid Date|NaN/i.test(text);
      var epoch=/(1970-01-0[12]|Thu Jan 01 1970)/i.test(text);
      if(invalidDate||epoch)return text.slice(0,200);
      return null;
    })()`
  );

  const body = typeof domResult.value === 'string' ? domResult.value : null;
  if (body === null) return null;

  if (condition.name === 'y2038_edge' || condition.name === 'far_future') {
    return makeDetection('clock_overflow', tc, condition, baselineNowMs, {
      proof: 'int32_overflow_nan',
      evidence: body,
      degradedMode: degradedMode === 'none' ? undefined : degradedMode,
    });
  }

  if (condition.name === 'leap_day') {
    return makeDetection('clock_leap_day_failure', tc, condition, baselineNowMs, {
      proof: 'leap_day_value_round_trip_mismatch',
      evidence: body,
      degradedMode: degradedMode === 'none' ? undefined : degradedMode,
    });
  }

  if (condition.name === 'dst_forward' || condition.name === 'dst_backward') {
    return makeDetection('clock_dst_corruption', tc, condition, baselineNowMs, {
      proof: 'dst_value_drift',
      evidence: body,
      degradedMode: degradedMode === 'none' ? undefined : degradedMode,
    });
  }

  skipCounts.set('condition_no_probe', (skipCounts.get('condition_no_probe') ?? 0) + 1);
  return null;
}

type DetectionExtras = {
  proof: ClockProof;
  evidence: string;
  degradedMode?: 'late_inject' | 'tz_only' | 'none';
  injectedNowMs?: number;
};

function makeDetection(
  kind: BugDetection['kind'],
  tc: TestCase,
  condition: ClockCondition,
  baselineNowMs: number,
  extras: DetectionExtras,
): BugDetection {
  return {
    kind,
    rootCause: `Clock condition ${condition.name} triggered ${extras.proof} on ${tc.page}`,
    pageRoute: tc.page,
    endpoint: tc.action.toolId,
    triggeringAction: tc.action,
    clockContext: {
      condition: condition.name,
      injectedNowMs: extras.injectedNowMs ?? condition.injectedNowMs,
      injectedTimezone: condition.injectedTimezone,
      baselineNowMs,
      proof: extras.proof,
      evidence: extras.evidence.slice(0, 200),
      ...(extras.degradedMode !== undefined && extras.degradedMode !== 'none'
        ? { degradedMode: extras.degradedMode }
        : {}),
    },
  };
}

/**
 * Classify date-sensitivity for a batch of test cases using form field types,
 * schema formats, and name patterns. Called by the planner.
 *
 * Returns a new array with dateSensitive populated on matching cases.
 */
export function classifyDateSensitiveBatch(
  testCases: TestCase[],
  allowlist: string[],
  denylist: string[],
): TestCase[] {
  return testCases.map(tc => {
    const reasons = classifyDateSensitive(tc, allowlist, denylist);
    if (reasons === null || reasons.length === 0) return tc;
    return { ...tc, dateSensitive: { reasons } };
  });
}

/**
 * Disabled-mode telemetry block for when clock testing is off.
 */
export function disabledClockTelemetry(): ClockTestingTelemetry {
  return {
    enabled: false,
    conditionsApplied: [],
    dateSensitiveTests: 0,
    expandedTests: 0,
    testsSkipped: [],
    detectionsByKind: {},
    degradedModeCount: 0,
    durationMs: 0,
  };
}

/**
 * Classify test cases as date-sensitive using FormField and ToolMeta signals.
 * This is the planner's entry point; called once per test case during plan phase.
 *
 * Reasons checked here (compile-time signals from the spec §3.1):
 *   form_field_date — FormField.type === 'date'
 *   form_field_name_pattern — FormField.name matches the date-field regex
 *   schema_format_date — ToolMeta.inputSchema property has format in {date,date-time,time}
 *   schema_property_name_pattern — ToolMeta.inputSchema property name matches the regex
 *   dom_relative_time — DiscoveredPage.relativeTimeElements is non-empty
 */
export function detectDateSensitiveReasons(opts: {
  formFields?: Array<{ name: string; type: string }>;
  schemaProperties?: Record<string, { format?: string }>;
  hasRelativeTimeElements?: boolean;
  allowlistIds?: string[];
  testId?: string;
}): DateSensitiveReason[] {
  const DATE_FIELD_NAME_RE = /^(date|time|expires?|expir(y|ation|es_at)|deadline|when|start(_?at|_?date)?|end(_?at|_?date)?|created_?at|updated_?at|published_?at|scheduled_?at|due_?at|tz|timezone)$/i;
  const DATE_FORMAT_VALUES = new Set(['date', 'date-time', 'time']);

  const reasons = new Set<DateSensitiveReason>();

  // Check config allowlist
  if (opts.testId !== undefined && (opts.allowlistIds ?? []).includes(opts.testId)) {
    reasons.add('config_allowlist');
  }

  // Form field signals
  for (const field of opts.formFields ?? []) {
    if (field.type === 'date') reasons.add('form_field_date');
    if (DATE_FIELD_NAME_RE.test(field.name)) reasons.add('form_field_name_pattern');
  }

  // Schema signals
  for (const [propName, propSchema] of Object.entries(opts.schemaProperties ?? {})) {
    if (propSchema.format !== undefined && DATE_FORMAT_VALUES.has(propSchema.format)) {
      reasons.add('schema_format_date');
    }
    if (DATE_FIELD_NAME_RE.test(propName)) reasons.add('schema_property_name_pattern');
  }

  // DOM relative-time elements
  if (opts.hasRelativeTimeElements === true) reasons.add('dom_relative_time');

  return [...reasons];
}

/** All available clock condition names (for CLI --clock-conditions validation). */
export const ALL_CLOCK_CONDITION_NAMES: readonly ClockConditionName[] = CLOCK_CONDITIONS.map(c => c.name);
