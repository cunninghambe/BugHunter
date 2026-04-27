// Core domain types for BugHunter v0.1

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
  | 'network_5xx'
  | 'network_4xx_unexpected'
  | '404_for_linked_route'
  | 'missing_state_change'
  | 'unhandled_exception'
  | 'accessibility_critical'
  | 'dom_error_text'
  | 'surface_call_failed';

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

export type DiscoveredPage = {
  route: string;
  sourceFile?: string;
  elements: Element[];
  forms: DiscoveredForm[];
  links: string[];
};

export type DiscoveryOutput = {
  pages: DiscoveredPage[];
  apiTools: ToolMeta[];
  skipList: SkippedItem[];
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
};
