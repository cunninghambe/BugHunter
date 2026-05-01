// Core domain types for BugHunter v0.1 — extended for v0.5 security & hygiene.

import type { NavigationEvent } from './adapters/cdp-session.js';
export type { NavigationEvent };

export type InputType =
  | 'text'
  | 'email'
  | 'number'
  | 'date'
  | 'select'
  | 'checkbox'
  | 'file'
  | 'boolean'
  | 'array'
  | 'tel'
  | 'url'
  | 'password'
  | 'color'
  | 'range'
  | 'slug'
  | 'foreign_id';

export type PaletteVariant = 'null' | 'happy' | 'edge' | 'out_of_bounds' | 'xss_inject';

export type BugKind =
  | 'console_error'
  | 'react_error'
  | 'hydration_mismatch'
  | 'network_5xx'
  | 'network_4xx_unexpected'
  | '404_for_linked_route'
  | 'missing_state_change'
  | 'unhandled_exception'
  | 'accessibility_critical'
  | 'dom_error_text'
  | 'surface_call_failed'
  | 'visual_anomaly'
  // v0.22 nav-state kinds
  | 'nav_state_corruption'
  | 'nav_resubmit_on_back'
  | 'nav_refresh_double_mutation'
  | 'nav_form_state_lost'
  | 'nav_form_state_stale'
  // v0.5 security / hygiene kinds
  | 'missing_csp_header'
  | 'permissive_cors'
  | 'cookie_security_flags'
  | 'csrf_missing_on_mutating_route'
  | 'open_redirect'
  | 'sensitive_data_in_url'
  | 'stack_trace_leak_in_response'
  | 'vulnerable_dependency_high'
  | 'hardcoded_credentials_in_source'
  | 'swallowed_error_empty_catch'
  | 'idor_horizontal'
  | 'idor_vertical_role_escalate'
  | 'auth_bypass_via_unauthed_route'
  | 'no_rate_limit_on_login'
  // v0.19 race-condition kinds (replaced v0.5 stubs race_double_submit + optimistic_update_divergence)
  | 'race_condition_double_submit'
  | 'race_condition_click_navigate'
  | 'race_condition_optimistic_revert'
  | 'race_condition_interleaved_mutations'
  | 'race_condition_cross_tab'
  | 'hallucinated_route'
  // v0.21 IDOR / horizontal-authz kinds (replace the v0.5 'idor_horizontal' umbrella)
  | 'idor_horizontal_read'
  | 'idor_horizontal_mutate'
  | 'idor_vertical_suspicious'
  // v0.16 active pen-testing kinds
  | 'sql_injection'
  | 'command_injection'
  | 'path_traversal'
  | 'jwt_weak_alg'
  // v0.7 XSS kinds
  | 'xss_reflected'
  | 'xss_dom'
  | 'xss_stored'   // placeholder; v0.8
  // v0.7 auth-flow kinds
  | 'auth_session_fixation'
  | 'password_reset_token_reuse'
  // v0.6 performance kinds
  | 'slow_lcp'
  | 'slow_inp'
  | 'high_cls'
  | 'unbounded_list_render'
  | 'n_plus_one_api_calls'
  | 'request_dedup_missing'
  | 'request_cancellation_missing'
  | 'main_thread_blocked'
  | 'oversized_bundle'
  | 'excessive_re_renders'
  | 'memory_leak_suspected'
  | 'memory_leak_attributed'
  // v0.6 a11y baseline kinds
  | 'axe_color_contrast_strong'
  | 'keyboard_trap'
  | 'focus_lost_after_action'
  | 'image_missing_alt'
  | 'form_input_unlabeled'
  // v0.12 click-evaluate kinds
  | 'interactive_element_missing_accessible_name'
  // v0.6 SEO hygiene kinds
  | 'seo_title_missing'
  | 'seo_title_duplicate_across_routes'
  | 'seo_meta_description_missing'
  | 'seo_canonical_missing'
  | 'seo_h1_missing_or_multiple'
  | 'seo_robots_blocking_crawl';

/**
 * v0.19 back-compat alias: old v0.5 JSONL records used these kinds.
 * The store migration layer rewrites them on read. Do not use for new detections.
 */
export type OldRaceKinds = 'race_double_submit' | 'optimistic_update_divergence';

/** v0.29: four-level severity assigned per BugKind in DETECTOR_REGISTRY. */
export type Severity = 'critical' | 'major' | 'minor' | 'info';

/** v0.29: coarse exploitability hint surfaced into SARIF / Linear / Jira output. */
export type ExploitabilityModel = 'easy' | 'medium' | 'hard' | 'na';

export type SideEffectClass = 'safe' | 'mutating' | 'external';
export type InputSchemaConfidence = 'introspected' | 'inferred' | 'unknown' | 'partial';
export type ResetPolicy = 'transactional' | 'per-test' | 'per-page' | 'per-run';

export type ExpectedOutcome = 'success' | 'expected_failure' | 'unknown';

export type ActionKind = 'click' | 'fill' | 'navigate' | 'render' | 'submit' | 'api_call' | 'nav_transition';
export type ActionVia = 'ui' | 'api';

// v0.22: discriminated union of nav transition kinds (§3.1 / §3.2).
export type NavTransition =
  | { kind: 'refresh' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'back_then_forward' }
  | { kind: 'deep_link_no_auth'; capturedUrl: string }
  | { kind: 'history_corrupt'; pushStates: Array<{ state: unknown; url?: string }> };

export type Action = {
  kind: ActionKind;
  /**
   * CSS selector for the element to interact with. For `kind: 'submit'`, this is
   * the form-element selector (e.g. `#login-form` or `form:nth-of-type(1)`),
   * NOT the submit button — the submit button is resolved at execute time.
   */
  selector?: string;
  via: ActionVia;
  expectedOutcome: ExpectedOutcome;
  palette: PaletteVariant;
  toolId?: string;
  /**
   * Input payload for the action. For `kind: 'submit'`, this MUST be a
   * `Record<string, unknown>` whose keys are HTML field `name` attributes and
   * whose values are coerced to strings by `runFormSubmit`. The runtime guard
   * `isStringKeyedRecord` enforces this at the execute call site.
   */
  input?: unknown;
  /** When set, the test plants this nonce in input and expects no XSS reflection. */
  injectionNonce?: string;
  /**
   * v0.22: set only when kind === 'nav_transition'. Discriminated union describing
   * which transition to drive (back, forward, refresh, deep-link, history-corrupt).
   */
  transition?: NavTransition;
  /**
   * v0.22: set only when kind === 'nav_transition'. The seed action run before the
   * transition fires. The executor dispatches it through the normal action switch.
   */
  navSeed?: Action;
  /**
   * v0.22: set only when kind === 'submit' and this action is used as a nav-state
   * seed for back-after-form-fill. When true, runFormSubmit fills fields but does
   * not submit. This lets us test whether the browser preserves filled-but-unsubmitted
   * inputs when the user navigates away and comes back.
   */
  fillOnly?: boolean;
};

export type PreState = {
  url: string;
  title: string;
  consoleErrorCount: number;
  /**
   * v0.22: SHA-1 (20-hex) over visible text of <main>/[role="main"].
   * Populated for nav-state tests; undefined on regular tests.
   */
  domSignature?: string;
};

/**
 * v0.22: captured after the nav-state seed action settles and before the transition
 * fires. Only populated on TestResult when tc.action.kind === 'nav_transition'.
 */
