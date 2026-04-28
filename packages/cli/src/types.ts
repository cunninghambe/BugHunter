// Core domain types for BugHunter v0.1 — extended for v0.5 security & hygiene.

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
  | 'race_double_submit'
  | 'optimistic_update_divergence'
  | 'hallucinated_route'
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

export type SideEffectClass = 'safe' | 'mutating' | 'external';
export type InputSchemaConfidence = 'introspected' | 'inferred' | 'unknown' | 'partial';
export type ResetPolicy = 'transactional' | 'per-test' | 'per-page' | 'per-run';

export type ExpectedOutcome = 'success' | 'expected_failure' | 'unknown';

export type ActionKind = 'click' | 'fill' | 'navigate' | 'render' | 'submit' | 'api_call';
export type ActionVia = 'ui' | 'api';

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
};

export type PreState = {
  url: string;
  title: string;
  consoleErrorCount: number;
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
  suspectedFiles: string[];
  fixHints: string[];
  thirdPartyOrGenerated: boolean;
  verdict?: ClusterVerdict;
  /** Cluster ids that share a normalized route via a different kind (e.g. 404 ↔ surface_call_failed). */
  relatedClusterIds?: string[];
};

export type ClusterVerdict =
  | 'verified_fixed'
  | 'verified_fixed_by_removal'
  | 'not_fixed'
  | 'partially_verified'
  | 'architect_refused';

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
  /** Console errors collected via CDP Console.messageAdded (hydration-mismatch redundancy path). */
  cdpConsoleErrors?: ConsoleError[];
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
  /** Populated for v0.6 performance findings; shape varies by BugKind. */
  evidence?: Record<string, unknown>;
  /** Populated for v0.6 SEO hygiene findings. */
  seoContext?: {
    field: 'title' | 'meta_description' | 'canonical' | 'h1' | 'robots_meta' | 'robots_txt';
    observedValue: string | null;
    expectedShape: string;
    affectedRoutes?: string[];
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
  /** Race double-submit: interval between the two clicks. Default: 50ms. */
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
  };
  /** v0.6 bundle-size sidecar. */
  bundleProbe?: BundleProbeConfig;
  /** v0.6 a11y-strict: enable baseline axe scan + keyboard trap + focus-lost per page. Implies enableA11y. */
  a11yStrict?: boolean;
  /** v0.6 SEO: enable SEO hygiene cluster. */
  seoEnabled?: boolean;
  /** v0.6 keyboard trap: max Tab presses during trap probe. Default 20. */
  keyboardTrapMaxPresses?: number;
  /** v0.14 seed-data hooks — run shell commands or HTTP requests at lifecycle points. */
  seedHooks?: SeedHooksConfig;
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
  /** Number of clusters suppressed via .bughunter/suppressions.json in this run. */
  suppressedClusters?: number;
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
