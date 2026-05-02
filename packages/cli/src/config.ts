import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugHunterConfig } from './types.js';
import { NotificationsConfigSchema } from './notify/types.js';
import { interpolateChannel } from './notify/send.js';

export const DEFAULT_FORBIDDEN_PATHS = [
  'prisma/migrations/**',
  'prisma/schema.prisma',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.env*',
  '.gitignore',
  'migrations/**',
  'alembic/**',
  '.next/**',
  'node_modules/**',
  'dist/**',
  'build/**',
];

export const DEFAULT_MAX_BUGS = 200;
export const DEFAULT_MAX_RUNTIME_MS = 86_400_000; // 24h
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_API_CONCURRENCY = 16;
export const DEFAULT_ASYNC_MAX_WAIT_MS = 30_000;
export const DEFAULT_ARTIFACT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
export const MAX_CONSECUTIVE_INFRA_FAILURES = 20;
export const CLUSTER_FULL_ARTIFACT_CAP = 50; // clusters larger than this use bounded retention
export const CLUSTER_FULL_ARTIFACT_HEAD = 3;
export const CLUSTER_FULL_ARTIFACT_TAIL = 1;

const SeedHookShellSchema = z.object({
  kind: z.literal('shell'),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
  continueOnError: z.boolean().optional(),
  description: z.string().optional(),
});