export type InterimState = {
  url: string;
  /** SHA-1 hex over visible-text content of <main> / [role="main"] element. */
  domSignature: string;
  inFlightRequests: Array<{ method: string; path: string; startedAtMs: number }>;
  /** Populated when the seed was a fill or submit action. field-name → typed value. */
  formSnapshot?: Record<string, string>;
  mutationCompletionSignal: 'response-200ish' | 'response-error' | 'still-pending' | 'no-network';
};

export type NetworkRequest = {
  method: string;
  path: string;
  status: number;
  duration: number;
  responseBodySnippet?: string;
};

export type ConsoleError = {
  level: 'error';
  text: string;
  stack?: string;
};

export type PostState = {
  url: string;
  title: string;
  consoleErrors: ConsoleError[];
  networkRequests: NetworkRequest[];
  domErrorTextDetected: boolean;
  mutationObserverWindowMs: number;
  /**
   * v0.22: SHA-1 (20-hex) over visible text of <main>/[role="main"].
   * Populated by nav-transition-runner after transition settles.
   * Undefined on non-nav-state tests.
   */
  domSignature?: string;
};

export type OccurrenceSummary = {
  occurrenceId: string;
  /** testId of the TestResult that produced this occurrence. Optional for backward-compat with old JSONL artifacts. */
  testId?: string;
  role: string;
  page: string;
  action: Action;
  fullArtifacts: false;
  timestamp: string;
  secondaryObservations?: SecondaryObservation[];
};

export type SecondaryObservation = {
  kind: BugKind;
  detail: string;
};

export type OccurrenceFull = {
  occurrenceId: string;
  /** testId of the TestResult that produced this occurrence. Optional for backward-compat with old JSONL artifacts. */
  testId?: string;
  role: string;
  page: string;
  action: Action;
  preState: PreState;
  postState: PostState;
  fullArtifacts: true;
  screenshotPath: string;
  domSnapshotPath: string;
  consoleLogPath: string;
  networkLogPath: string;
  actionLogPath: string;
  reproSteps: string[];
  replayCommand: string;
  secondaryObservations?: SecondaryObservation[];
};

export type Occurrence = OccurrenceFull | OccurrenceSummary;

export type ReplayKind = 'action_log' | 'static_rerun' | 'unrunable';

/**
 * v0.46: promoted from bare string to structured type so the VSCode extension
 * can annotate specific lines.
 */
export type SuspectedFile = {
  path: string;
  line?: number;
  reason?: string;
};

/**
 * v0.46: union allows reading JSONL written before v0.46 (bare strings) alongside
 * the new structured format. Normalise with `suspectedFilePath(f)`.
 * Write path always emits `SuspectedFile` objects.
 */
export type SuspectedFileLike = string | SuspectedFile;

/** Extract the path string from either a legacy string entry or a v0.46 SuspectedFile. */
export function suspectedFilePath(f: SuspectedFileLike): string {
  return typeof f === 'string' ? f : f.path;
}

export type BugCluster = {
  id: string;
  runId: string;
  kind: BugKind;
  rootCause: string;
  stackTraceFingerprint?: string;
  errorMessageNormalized?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clusterSize: number;
  occurrences: Occurrence[];
  /** v0.46: may be string[] (legacy) or SuspectedFile[] (v0.46+). Always normalise with suspectedFilePath(). */
  suspectedFiles: SuspectedFileLike[];
  fixHints: string[];
  thirdPartyOrGenerated: boolean;
  verdict?: ClusterVerdict;
  /** Cluster ids that share a normalized route via a different kind (e.g. 404 ↔ surface_call_failed). */
  relatedClusterIds?: string[];
  /** Discriminates the retest dispatch path: action-log replay, static-tool re-run, or not retestable. */
  replayKind?: ReplayKind;
  /** Stable cluster-signature key stored at mint time; used by static-rerun path to match fresh detections. */
  signatureKey?: string;
  /** v0.27: stable 16-char hex identity derived from sha256(projectName + ' ' + signatureKey). Absent on pre-V27 clusters. */
  bugIdentity?: string;
  /** v0.29: decorated at emit time from DETECTOR_REGISTRY. Optional for backward-compat with old JSONL artifacts. */
  severity?: Severity;
};

export type ClusterVerdict =
  | 'verified_fixed'
  | 'verified_fixed_by_removal'
  | 'not_fixed'
  | 'partially_verified'
  | 'architect_refused';

export type RetestVerdict =
  | 'verified_fixed'
  | 'verified_fixed_by_removal'
  | 'partially_verified'
  | 'not_fixed'
  | 'bugs_lost_to_revision'
  | 'verified_fixed_static'
  | 'not_fixed_static'
  | 'partially_verified_static'
  | 'cannot_retest';

export type BugsSkippedReason =
  | 'third_party_or_generated'
  | 'touched_forbidden_path'
  | 'claude_refused'
  | 'architect_refused';

export type BugsSkipped = {
  reason: BugsSkippedReason;
  paths?: string[];
  detail?: string;
};

export type InfrastructureFailure = {
  id: string;
  runId: string;
  timestamp: string;
  kind: 'timeout' | 'browser_crash' | 'surface_unreachable' | 'revision_changed' | 'browser_element_not_found' | 'generic';
  detail: string;
  role?: string;
  page?: string;
  action?: Action;
};

// ToolMeta from SurfaceMCP § 4.1
export type ToolMeta = {
  name: string;
  toolId: string;
  method: string;
  path: string;
  inputSchema: JsonSchema;
  inputSchemaConfidence: InputSchemaConfidence;
  outputSchema?: JsonSchema;
  sideEffectClass: SideEffectClass;
  sourceFile: string;
  sourceLine: number;
  sourceFunctionName?: string;
  isServerAction: boolean;
};

