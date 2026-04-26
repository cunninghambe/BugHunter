import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugHunterConfig } from './types.js';

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

const ConfigSchema = z.object({
  projectName: z.string().min(1),
  surfaceMcpUrl: z.string().url(),
  browserMcpUrl: z.string().url().optional(),
  roles: z.array(z.string()).optional(),
  resetCommand: z.string().optional(),
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
  return result.data;
}

export function saveConfig(projectDir: string, config: BugHunterConfig): void {
  const configDir = path.join(projectDir, '.bughunter');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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