const SeedHookHttpSchema = z.object({
  kind: z.literal('http'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
  expectedStatus: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  continueOnError: z.boolean().optional(),
  description: z.string().optional(),
});

const SeedHookSchema = z.discriminatedUnion('kind', [SeedHookShellSchema, SeedHookHttpSchema]);

// --- v0.42 data-integrity invariant schema ---

const AppliesToFilterSchema = z.object({
  method: z.union([z.string(), z.array(z.string())]).optional(),
  urlPattern: z.string().optional(),
  palette: z.union([
    z.enum(['null', 'happy', 'edge', 'out_of_bounds', 'xss_inject']),
    z.array(z.enum(['null', 'happy', 'edge', 'out_of_bounds', 'xss_inject'])),
  ]).optional(),
  actionIds: z.array(z.string()).optional(),
});

const ExpectationSchema = z.object({
  op: z.enum(['equals', 'notEquals', 'lengthEquals', 'lengthGte', 'lengthLte', 'numericEquals', 'contains', 'notContains', 'matches']),
  jsonPath: z.string().optional(),
  value: z.unknown(),
  tolerance: z.number().optional(),
});

const InvariantQuerySchema = z.object({
  query: SeedHookSchema,
  parse: z.enum(['json', 'text', 'jsonl', 'integer']).default('json'),
  store: z.record(z.string()).optional(),
  expect: ExpectationSchema.optional(),
  retry: z.object({ count: z.number().int().positive(), delayMs: z.number().int().nonnegative() }).optional(),
  timeoutMs: z.number().int().positive().optional(),
  name: z.string().optional(),
});

const InvariantPhaseSchema = z.union([
  InvariantQuerySchema,
  z.object({ queries: z.array(InvariantQuerySchema) }),
]);

const ExtractClauseSchema = z.object({
  from: z.enum(['actionUrl', 'actionRequestBody', 'actionResponseBody', 'actionRequestHeaders', 'beforeSnapshot', 'literal']),
  regex: z.string().optional(),
  jsonPath: z.string().optional(),
  literal: z.union([z.string(), z.number()]).optional(),
});

const DataIntegrityInvariantBugKindEnum = z.enum([
  'data_integrity_orphan',
  'money_math_precision',
  'cache_staleness',
  'idempotency_key_violation',
  'audit_log_missing_for_mutation',
  'soft_delete_consistency',
]);

const DataIntegrityInvariantSchema = z.object({
  name: z.string().min(1),
  bugKind: DataIntegrityInvariantBugKindEnum,
  description: z.string().optional(),
  appliesTo: AppliesToFilterSchema,
  extract: z.record(ExtractClauseSchema).optional(),
  injectInputs: z.array(z.object({ field: z.string(), values: z.array(z.unknown()) })).optional(),
  before: InvariantPhaseSchema.optional(),
  replay: z.object({ withSameIdempotencyKey: z.boolean(), expectSameResponseShape: z.boolean() }).optional(),
  after: InvariantPhaseSchema.optional(),
  continueOnError: z.boolean().optional(),
}).superRefine((inv, ctx) => {
  if (inv.bugKind === 'idempotency_key_violation' && inv.replay === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'idempotency_key_violation requires a replay clause' });
  }
  if (inv.bugKind === 'money_math_precision' && inv.injectInputs === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'money_math_precision requires an injectInputs clause' });
  }
  const needsAfter = inv.bugKind !== 'idempotency_key_violation';
  if (needsAfter && inv.after === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${inv.bugKind} requires an after clause` });
  }
});

const DataIntegrityConfigSchema = z.object({
  invariants: z.array(DataIntegrityInvariantSchema),
  enabled: z.boolean().optional(),
});

export const ConfigSchema = z.object({
  projectName: z.string().min(1),
  surfaceMcpUrl: z.string().url(),
  browserMcpUrl: z.string().url().optional(),
  roles: z.array(z.string()).optional(),
  resetCommand: z.string().min(1).optional(),
  resetPolicy: z.enum(['transactional', 'per-test', 'per-page', 'per-run']).optional(),
  paletteOverridePath: z.string().optional(),
  domainHints: z.record(z.array(z.string())).optional(),
  discoveryFixtures: z.record(z.array(z.string())).optional(),
  routeAliases: z.record(z.string()).optional(),
  maxBugs: z.number().int().positive().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  budgetMs: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  apiConcurrency: z.number().int().positive().optional(),
  asyncMaxWaitMs: z.number().int().positive().optional(),
  reRunForFlakes: z.boolean().optional(),
  excludedRoutes: z.array(z.string()).optional(),
  externalIntegrationsAllowed: z.boolean().optional(),
  enableA11y: z.boolean().optional(),
  forbiddenPaths: z.array(z.string()).optional(),
  extraHeaders: z.record(z.string()).optional(),
  artifactBudgetBytes: z.number().int().positive().optional(),
  appBaseUrl: z.string().url().optional(),
  bodyFixtures: z.record(z.record(z.record(z.unknown()))).optional(),
  crawl: z.object({
    enabled: z.boolean().optional(),
    maxPages: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive().optional(),
    followQueryParams: z.boolean().optional(),
    walkTimeoutMs: z.number().int().positive().optional(),
    sameOriginOnly: z.boolean().optional(),
    /** Include confidence:'low' navigations from surface_list_navigations. Default: false. */
    includeLowConfidence: z.boolean().optional(),
    /** Settle delay (ms) after clicking a state-trigger before snapshotting. Default: 250. */
    stateSettleMs: z.number().int().nonnegative().optional(),
    /** Disable runtime route enumeration. Default: false (enabled). */
    disableRuntimeEnum: z.boolean().optional(),
    /** Cap on state-kind queue items to prevent runaway tab-state crawls. Default: 30. */
    maxStateNavigations: z.number().int().positive().optional(),
  }).optional(),
  browserLogin: z.object({
    enabled: z.boolean().optional(),
    role: z.string().optional(),
    verifyTimeoutMs: z.number().int().positive().optional(),
    verifyPollMs: z.number().int().positive().optional(),
  }).optional(),
  vision: z.object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    maxCalls: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    severityThreshold: z.enum(['minor', 'major', 'critical']).optional(),
    preScreenshotSettleMs: z.number().int().positive().optional(),
    consistencyRuns: z.number().int().min(1).max(5).default(2),
    agreementMode: z.enum(['strict', 'majority']).default('strict'),
    viewports: z.array(z.number().int().min(320).max(2560)).min(1).max(6).default([375, 768, 1280]),
  }).optional(),
  perf: z.object({
    enabled: z.boolean(),
    vitalsThresholds: z.object({
      lcpMs: z.number().int().positive().optional(),
      inpMs: z.number().int().positive().optional(),
      cls: z.number().nonnegative().optional(),
    }).optional(),
    requestHygiene: z.object({
      enabled: z.boolean(),
      nPlusOneThreshold: z.number().int().positive().optional(),
    }).optional(),
    heapSampling: z.boolean().optional(),
    longTaskMs: z.number().int().positive().optional(),
    rerenderCountThreshold: z.number().int().positive().optional(),
    rerenderWindowMs: z.number().int().positive().optional(),
    heapAttribution: z.boolean().optional(),
    heapSnapshotFrequency: z.union([z.literal('auto'), z.number().int().positive()]).optional(),
    heapDiffMinInstances: z.number().int().positive().optional(),
    heapDiffMinBytes: z.number().int().positive().optional(),
  }).optional(),
  bundleProbe: z.object({
    enabled: z.boolean(),
    jsThresholdGzipBytes: z.number().int().positive(),
    cssThresholdGzipBytes: z.number().int().positive(),
    searchPaths: z.array(z.string()).optional(),
  }).optional(),
  a11yStrict: z.boolean().optional(),
  seoEnabled: z.boolean().optional(),
  seoSuppressDuplicateTitles: z.boolean().optional(),
  keyboardTrapMaxPresses: z.number().int().positive().optional(),
  seedHooks: z.object({
    beforeRun: z.array(SeedHookSchema).optional(),
    afterLogin: z.array(SeedHookSchema).optional(),
    perRole: z.record(z.array(SeedHookSchema)).optional(),
    beforeExecute: z.array(SeedHookSchema).optional(),
    cleanup: z.array(SeedHookSchema).optional(),
  }).optional(),
  penTesting: z.object({
    enabled: z.boolean().optional(),
    variants: z.array(z.enum(['sql', 'cmd', 'path', 'jwt', 'prompt'])).optional(),
    jwtTargets: z.array(z.string()).optional(),
    jwtPublicKeyPemPath: z.string().optional(),
    booleanDeltaThreshold: z.number().min(0).max(1).optional(),
    maxProbesPerEndpoint: z.number().int().positive().optional(),
  }).optional(),
  idor: z.object({
    enabled: z.boolean().optional(),
    tiers: z.record(z.number().int().nonnegative()).optional(),
    peerRoles: z.array(z.tuple([z.string(), z.string()])).optional(),
    legitimizedHierarchies: z.array(z.object({
      from: z.string(),
      to: z.string(),
    }).refine(h => h.from !== h.to, { message: 'legitimizedHierarchies: from and to must be different roles' })).optional(),
    skipResources: z.array(z.string()).optional(),
    skipFixtureFromTools: z.array(z.string()).optional(),
    resourceTypeOverrides: z.record(z.string()).optional(),
    resourceTypeOverridesByPath: z.record(z.string()).optional(),
    maxFixturesPerRoleResource: z.number().int().positive().optional(),
    maxReplays: z.number().int().positive().optional(),
    probeMutating: z.boolean().optional(),
    allowRemoteHost: z.boolean().optional(),
  }).optional(),
  authFlow: z.object({
    enabled: z.boolean().optional(),
    sessionFixation: z.object({
      enabled: z.boolean().optional(),
      sessionCookieName: z.string().optional(),
    }).optional(),
    passwordResetReuse: z.object({
      enabled: z.boolean().optional(),
      requestEndpoint: z.string().optional(),
      consumeEndpoint: z.string().optional(),
      testEmail: z.string().optional(),
      tokenBodyKey: z.string().optional(),
    }).optional(),
    openRedirect: z.object({
      enabled: z.boolean().optional(),
      candidateUrls: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  // v0.39 generative fuzz config
  fuzz: z.object({
    enabled: z.boolean().optional(),
    strategy: z.enum(['none', 'unicode', 'shape', 'boundary', 'all']).optional(),
    strategies: z.array(z.enum(['unicode', 'shape', 'boundary'])).optional(),
    runs: z.number().int().min(1).max(256).optional(),
    shrink: z.boolean().optional(),
    maxTotalDrawsPerRun: z.number().int().positive().optional(),
  }).optional(),
  // v0.22 nav-state config (§6.2)
  enableNavState: z.boolean().optional(),
  enableNavStateRefreshRace: z.boolean().optional(),
  enableHistoryCorruption: z.boolean().optional(),
  navStateSkipRoutes: z.array(z.string()).optional(),
  navStateDeepLinkMaxDepth: z.number().int().positive().optional(),
  // v0.35 bisect config
  bisect: z.object({
    buildCommand: z.string().optional(),
    appCommand: z.string().optional(),
    appReadyUrl: z.string().url().optional(),
    appReadyTimeoutMs: z.number().int().positive().optional(),
    buildTimeoutMs: z.number().int().positive().optional(),
    consensusRuns: z.number().int().min(1).optional(),
    consensusThreshold: z.number().int().min(1).optional(),
    defaultRange: z.string().optional(),
    killGracePeriodMs: z.number().int().nonnegative().optional(),
    resetCommandsBetweenCommits: z.array(z.string()).optional(),
    appPortRange: z.string().optional(),
  }).optional(),
  // v0.42 data-integrity invariants
  dataIntegrity: DataIntegrityConfigSchema.optional(),
  // v0.49 browser transport config
  browserTransport: z.enum(['mcp-http', 'mcp-stdio', 'http-legacy']).default('mcp-http'),
  browserMcpAuthKey: z.string().min(1).optional(),
  browserMcpStdio: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }).optional(),
  // v0.48 notifications
  notifications: NotificationsConfigSchema.optional(),
  // v0.23 clock-injection palette
  clockTesting: z.object({
    enabled: z.boolean().optional(),
    activeConditions: z.array(z.enum([
      'dst_forward',
      'dst_backward',
      'leap_day',
      'y2038_edge',
      'far_future',
      'client_skew_plus_1h',
      'tz_skew_negative_8h',
    ])).optional(),
    dateSensitiveAllowlist: z.array(z.string()).optional(),
    dateSensitiveDenylist: z.array(z.string()).optional(),
    serverClockSource: z.string().url().optional(),
    userProfileTimezone: z.string().optional(),
  }).optional(),
  browserPlatform: z.object({
    enabled: z.boolean().optional(),
    swStaleThresholdMs: z.number().int().positive().optional(),
    observationWindowMs: z.number().int().positive().min(100).max(10_000).optional(),
    permissions: z.array(z.enum(['geolocation', 'clipboard-read', 'notifications'])).optional(),
    enableShadowA11y: z.boolean().optional(),
    enableForcedPermissionDeny: z.boolean().optional(),
  }).strict().optional(),
  // v0.43 agentic-app detection
  agent: z.object({
    enabled: z.boolean().optional(),
    verifierModel: z.string().min(1).optional(),
    maxLlmOfOutputCalls: z.number().int().positive().optional(),
    maxTurnLatencyMs: z.number().int().positive().optional(),
    maxCostUsdPerTurn: z.number().nonnegative().optional(),
    streamStaleChunkMs: z.number().int().positive().optional(),
    toolFailureSettleMs: z.number().int().positive().optional(),
    synthesiseToolFailures: z.boolean().optional(),
    promptInjectionVariants: z.array(z.enum([
      'system_override_simple',
      'system_override_role_play',
      'tool_invocation_smuggle',
      'data_exfiltration_via_echo',
      'instruction_in_data_field',
    ])).optional(),
    errorIndicatorSelector: z.string().optional(),
    streamTerminalMarkers: z.array(z.string()).optional(),
  }).optional(),
});

export function loadConfig(projectDir: string): BugHunterConfig {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No .bughunter/config.json found in ${projectDir}. Run 'bughunter init' first.`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid .bughunter/config.json: ${result.error.message}`);
  }
  const config = result.data;
  // v0.48: Interpolate env vars in non-secret-bearing notification channels at
  // config-load time with loud Zod-style failure. Secret-bearing channels
  // (slack-channel, email) defer env check to send time.
  if (config.notifications !== undefined) {
    for (const channel of config.notifications.channels) {
      if (channel.kind !== 'slack-channel' && channel.kind !== 'email') {
        interpolateChannel(channel); // throws if a referenced env var is missing
      }
    }
  }
  return config;
}

export function saveConfig(projectDir: string, config: BugHunterConfig): void {
  const configDir = path.join(projectDir, '.bughunter');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)  }\n`);
}

