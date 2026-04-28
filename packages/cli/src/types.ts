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

export type PaletteVariant = 'null' | 'happy' | 'edge' | 'out_of_bounds';

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
  | 'hallucinated_route';

export type SideEffectClass = 'safe' | 'mutating' | 'external';
export type InputSchemaConfidence = 'introspected' | 'inferred' | 'unknown' | 'partial';
export type ResetPolicy = 'transactional' | 'per-test' | 'per-page' | 'per-run';

export type ExpectedOutcome = 'success' | 'expected_failure' | 'unknown';

export type ActionKind = 'click' | 'fill' | 'navigate' | 'render' | 'submit' | 'api_call';
export type ActionVia = 'ui' | 'api';

export type Action = {
  kind: ActionKind;
  selector?: string;
  via: ActionVia;
  expectedOutcome: ExpectedOutcome;
  palette: PaletteVariant;
  toolId?: string;
  input?: unknown;
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
  /** Anthropic model id. Default: 'claude-haiku-4-5-20251001'. */
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

export type DiscoveryOutput = {
  pages: DiscoveredPage[];
  apiTools: ToolMeta[];
  skipList: SkippedItem[];
  visualBaselineDetections?: VisualBaselineEntry[];
  crawlTelemetry?: CrawlTelemetry;
  /** Detections from static-analysis tools (gitleaks, npm-audit, semgrep, eslint-no-empty). */
  staticDetections?: BugDetection[];
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
  };
  discovery?: {
    seedRoutes: number;
    staticNavigations: number;
    runtimeEnumRoutes: number;
    crawlLinkRoutes: number;
    visitedPages: number;
    stateKindPages: number;
  };
};