export type JsonSchema = {
  type?: string;
  format?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type Element = {
  tag: string;
  roleAttr?: string;
  typeAttr?: string;
  testId?: string;
  ancestorStack: string;
  selector: string;
  disabled: boolean;
  href?: string;
  formId?: string;
  text?: string;
};

export type FormField = {
  name: string;
  type: InputType;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
};

export type DiscoveredForm = {
  formSelector: string;
  fields: FormField[];
  action?: string;
  method: string;
  apiToolIds?: string[];
};

export type NavSource =
  | 'static-page'
  | 'static-navigation'
  | 'runtime-enum'
  | 'crawl-link'
  | 'crawl-seed';

export type TriggerSelectorHint = {
  text?: string;
  testId?: string;
  ariaLabel?: string;
};

export type DiscoveredPage = {
  route: string;
  sourceFile?: string;
  elements: Element[];
  forms: DiscoveredForm[];
  links: string[];
  /** Discriminates URL-routed pages from tab-state click-to-reach pages. Default 'url'. */
  kind?: 'url' | 'state';
  /** Present iff kind === 'state'. */
  stateContext?: {
    baseRoute: string;
    stateVar: string;
    stateValue: string;
    triggerHint: TriggerSelectorHint;
  };
  /** Telemetry: which source produced this page. */
  navSource?: NavSource;
};

export type VisionSeverity = 'minor' | 'major' | 'critical';
export type VisionCategory = 'layout' | 'content' | 'state' | 'error' | 'a11y' | 'other';

export type VisionConfig = {
  /** Master switch. Default: false (opt-in). */
  enabled?: boolean;
  /** Anthropic model id. Default: 'claude-sonnet-4-6'. */
  model?: string;
  /**
   * Anthropic API key. PREFERRED location is the ANTHROPIC_API_KEY env var.
   * Use this field only if env var is unavailable; do not commit the key.
   */
  apiKey?: string;
  /** Per-run cap on API calls. Default: 100. Hard ceiling; calls beyond skip. */
  maxCalls?: number;
  /** Per-run cost ceiling in USD. Default: 20. Halts vision when cumulative estimated cost exceeds this. */
  maxCostUsd?: number;
  /** Concurrency cap for vision calls (independent of browser concurrency). Default: 4. */
  concurrency?: number;
  /**
   * Severity below this is filtered out and never becomes a BugDetection.
   * Default: 'major'. 'minor' is intentionally not exposed as a default —
   * minor anomalies are noisy by construction. 'critical' is for ultra-strict runs.
   */
  severityThreshold?: VisionSeverity;
  /**
   * Milliseconds to wait after navigating to a route before taking a screenshot.
   * Covers Vite lazy-chunk cold-start, Zustand persist hydration, and SPA data fetches.
   * Default: 2500. Must be a positive integer. Minimum effective value is VISION_BASELINE_SETTLE_MS (1500).
   */
  preScreenshotSettleMs?: number;
  /**
   * Number of times to run each unique screenshot through the classifier.
   * Default: 2. Max: 5. Set to 1 to disable consistency checking.
   */
  consistencyRuns?: number;
  /**
   * How to aggregate anomalies across the N consistency runs.
   * - 'strict': all N runs must agree on the anomaly (unanimous).
   * - 'majority': >= ceil(N/2) runs must agree.
   * Default: 'strict' when consistencyRuns >= 2; ignored when consistencyRuns === 1.
   */
  agreementMode?: 'strict' | 'majority';
  /**
   * Viewport widths (px) to capture per page, smallest-to-largest.
   * Default: [375, 768, 1280]. Each width maps to height = round(width * 0.65).
   */
  viewports?: number[];
};

export type VisualBaselineEntry = {
  page: DiscoveredPage;
  detection: BugDetection;
  screenshotPath: string;
};

export type CrawlTelemetry = {
  seedRoutes: number;
  staticNavigations: number;
  runtimeEnumRoutes: number;
  crawlLinkRoutes: number;
  visitedPages: number;
  stateKindPages: number;
};

export type ProbeTelemetryRecord = {
  probesRun: number;
  skippedByBudget: number;
  durationMs: number;
};

export type VisionBaselineTelemetry = {
  uniqueScreenshots: number;
  dedupedScreenshots: number;
  authLostMidLoop: boolean;
  screenshotsTooSmall: number;
};

/** Accumulated consistency telemetry across all screenshots in a run phase. */
export type VisionConsistencyTelemetry = {
  runsPerScreenshot: number;
  agreementMode: 'strict' | 'majority';
  totalCalls: number;
  totalSucceeded: number;
  droppedByDisagreement: number;
  /** Weighted average agreement rate across screenshots that had ≥1 anomaly in any run. */
  agreementRate: number;
  screenshotsWithAnomalies: number;
  screenshotsClean: number;
};

export type DiscoveryOutput = {
  pages: DiscoveredPage[];
  apiTools: ToolMeta[];
  skipList: SkippedItem[];
  visualBaselineDetections?: VisualBaselineEntry[];
  crawlTelemetry?: CrawlTelemetry;
  /** Detections from static-analysis tools (gitleaks, npm-audit, semgrep, eslint-no-empty). */
  staticDetections?: BugDetection[];
  /** Form-reachability probe telemetry — present when probe ran. */
  probe?: { telemetry: ProbeTelemetryRecord };
  /** Vision baseline pass telemetry — present when vision is enabled. */
  visionBaselineTelemetry?: VisionBaselineTelemetry;
  /** v0.15 consistency telemetry — present when vision is enabled. */
  visionConsistencyTelemetry?: VisionConsistencyTelemetry;
  /** v0.17 per-viewport vision telemetry — present when vision is enabled. */
  visionByViewport?: Record<number, { uniqueScreenshots: number; anomaliesFound: number; deduped: number }>;
  /**
   * v0.25: dynamic routes for which no discoveryFixtures row was found.
   * Serialisable as string[]; convert to Set at the execute call site.
   * These routes are excluded from hallucinated-route detection.
   */
  fixtureUnresolvableRoutes?: string[];
};

export type SkippedItem = {
  route?: string;
  toolId?: string;
  reason: string;
};

export type TestCase = {
  id: string;
  runId: string;
  role: string;
  page: string;
  action: Action;
  expectedOutcome: ExpectedOutcome;
  palette: PaletteVariant;
  formSignature?: string;
  elementSignature?: string;
  /**
   * Set when the test case was discovered on a state-page (kind: 'state').
   * Execute uses this to navigate to baseRoute and re-issue the trigger click
   * before running the action — the synthetic `page` route ("/?setTab=trades")
   * is a dedup key, NOT a literal URL the SPA honours. Skipped for navigate actions.
   */
  stateContext?: {
    baseRoute: string;
    stateVar: string;
    stateValue: string;
    triggerHint: TriggerSelectorHint;
  };
  /**
   * v0.19 race-condition: present when this test case is a race interleaving test.
   * Executor branches on this field → executeRaceTest instead of runUiTest.
   */
  race?: { variant: InterleavingVariant };
};

export type TestResult = {
  testId: string;
  /**
   * Stable id minted by the executor at test start. Used as the filename
   * for action-log + screenshot + DOM + console + network artifacts:
   *   action-logs/<occurrenceId>.json
   *   screenshots/<occurrenceId>.png
   *   dom/<occurrenceId>.html
   *   console/<occurrenceId>.log
   *   network/<occurrenceId>.har
   * The cluster phase reuses this id when materializing OccurrenceFull,
   * so that the recorded artifact paths point to files that exist.
   * Always set; never undefined.
   */
  occurrenceId: string;
  passed: boolean;
  bugs: BugDetection[];
  infrastructureFailure?: InfrastructureFailure;
  durationMs: number;
  /** Captured by executeUiTest; undefined for API tests. */
  preState?: PreState;
  /** Captured by executeUiTest; undefined for API tests. */
  postState?: PostState;
  /**
   * v0.22: populated only for nav_transition test cases. Captures the state
   * after the seed action settles and before the transition fires.
   */
  interimState?: InterimState;
};

/** Context populated by the header-probe module for header/cookie/CSRF findings. */
export type HeaderContext = {
  headerName: string;
  observedValue?: string;
  expectedShape: string;
};

/** Context populated by the IDOR cross-user phase. */
export type IdorContext = {
  sourceRole: string;
  targetRole: string;
  resourceField: string;
  resourceValue: string;
  // v0.21 additions
  resourceType?: string;          // 'order', 'invoice', '_unknown', ...
  mutating?: boolean;             // true for idor_horizontal_mutate
  tier?: 'peer' | 'cross';        // peer-tier or cross-tier replay
  sourceTier?: string;            // tier number or name when idor.tiers is set
  targetTier?: string;
  /** Set when this finding requires user adjudication. Drives the skill UX. */
  requiresAdjudication?: boolean; // true for idor_vertical_suspicious
};

/** Context populated by the static-analysis runner for source-code findings. */
export type StaticContext = {
  tool: string;
  ruleId: string;
  sourceFile: string;
  sourceLine?: number;
};

/** Context populated by auth-flow detectors. */
export type AuthFlowContext = {
  /** What the detector was checking. */
  invariant: 'session_id_rotates' | 'reset_token_single_use' | 'redirect_param_validates';
  /** For session_fixation: cookie name observed. */
  cookieName?: string;
  /** For session_fixation: pre/post values (truncated to 8 chars for log safety). */
  preValuePrefix?: string;
  postValuePrefix?: string;
  /** For password_reset: how many times the same token was redeemed successfully. */
  reuseCount?: number;
  /** For open_redirect: which param accepted off-origin. */
  paramName?: string;
  /** The off-origin target that succeeded. */
  redirectTarget?: string;
};

// --- v0.16 pen-testing types ---

/**
 * Context populated for active pen-testing findings.
 * Present on: sql_injection, command_injection, path_traversal, jwt_weak_alg.
 */
export type InjectionDetectionContext = {
  /** Form field or URL param name that accepted the payload. */
  paramName: string;
  /** Variant name (e.g. 'error_quote', 'shell_pipe_echo'). */
  variant: string;
  /** 16-char hex nonce embedded in the payload. */
  nonce: string;
  /**
   * Proof kind.
   * 'error_string': nonce found inside SQL error message in response.
   * 'boolean_difference': true/false tautologies produced different response sizes (≥30%).
   * 'output_marker': nonce literally echoed in response body (command injection).
   * 'file_content': /etc/passwd or win.ini fingerprint found in 2xx response (path traversal).
   * 'unsigned_accepted': alg=none JWT accepted on a requiresAuth endpoint.
   * 'weak_secret_<value>': HS256 token forged with a known-weak secret was accepted.
   * 'rs_to_hs_confusion': HS256 token signed with public RSA key was accepted.
   */
  proof: string;
  /** Up to 200-char snippet of the matching response substring. */
  evidence: string;
};

export type PenTestingConfig = {
  /** Master switch. Default: false (probing is actively mutating). */
  enabled?: boolean;
  /** Which probe buckets to run. Default: all four. */
  variants?: Array<'sql' | 'cmd' | 'path' | 'jwt'>;
  /** Max probes per endpoint. Default: 25 (5 variants × 5 BugKinds). */
  maxProbesPerEndpoint?: number;
  /**
   * Minimum fractional difference in response body length to trigger boolean SQL detection.
   * Default: 0.3 (30%).
   */
  booleanDeltaThreshold?: number;
  /**
   * Endpoint paths to probe with JWT weak-algorithm variants.
   * If unset, JWT probes are skipped with skipReason 'no_jwt_targets'.
   */
  jwtTargets?: string[];
  /**
   * Path to the server's RSA public key PEM file.
   * Required for the key_confusion_rs_to_hs JWT variant.
   * If unset, that variant is skipped.
   */
  jwtPublicKeyPemPath?: string;
};

export type PenTestingTelemetry = {
  enabled: boolean;
  probesAttempted: number;
  probesSucceeded: number;
  probesThrottled: number;
  probesSkipped: { reason: string; count: number }[];
  detectionsByKind: Record<string, number>;
  durationMs: number;
};

// --- v0.6 performance types ---

export type WebVitalSample = {
  name: 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  /** When the sample was captured relative to action start (ms). */
  capturedAtMs: number;
};

export type LongTaskSample = {
  /** ms duration of the long task */
  duration: number;
  /** ms relative to action start */
  startTime: number;
};

export type HeapSample = {
  /** ms relative to action start */
  capturedAtMs: number;
  /** bytes */
  jsHeapUsedSize: number;
  jsHeapTotalSize: number;
};

export type RenderEvent = {
  /** Component display name (best-effort; "Anonymous" if missing). */
  component: string;
  /** ms relative to action start */
  capturedAtMs: number;
};

export type PerfArtifacts = {
  occurrenceId: string;
  webVitals: WebVitalSample[];
  longTasks: LongTaskSample[];
  heapSamples: HeapSample[];
  renderEvents: RenderEvent[];
  /** V24: navigation events captured by CDP framenavigated listener. Required by classifyCancelMissing.
   *  Optional for back-compat with pre-V24 PerfArtifact fixtures; treat as [] when absent. */
  navigationEvents?: NavigationEvent[];
  /** Console errors collected via CDP Console.messageAdded (hydration-mismatch redundancy path). */
  cdpConsoleErrors?: ConsoleError[];
};

export type HeapSnapshotRaw = {
  capturedAtMs: number;
  /** V8 heap-snapshot JSON; gzipped on disk, parsed in-memory */
  json: string;
};

export type BundleArtifact = {
  path: string;
  kind: 'js' | 'css' | 'html' | 'asset';
  bytesRaw: number;
  bytesGzipped: number;
  initialRoute: boolean;
};

export type BundleProbeConfig = {
  enabled: boolean;
  jsThresholdGzipBytes: number;
  cssThresholdGzipBytes: number;
  searchPaths?: string[];
};

/** Context populated by XSS detection. */
export type XssContext = {
  /** The canary variant that fired ('script_tag_basic', etc.). */
  variant: string;
  /** Where the canary was planted. */
  injectionPoint: 'form_field' | 'url_param' | 'json_body';
  /** Field name (form input name, URL param name, JSON key). */
  fieldName: string;
  /** Where the canary appeared / executed. */
  sink: 'reflected_html' | 'reflected_attr' | 'reflected_script' | 'dom_inserted' | 'window_assign';
  /** 16-char nonce for traceability. */
  nonce: string;
};

export type BugDetection = {
  kind: BugKind;
  rootCause: string;
  stackTrace?: string;
  consoleErrors?: ConsoleError[];
  networkRequests?: NetworkRequest[];
  status?: number;
  endpoint?: string;
  responseBodyShape?: string;
  pageRoute?: string;
  selectorClass?: string;
  triggeringAction?: Action;
  targetPath?: string;
  a11yViolations?: unknown[];
  secondaryObservations?: SecondaryObservation[];
  // visual_anomaly only:
  visualCategory?: VisionCategory;
  visualSeverity?: VisionSeverity;
  visualSuggestedFix?: string;
  /** Path to the screenshot that produced this detection. Always set when kind === 'visual_anomaly'. */
  screenshotPath?: string;
  /** v0.17: viewport context for visual_anomaly detections. */
  visualContext?: {
    viewportPx?: number;
  };
  /** Populated for header/cookie/CSRF security findings. */
  headerContext?: HeaderContext;
  /** Populated for IDOR cross-user findings. */
  idorContext?: IdorContext;
  /** Populated for static-analysis findings. */
  staticContext?: StaticContext;
  /** Populated for XSS findings. */
  xssContext?: XssContext;
  /** Populated for auth-flow findings. */
  authFlowContext?: AuthFlowContext;
  /** Populated for v0.16 active pen-testing findings (sql_injection, command_injection, path_traversal, jwt_weak_alg). */
  injectionContext?: InjectionDetectionContext;
  /** Populated for v0.19 race-condition findings (race_condition_*). */
  raceContext?: RaceDetectionContext;
  /** Populated for v0.6 performance findings; shape varies by BugKind. */
  evidence?: Record<string, unknown>;
  /** Populated for v0.8 heap-snapshot attribution findings. */
  heapContext?: {
    constructorName: string;
    instanceCountDelta: number;
    retainedSizeDelta: number;
    retainerChain: string[];
    diffWindow: { beforeActionIdx: number; afterActionIdx: number };
    largeTimeGap?: boolean;
  };
  /** Populated for v0.6 SEO hygiene findings. */
  seoContext?: {
    field: 'title' | 'meta_description' | 'canonical' | 'h1' | 'robots_meta' | 'robots_txt';
    observedValue: string | null;
    expectedShape: string;
    affectedRoutes?: string[];
  };
  /**
   * v0.22: populated for nav-state findings. Carries the transition kind,
   * mismatch kind (for nav_state_corruption), and staleField (for nav_form_state_stale)
   * needed for cluster signature derivation (§4.2).
   */
  navStateContext?: {
    transitionKind: NavTransition['kind'];
    seedActionKind?: ActionKind;
    mismatchKind?: 'url' | 'dom' | 'render-empty';
    staleField?: string;
    formSignature?: string;
    endpoint?: string;
  };
  /** Populated for v0.6 a11y baseline findings. */
  a11yContext?: {
    axeRuleId?: string;
    observedFocusChain?: string[];
    pressCount?: number;
    triggeringSelector?: string;
    activeElementTag?: string | null;
  };
};

export type RunPhase =
  | 'validate'
  | 'discover'
  | 'plan'
  | 'execute'
  | 'classify'
  | 'cluster'
  | 'analyze'
  | 'emit'
  | 'done';

/**
 * Resource IDs harvested per role during execute phase for cross-user IDOR probing.
 * Outer key: role name. Middle key: field name (e.g. "tradeId"). Inner: unique values.
 */
export type DiscoveredIds = Map<string, Map<string, Set<string>>>;

export type RunState = {
  runId: string;
  projectDir: string;
  startedAt: string;
  phase: RunPhase;
  surfaceRevision?: number;
  resetCommandLastRun?: string;
  config: BugHunterConfig;
  discovery?: DiscoveryOutput;
  testCases?: TestCase[];
  testResults?: TestResult[];
  clusters?: BugCluster[];
  clusterCount: number;
  skipReasons?: Array<{ reason: string; count: number }>;
  infraFailureCount: number;
  consecutiveInfraFailures: number;
  emitted: boolean;
  partialEmit: boolean;
  /** Resource IDs harvested during execute for cross-user IDOR replay. Populated by execute phase. */
  discoveredIds?: DiscoveredIds;
  /**
   * v0.21: per-(role, resourceType) fixture ids for cross-role IDOR replay.
   * Derived from discoveredIds at the start of runCrossUser with v0.21 filters applied.
   * Not persisted to state.json — reconstructed from discoveredIds on resume.
   */
  roleFixtures?: Map<string, Map<string, Set<string>>>;
};

export type BrowserLoginConfig = {
  /** When false, skip browser-login entirely (anonymous-only discovery). Default: true. */
  enabled?: boolean;
  /**
   * Which role to log in as. Defaults to the first credentialed role from `roles[]`.
   */
  role?: string;
  /** Max wait after submit-click for successCheck to be satisfied. Default: 10000ms. */
  verifyTimeoutMs?: number;
  /** Polling interval for cookie-jar / URL checks during verification. Default: 500ms. */
  verifyPollMs?: number;
};

export type CrawlConfig = {
  /**
   * Auto-derived from SurfaceMCP source: 'crawl_seed'. Set to false to disable
   * crawl entirely (e.g. for projects where the seed is wrong). Default: undefined (auto).
   */
  enabled?: boolean;
  /** Max distinct pages to visit (including the seed). Default: 50. */
  maxPages?: number;
  /** Max link-follow depth from the seed. Seed is depth 0. Default: 3. */
  maxDepth?: number;
  /**
   * If true, query strings are kept as part of the dedup/visit key.
   * If false (default), query strings are stripped before dedup.
   */
  followQueryParams?: boolean;
  /** Per-page DOM-walk timeout ms. Default: 30000. */
  walkTimeoutMs?: number;
  /** Same-origin only. Default: true. */
  sameOriginOnly?: boolean;
  /** Include confidence:'low' navigations from surface_list_navigations. Default: false. */
  includeLowConfidence?: boolean;
  /** Settle delay (ms) after clicking a state-trigger before snapshotting. Default: 250. */
  stateSettleMs?: number;
  /** Disable runtime route enumeration. Default: false (enabled). */
  disableRuntimeEnum?: boolean;
  /** Cap on state-kind queue items to prevent runaway tab-state crawls. Default: 30. */
  maxStateNavigations?: number;
};

export type StaticAnalysisConfig = {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Minimum npm advisory severity to report. Default: 'high'. */
  npmAudit?: { minSeverity?: 'high' | 'critical' };
  /** Path to per-project allowlist file for static findings. */
  allowFile?: string;
  /** Glob pattern for frontend source files (hallucinated-route). Default: 'src/**\/*.{ts,tsx,js,jsx}'. */
  frontendSourceGlob?: string;
};

export type HeadersConfig = {
  /** Master switch for header probing. Default: true. */
  enabled?: boolean;
  /** CSP-specific overrides. */
  csp?: {
    /** Severity for unsafe-inline weakness. Default: 'informational'. */
    severityForUnsafeInline?: 'informational' | 'major';
    /** Skip CSP checks on localhost. Default: 'skip'. */
    localhostMode?: 'skip' | 'flag';
  };
  /** Cookie flag overrides. */
  cookies?: {
    /** How to handle Secure flag absence on localhost. Default: 'skip'. */
    localhostMode?: 'skip' | 'flag';
  };
  /** CSRF cookie name patterns. Default: ['csrf', 'xsrf', '_csrf']. */
  csrf?: { cookieNamePatterns?: string[] };
  /** Open-redirect param names to probe. */
  redirect?: { paramNames?: string[] };
  /** Sensitive URL param patterns. */
  sensitiveUrl?: { paramPatterns?: string[] };
  /** Stack-trace fingerprint segment count. Default: 3. */
  stackTrace?: { frameFingerprintLength?: number };
  /** Max origins to probe per run. Default: 100. */
  maxHeaderProbes?: number;
};

export type AuthProbeConfig = {
  /** Master switch. Default: false. Must be enabled via --enable-auth-probes. */
  enabled?: boolean;
  /** Max login attempts per probe run. Default: 50. */
  maxAttempts?: number;
  /** Sacrificial endpoint for rate-limit discovery. */
  sacrificialEndpoint?: string;
  /** Username for throwaway probe account. Default: 'bughunter-probe-user@invalid.test'. */
  testAccountUsername?: string;
};

export type SyntheticConfig = {
  /** Master switch. Default: false (scenarios mutate state). */
  enabled?: boolean;
  /** Specific scenarios to run. Omit to run all. */
  scenarios?: Array<'race_double_submit' | 'optimistic_update_divergence' | 'no_rate_limit_on_login'>;
  /** Allow destructive scenarios even on per-run reset policy. Default: false. */
  allowDestructiveOnPerRunReset?: boolean;
  /** Optimistic-divergence: minimum HTTP status to flag as failure. Default: 400. */
  optimisticDivergence?: { statusThreshold?: number };
  /**
   * @deprecated Use `raceConditions` instead. Kept for one minor release; a warning
   * is emitted at config-load if set. Routes to RaceConditionsConfig.doubleSubmitGapMs.
   */
  raceDoubleSubmit?: { intervalMs?: number };
};

export type AuthFlowConfig = {
  /** Master switch. Default: false (opt-in). */
  enabled?: boolean;
  /** Which sub-checks to run. Defaults: all. */
  checks?: Array<'session_fixation' | 'password_reset_reuse' | 'open_redirect'>;
  /** Email used for password-reset probes. Default: config.authProbe.testAccountUsername. */
  testEmail?: string;
  /** For open_redirect: param names to test. */
  redirectParamNames?: string[];
  /** For open_redirect: routes to probe explicitly. */
  redirectRoutes?: string[];
  /** For open_redirect: max routes to probe. Default: 30. */
  maxRedirectProbes?: number;
  /** For password_reset_reuse: tool/route id of the request-reset endpoint. */
  requestResetToolId?: string;
  /** For password_reset_reuse: tool/route id of the consume-reset endpoint. */
  consumeResetToolId?: string;
  /** For session_fixation: max wait for cookie capture in ms. Default: 5000. */
  cookieCaptureTimeoutMs?: number;
};

export type XssConfig = {
  /** Master switch. Default: true (opt-out). */
  enabled?: boolean;
  /** Palette depth. Default: 'minimal' (5 payloads). 'full' = 12. */
  depth?: 'minimal' | 'full';
  /** Cap on XSS test cases per run. Default: 200. */
  maxTestCases?: number;
  /** Routes to skip entirely (matched as glob). Default: []. */
  excludedRoutes?: string[];
  /** When true, also mutate JSON request body fields. Default: true. */
  mutateJsonBodies?: boolean;
};

export type CrossUserConfig = {
  /** Enable cross-role IDOR probing. Default: true. */
  crossRoleProbeEnabled?: boolean;
  /** Enable anonymous-user probing. Default: true. */
  anonymousProbeEnabled?: boolean;
  /** Max replay attempts. Default: 200. */
  maxReplays?: number;
  /** Hints for which roles are admin. Default: ['admin', 'owner', 'superuser']. */
  adminRoleHints?: string[];
};

/** v0.21 IDOR / horizontal-authz configuration. */
export type IdorConfig = {
  /** Master switch. True when --security or --idor; false otherwise. */
  enabled?: boolean;
  /** Role-to-tier map. Higher = more privileged. Falls back to adminRoleHints. */
  tiers?: Record<string, number>;
  /** Explicit peer pairs. Overrides auto-inference for the listed pairs only. */
  peerRoles?: Array<[string, string]>;
  /** Cross-tier directions that are by-design; suppressed entirely at classify-time. */
  legitimizedHierarchies?: Array<{ from: string; to: string }>;
  /** Resource types where cross-role access is intentional (skipped in collect + replay). */
  skipResources?: string[];
  /** ToolIds excluded from fixture collection (extends the baked-in deny-list). */
  skipFixtureFromTools?: string[];
  /** Per-tool resource-type overrides. Wins over heuristics. */
  resourceTypeOverrides?: Record<string, string>;
  /** Per-URL-pattern resource-type overrides. Wins over heuristic, loses to per-tool. */
  resourceTypeOverridesByPath?: Record<string, string>;
  /** Cap fixtures per (role, resourceType). Default: 5. */
  maxFixturesPerRoleResource?: number;
  /** Cap total swap replays. Default: 400. */
  maxReplays?: number;
  /** Probe mutating tools too. Default: false; requires resetPolicy in {transactional, per-test}. */
  probeMutating?: boolean;
  /** Opt-in escape hatch for idor.probeMutating against non-loopback hosts. Default: false. */
  allowRemoteHost?: boolean;
};

export type BugHunterConfig = {
  projectName: string;
  surfaceMcpUrl: string;
  browserMcpUrl?: string;
  roles?: string[];
  resetCommand?: string;
  resetPolicy?: ResetPolicy;
  paletteOverridePath?: string;
  domainHints?: Record<string, string[]>;
  discoveryFixtures?: Record<string, string[]>;
  routeAliases?: Record<string, string>;
  maxBugs?: number;
  maxRuntimeMs?: number;
  budgetMs?: number;
  concurrency?: number;
  apiConcurrency?: number;
  asyncMaxWaitMs?: number;
  reRunForFlakes?: boolean;
  excludedRoutes?: string[];
  externalIntegrationsAllowed?: boolean;
  enableA11y?: boolean;
  forbiddenPaths?: string[];
  extraHeaders?: Record<string, string>;
  artifactBudgetBytes?: number;
  /**
   * Base URL of the application under test (e.g. "http://localhost:3002").
   * Used by the browser path to construct absolute URLs from relative page routes
   * ("/products" → "http://localhost:3002/products"). When unset, falls back to
   * the origin of surfaceMcpUrl (legacy behaviour, only correct when the app and
   * SurfaceMCP share the same origin, which is unusual).
   */
  appBaseUrl?: string;
  /**
   * Per-tool body fixtures for the happy palette.
   * Outer key: toolId. Middle key: roleName or "*" wildcard. Inner: partial body
   * shallow-merged onto the synthesized happy-palette body.
   * Applies only to API direct-call tests on the 'happy' palette.
   */
  bodyFixtures?: Record<string, Record<string, Record<string, unknown>>>;
  /** Crawl config — auto-enabled when SurfaceMCP returns a crawl_seed page. */
  crawl?: CrawlConfig;
  /** Browser-side login config — runs at the head of the discover phase. Default: auto-enabled. */
  browserLogin?: BrowserLoginConfig;
  /** Vision-based visual anomaly detection. Default: disabled. */
  vision?: VisionConfig;
  /** Static analysis tools (gitleaks, npm-audit, semgrep, eslint). Default: enabled. */
  staticAnalysis?: StaticAnalysisConfig;
  /** Header-probe security checks (CSP, CORS, cookies, CSRF). Default: enabled. */
  headers?: HeadersConfig;
  /** Auth-probe checks (no-rate-limit-on-login). Default: disabled (opt-in via --enable-auth-probes). */
  authProbe?: AuthProbeConfig;
  /** Synthetic interaction scenarios (race-double-submit, optimistic-divergence). Default: disabled. */
  synthetic?: SyntheticConfig;
  /** Cross-user IDOR probe config. Default: enabled. */
  crossUser?: CrossUserConfig;
  /** XSS canary injection config. Default: enabled. */
  xss?: XssConfig;
  /** Auth-flow detectors (session fixation, reset token reuse, open redirect). Default: disabled. */
  authFlow?: AuthFlowConfig;
  /** v0.16 active pen-testing palette (SQL/CMD/PATH/JWT). Default: disabled (opt-in). */
  penTesting?: PenTestingConfig;
  /** v0.19 race-condition interleaving tests. Default: disabled (opt-in). */
  raceConditions?: RaceConditionsConfig;
  /** v0.21 IDOR / horizontal-authz testing. Default: disabled (opt-in via --idor or --security). */
  idor?: IdorConfig;
  /** v0.6 performance subsystem. Disabled by default until users opt in. */
  perf?: {
    enabled: boolean;
    vitalsThresholds?: {
      lcpMs?: number;
      inpMs?: number;
      cls?: number;
    };
    requestHygiene?: {
      enabled: boolean;
      nPlusOneThreshold?: number;
    };
    heapSampling?: boolean;
    longTaskMs?: number;
    rerenderCountThreshold?: number;
    rerenderWindowMs?: number;
    /** v0.8: enable heap-snapshot diffing for leak attribution. Default false. */
    heapAttribution?: boolean;
    /** v0.8: snapshot frequency. 'auto' = at indices 0, mid, end. Default 'auto'. */
    heapSnapshotFrequency?: 'auto' | number;
    /** v0.8: minimum instance delta to flag. Default 10. */
    heapDiffMinInstances?: number;
    /** v0.8: minimum retained-size delta (bytes) to flag. Default 5_000_000. */
    heapDiffMinBytes?: number;
  };
  /** v0.6 bundle-size sidecar. */
  bundleProbe?: BundleProbeConfig;
  /** v0.6 a11y-strict: enable baseline axe scan + keyboard trap + focus-lost per page. Implies enableA11y. */
  a11yStrict?: boolean;
  /** v0.6 SEO: enable SEO hygiene cluster. */
  seoEnabled?: boolean;
  /** v0.6 SEO: suppresses seo_title_duplicate_across_routes detections. CLI: --no-seo-duplicate-titles. */
  seoSuppressDuplicateTitles?: boolean;
  /** v0.6 keyboard trap: max Tab presses during trap probe. Default 20. */
  keyboardTrapMaxPresses?: number;
  /** v0.14 seed-data hooks — run shell commands or HTTP requests at lifecycle points. */
  seedHooks?: SeedHooksConfig;
  /** v0.22: master toggle for nav-state tests. Default false. */
  enableNavState?: boolean;
  /**
   * v0.22: include refresh-mid-mutation tests. Racy by nature; off by default
   * even when enableNavState is true. Implies enableNavState.
   *
   * Per §3.4: false by default. Opt in via CLI flag --nav-state-refresh-race.
   * Most useful on fast-responding mutations (< 1s server time).
   */
  enableNavStateRefreshRace?: boolean;
  /**
   * v0.22: include history-state-corruption tests. Advanced diagnostic; off by
   * default. Implies enableNavState.
   */
  enableHistoryCorruption?: boolean;
  /**
   * v0.22: route globs to exclude from nav-state generation. Globs match against
   * tc.page (the route key). Useful for wizard / payment routes that intentionally
   * block back-button navigation.
   *
   * Note: routes already in excludedRoutes never produce TestCases, so nav-state
   * skip is additive, not a replacement.
   */
  navStateSkipRoutes?: string[];
  /**
   * v0.22: max depth (URL hops from root) at which deep-link-no-auth tests
   * are generated. Routes deeper than this are skipped to limit combinatorial
   * blow-up on deeply-nested admin UIs. Default 3.
   */
  navStateDeepLinkMaxDepth?: number;
  /**
   * v0.49: which browser adapter transport to use.
   * 'mcp-http' (default) — SDK Client + StreamableHTTPClientTransport.
   * 'mcp-stdio' — SDK Client + StdioClientTransport (per-run subprocess).
   * 'http-legacy' — deprecated hand-rolled JSON-RPC over fetch. Will be removed in v0.50.
   */
  browserTransport?: 'mcp-http' | 'mcp-stdio' | 'http-legacy';
  /** v0.49: Bearer token for camofox-mcp authentication. Falls back to CAMOFOX_MCP_KEY env var. */
  browserMcpAuthKey?: string;
  /** v0.49: stdio transport config — required when browserTransport === 'mcp-stdio'. */
  browserMcpStdio?: {
    command: string;
    args?: string[];
  };
  /** v0.35: git bisect configuration. */
  bisect?: BisectConfig;
};

// --- v0.14 seed-data hook types ---

export type SeedHookKind = 'shell' | 'http';

export type SeedHookShell = {
  kind: 'shell';
  /** Exact command line; parsed by whitespace-aware splitter (no shell interpreter by default). */
  command: string;
  /** Working directory. Default: projectDir. */
  cwd?: string;
  /** Per-hook timeout. Default: 60_000 ms. */
  timeoutMs?: number;
  /** Additional env vars merged onto process.env. */
  env?: Record<string, string>;
  /** When true, a non-zero exit does not abort the run. Default: false. */
  continueOnError?: boolean;
  description?: string;
};

export type SeedHookHttp = {
  kind: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute URL or relative path resolved against appBaseUrl at execution time. */
  url: string;
  headers?: Record<string, string>;
  /** Serialised as JSON if non-string; omitted when undefined. */
  body?: unknown;
  /** Per-hook timeout. Default: 60_000 ms. */
  timeoutMs?: number;
  /** Accepted HTTP status(es). Defaults to 200-299 range. */
  expectedStatus?: number | number[];
  /** When true, a non-2xx response does not abort the run. Default: false. */
  continueOnError?: boolean;
  description?: string;
};

export type SeedHook = SeedHookShell | SeedHookHttp;

export type SeedHooksConfig = {
  /** Runs once before discovery. */
  beforeRun?: SeedHook[];
  /** Runs once per role after browser-login completes. */
  afterLogin?: SeedHook[];
  /** Role-scoped hooks; run after afterLogin for the matching role. */
  perRole?: Record<string, SeedHook[]>;
  /** Runs once after plan, before execute. */
  beforeExecute?: SeedHook[];
  /** Runs in finally block — always fires even on abort. */
  cleanup?: SeedHook[];
};

export type RunSummary = {
  runId: string;
  bugs_filed: number;
  bugs_specced: number;
  bugs_attempted_fix: number;
  bugs_architect_refused: number;
  bugs_verified_fixed: number;
  partially_verified: number;
  bugs_persistent: number;
  bugs_skipped: number;
  bugs_lost_to_revision: number;
  byKind: Record<string, number>;
  byRole: Record<string, number>;
  projectedRuntimeMs?: number;
  actualRuntimeMs: number;
  testsPlanned: number;
  testsRan: number;
  testsSkipped: number;
  skippedReasons: Array<{ reason: string; count: number }>;
  /** v0.11 form-reachability probe counters (run, skippedByBudget, durationMs). */
  formReachabilityProbes?: { run: number; skippedByBudget: number; durationMs: number };
  /** Number of clusters suppressed via .bughunter/suppressions.json in this run. Always 0 when no suppressions file. */
  suppressedClusters: number;
  /** Up to 20 suppressed samples for human-eyeball verification. Present when suppressedClusters > 0. */
  suppressedSamples?: Array<{
    clusterId: string;
    kind: string;
    bugIdentity?: string;
    matchedPattern: string;
    suppressionId: string;
  }>;
  vision?: {
    enabled: boolean;
    called: number;
    succeeded: number;
    anomaliesFound: number;
    abortReason?: 'auth' | 'transport' | 'cost_cap';
    costUsd?: number;
    costCapUsd?: number;
    /** Which auth path was used for vision. */
    authMode?: 'apiKey' | 'claudeCli';
    consistency?: {
      runsPerScreenshot: number;
      agreementMode: 'strict' | 'majority';
      totalCalls: number;
      totalSucceeded: number;
      droppedByDisagreement: number;
      agreementRate: number;
      screenshotsWithAnomalies: number;
      screenshotsClean: number;
    };
    /** v0.17: per-viewport telemetry — present when vision is enabled. */
    byViewport?: Record<number, { uniqueScreenshots: number; anomaliesFound: number; deduped: number }>;
    /** v0.13: baseline telemetry — present when vision baseline pass ran. */
    baseline?: VisionBaselineTelemetry;
  };
  discovery?: {
    seedRoutes: number;
    staticNavigations: number;
    runtimeEnumRoutes: number;
    crawlLinkRoutes: number;
    visitedPages: number;
    stateKindPages: number;
  };
  perfSummary?: {
    vitalsByPage: Record<string, { lcp?: number; inp?: number; cls?: number }>;
    longestTaskMs: number;
    totalNetworkRequests: number;
    heapGrowthBytesPerSec?: number;
    worstNPlusOne?: { endpoint: string; count: number };
    injectionFailures?: number;
  };
  bundleSummary?: {
    initialJsBytesGzipped: number;
    initialCssBytesGzipped: number;
    budgetExceeded: boolean;
  };
  /** v0.14: one entry per hook execution, in run order. */
  seedHookExecutions?: SeedHookExecution[];
  /** v0.8: heap attribution summary — present when heap attribution ran. */
  heapAttributionSummary?: {
    snapshotsCaptured: number;
    diffsRun: number;
    attributedLeaks: number;
    topConstructor?: string;
  };
  /** v0.16: pen-testing subsystem telemetry — present when penTesting.enabled = true. */
  penTesting?: PenTestingTelemetry;
  /** v0.19: race-condition telemetry — present when raceConditions.enabled = true. */
  raceConditions?: RaceConditionsTelemetry;
  /** v0.21: IDOR / horizontal-authz telemetry — present when idor.enabled = true. */
  idor?: IdorTelemetry;
  /** v0.27: cross-run delta vs. the previous run for the same projectName. Absent when history.db has no prior run. */
  crossRun?: CrossRunSummary;
  /** v0.29: severity rollup. Always present in v0.29+ summary.json files; absent on older runs. */
  bySeverity?: Record<Severity, number>;
};

// --- v0.19 race-condition types ---

/** Discriminated union of interleaving recipes. One variant per pattern. */
export type InterleavingVariant =
  | { kind: 'double_submit'; gapMs: number }
  | { kind: 'click_then_navigate'; targetRoute: string; preFireDelayMs: number }
  | { kind: 'optimistic_revert'; forcedStatus: number; forcedBody: string }
  | { kind: 'interleaved_mutations'; siblingActionId: string; gapMs: number; consensusRuns: number }
  | { kind: 'cross_tab'; settleMs: number };

export type RaceObservation = {
  offsetMs: number;
  url: string;
  consoleErrorCount: number;
  /** SHA1 of the target selector's outerHTML, truncated to 12 chars. Empty if selector not found. */
  targetSelectorHash: string;
  toastVisible: boolean;
  /** 'pre' = unchanged from baseline; 'optimistic' = success state shown; 'final' = persisted change present;
      'reverted' = post-failure revert detected; 'errored' = error state present. */
  targetSelectorState: 'pre' | 'optimistic' | 'final' | 'reverted' | 'errored';
  /** Captured when a network request matching the action's tool path completed. */
  responseStatus?: number;
};

export type RaceDetectionContext = {
  /** Variant kind that produced this finding. */
  variantKind: InterleavingVariant['kind'];
  gapMs?: number;
  navigateTarget?: string;
  forcedStatus?: number;
  siblingToolId?: string;
  /** For interleaved_mutations consensus voting. */
  consensusVotes?: number;
  consensusTotal?: number;
  /** Per-detector proof discriminator. */
  proof:
    | 'duplicate_state'
    | 'stale_post_navigation'
    | 'silent_post_unmount_failure'
    | 'no_revert_after_failure'
    | 'order_dependent_final_state'
    | 'cross_tab_no_reconcile';
  /** Up to 200-char snippet of the divergence evidence. */
  evidence: string;
  /** Whether this detection survived consensus voting. */
  flaky?: boolean;
};

export type RaceConditionsConfig = {
  /** Master switch. Default: false (opt-in; race tests are 60s each + flake-prone). */
  enabled?: boolean;
  /** Which sub-patterns to run. Default: ['double_submit','click_then_navigate','optimistic_revert','interleaved_mutations']. cross_tab is opt-in. */
  variants?: Array<InterleavingVariant['kind']>;
  /** Cap on total race test cases. Default: 200. */
  maxTests?: number;
  /** ToolIds known to be safely idempotent (PUT-by-id, DELETE-by-id, etc.). Skips double_submit on these. */
  idempotentToolIds?: string[];
  /** ToolId glob patterns considered too sensitive to race-test without explicit opt-in. */
  aggressiveRaceTargets?: string[];
  /** Override gap for double_submit. Default: 50ms. */
  doubleSubmitGapMs?: number;
  /** Override forced status for optimistic_revert. Default: 500. */
  optimisticRevertForcedStatus?: number;
  /** Consensus runs for interleaved_mutations. Default: 3. */
  consensusRuns?: number;
  /** When true, skip the per-test reset before each race test (NOT RECOMMENDED). Default: false. */
  skipResetBetweenRaceTests?: boolean;
  /** Concurrency cap for race tests specifically. Default: min(2, config.concurrency). */
  raceConcurrency?: number;
  /**
   * Explicit pairs for interleaved_mutations. Each tuple is [toolIdA, toolIdB].
   * When provided, these pairs take priority over the auto-pairing heuristic.
   */
  pairedToolIds?: [string, string][];
  /** Disable consensus voting: every detection ships regardless of flakiness. */
  strict?: boolean;
};

export type RaceConditionsTelemetry = {
  enabled: boolean;
  variantsRun: Array<InterleavingVariant['kind']>;
  testsAttempted: number;
  testsSucceeded: number;
  testsTimedOut: number;
  testsSkipped: Array<{ reason: string; count: number }>;
  detectionsByKind: Record<string, number>;
  flakyDetections: number;
  durationMs: number;
};

/** v0.21 IDOR telemetry block in summary.json. */
export type IdorTelemetry = {
  enabled: boolean;
  fixturesCollected: Record<string, Record<string, number>>;
  swapsAttempted: number;
  swapsByPair: Array<{ from: string; to: string; count: number }>;
  detectionsByKind: {
    idor_horizontal_read: number;
    idor_horizontal_mutate: number;
    idor_vertical_suspicious: number;
  };
  suppressedByLegitimizedHierarchy: number;
  skippedReasons: Array<{ reason: string; count: number }>;
  durationMs: number;
};

export type CrossRunSummary = {
  /** Previous run id used for comparison; null when this is the first run for the project. */
  previousRunId: string | null;
  newBugs: number;
  persistent: number;
  goneSinceLast: number;
  regressed: number;
};

// --- v0.14 seed-hook execution record (defined here so emit.ts can reference it) ---

export type SeedHookExecution = {
  hookKind: 'shell' | 'http';
  description: string;
  durationMs: number;
  ok: boolean;
  reason?: string;
  /** Truncated stdout / response body (first 500 chars). */
  output?: string;
  /** Exit code — present for shell hooks. */
  exitCode?: number;
  /** HTTP status — present for http hooks. */
  status?: number;
  lifecyclePoint: 'beforeRun' | 'afterLogin' | 'perRole' | 'beforeExecute' | 'cleanup';
  /** Present when lifecyclePoint is 'afterLogin' or 'perRole'. */
  role?: string;
};

// --- v0.35 bisect types ---

export type SkipReason =
  | 'build_failed'
  | 'app_start_timeout'
  | 'replay_setup_failed'
  | 'replay_inconclusive'
  | 'flaky_on_commit'
  | 'surface_revision_changed'
  | 'unexpected_exit'
  | 'bisect_unsupported_kind'
  | 'bisect_nondeterministic_kind';

export type BisectVerdict =
  | { kind: 'good' }
  | { kind: 'bad'; signal: BugSignal }
  | { kind: 'skip'; reason: SkipReason };

export type BugSignal = {
  present: boolean;
  confidence: 'high' | 'low';
  reason: string;
};

/** Snapshot of a BugCluster stored at bisect-start so signal-classifier has stable criteria. */
export type BisectClusterSnapshot = {
  id: string;
  kind: BugKind;
  rootCause: string;
  signatureKey?: string;
  bugIdentity?: string;
  endpoint?: string;
  errorText?: string;
  xssCanary?: string;
};

export type BisectLogEntry = {
  ts: string;
  sha: string;
  verdict: BisectVerdict['kind'];
  durationMs: number;
  signal?: BugSignal;
  skipReason?: SkipReason;
  consensusVotes?: { present: number; absent: number; inconclusive: number };
};

export type BisectConfig = {
  buildCommand?: string;
  appCommand?: string;
  appReadyUrl?: string;
  appReadyTimeoutMs?: number;
  buildTimeoutMs?: number;
  consensusRuns?: number;
  consensusThreshold?: number;
  defaultRange?: string;
  killGracePeriodMs?: number;
  resetCommandsBetweenCommits?: string[];
  appPortRange?: string;
};

export type BisectRunSummary = {
  bisectId: string;
  bugId: string;
  occurrenceId: string;
  runId: string;
  commitRange: { good: string; bad: string };
  introducingCommit?: {
    sha: string;
    author: string;
    date: string;
    subject: string;
  };
  status: 'found' | 'not_found' | 'all_skipped' | 'preflight_failed' | 'aborted';
  commitsVisited: number;
  commitsSkipped: number;
  durationMs: number;
  bisectLogPath: string;
  actionLogPath: string;
};