export function resolvedConfig(config: BugHunterConfig): Required<
  Pick<BugHunterConfig,
    | 'maxBugs'
    | 'maxRuntimeMs'
    | 'concurrency'
    | 'apiConcurrency'
    | 'asyncMaxWaitMs'
    | 'resetPolicy'
    | 'reRunForFlakes'
    | 'externalIntegrationsAllowed'
    | 'enableA11y'
    | 'artifactBudgetBytes'
  >
> & BugHunterConfig {
  return {
    ...config,
    maxBugs: config.maxBugs ?? DEFAULT_MAX_BUGS,
    maxRuntimeMs: config.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
    concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
    apiConcurrency: config.apiConcurrency ?? DEFAULT_API_CONCURRENCY,
    asyncMaxWaitMs: config.asyncMaxWaitMs ?? DEFAULT_ASYNC_MAX_WAIT_MS,
    resetPolicy: config.resetPolicy ?? 'per-page',
    reRunForFlakes: config.reRunForFlakes ?? true,
    externalIntegrationsAllowed: config.externalIntegrationsAllowed ?? false,
    enableA11y: config.enableA11y ?? false,
    artifactBudgetBytes: config.artifactBudgetBytes ?? DEFAULT_ARTIFACT_BUDGET_BYTES,
  };
}

export function effectiveForbiddenPaths(config: BugHunterConfig): string[] {
  const user = config.forbiddenPaths ?? [];
  return [...DEFAULT_FORBIDDEN_PATHS, ...user];
}
