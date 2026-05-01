// bughunter doctor — environment health report.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig, effectiveForbiddenPaths } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { detectVisionAuth } from '../adapters/vision-auth-detect.js';
import { listRunIds, runPaths } from '../store/filesystem.js';
import type { BugHunterConfig } from '../types.js';

type CheckStatus = 'green' | 'yellow' | 'red' | 'skipped' | 'info';

type DoctorCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

type DoctorResult = {
  projectName: string;
  status: 'green' | 'yellow' | 'red';
  exitCode: 0 | 1 | 2;
  checks: DoctorCheck[];
};

export async function doctorCommand(projectDir: string, opts: { format?: 'table' | 'json' }): Promise<void> {
  const format = opts.format ?? 'table';
  const result = await runAllChecks(projectDir);

  process.exitCode = result.exitCode;

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printTable(result);
}

async function runAllChecks(projectDir: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // D1: Config present + valid Zod
  let config: BugHunterConfig | undefined;
  const d1 = await checkConfig(projectDir);
  checks.push(d1);
  if (d1.status !== 'red') {
    config = loadConfigQuiet(projectDir);
  }

  const projectName = config?.projectName ?? path.basename(projectDir);

  if (config === undefined) {
    // All subsequent checks skipped
    const skipped: DoctorCheck[] = [
      { id: 'D2', label: 'SurfaceMCP reachable', status: 'skipped', detail: 'config-missing' },
      { id: 'D3', label: 'Browser MCP reachable', status: 'skipped', detail: 'config-missing' },
      { id: 'D4', label: 'Vision auth', status: 'skipped', detail: 'config-missing' },
      { id: 'D5', label: 'camofox version', status: 'skipped', detail: 'config-missing' },
      { id: 'D6', label: 'Playwright version', status: 'skipped', detail: 'config-missing' },
      { id: 'D7', label: 'Disk space', status: 'skipped', detail: 'config-missing' },
      { id: 'D8', label: 'Runs dir health', status: 'skipped', detail: 'config-missing' },
      { id: 'D9', label: 'Active hooks', status: 'skipped', detail: 'config-missing' },
      { id: 'D10', label: 'Forbidden paths', status: 'skipped', detail: 'config-missing' },
    ];
    checks.push(...skipped);
    return { projectName, status: 'red', exitCode: 2, checks };
  }

  const surfaceMcpUrl = config.surfaceMcpUrl;
  const browserMcpUrl = config.browserMcpUrl;

  const [d2, d3, d4, d5, d6, d7, d8, d9, d10] = await Promise.allSettled([
    checkSurfaceMcp(surfaceMcpUrl),
    checkBrowserMcp(browserMcpUrl),
    checkVisionAuth(),
    checkCamofoxVersion(browserMcpUrl),
    checkPlaywrightVersion(projectDir),
    checkDiskSpace(projectDir),
    checkRunsDir(projectDir),
    checkActiveHooks(config),
    checkForbiddenPaths(config),
  ]);

  checks.push(
    settledToCheck(d2, 'D2', 'SurfaceMCP reachable'),
    settledToCheck(d3, 'D3', 'Browser MCP reachable'),
    settledToCheck(d4, 'D4', 'Vision auth'),
    settledToCheck(d5, 'D5', 'camofox version'),
    settledToCheck(d6, 'D6', 'Playwright version'),
    settledToCheck(d7, 'D7', 'Disk space'),
    settledToCheck(d8, 'D8', 'Runs dir health'),
    settledToCheck(d9, 'D9', 'Active hooks'),
    settledToCheck(d10, 'D10', 'Forbidden paths'),
  );

  const overallStatus = deriveStatus(checks);
  const exitCode = overallStatus === 'green' ? 0 : overallStatus === 'yellow' ? 1 : 2;

  return { projectName, status: overallStatus, exitCode, checks };
}

function settledToCheck(
  settled: PromiseSettledResult<DoctorCheck>,
  id: string,
  label: string,
): DoctorCheck {
  if (settled.status === 'fulfilled') return settled.value;
  return { id, label, status: 'red', detail: String(settled.reason) };
}

function loadConfigQuiet(projectDir: string): BugHunterConfig | undefined {
  try {
    return loadConfig(projectDir);
  } catch {
    return undefined;
  }
}

async function checkConfig(projectDir: string): Promise<DoctorCheck> {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');
  try {
    loadConfig(projectDir);
    return { id: 'D1', label: 'Config present + valid', status: 'green', detail: configPath };
  } catch (err) {
    return { id: 'D1', label: 'Config present + valid', status: 'red', detail: String(err) };
  }
}

async function checkSurfaceMcp(url: string): Promise<DoctorCheck> {
  const adapter = new HttpSurfaceMcpAdapter(url);
  try {
    const result = await withTimeout(adapter.surface_describe_self(), 5000, url);
    const detail = `${url}  rev=${result.toolRevision} stack=${result.stack}`;
    return { id: 'D2', label: 'SurfaceMCP reachable', status: 'green', detail };
  } catch (err) {
    const detail = String(err).includes('ECONNREFUSED')
      ? `ECONNREFUSED at ${url}`
      : `timeout after 5000ms`;
    return { id: 'D2', label: 'SurfaceMCP reachable', status: 'red', detail };
  }
}

async function checkBrowserMcp(url: string | undefined): Promise<DoctorCheck> {
  if (url === undefined) {
    return { id: 'D3', label: 'Browser MCP reachable', status: 'info', detail: 'not configured (optional)' };
  }
  const adapter = new CamofoxBrowserMcpAdapter(url);
  try {
    const result = await withTimeout(adapter.listTabs(), 5000, url);
    return { id: 'D3', label: 'Browser MCP reachable', status: 'green', detail: `${url}  tabs=${result.tabs.length}` };
  } catch (err) {
    const detail = String(err).includes('ECONNREFUSED')
      ? `ECONNREFUSED at ${url}`
      : `timeout after 5000ms`;
    return { id: 'D3', label: 'Browser MCP reachable', status: 'yellow', detail };
  }
}

async function checkVisionAuth(): Promise<DoctorCheck> {
  const result = await detectVisionAuth(process.env);
  if (result.kind === 'claudeCli') {
    return { id: 'D4', label: 'Vision auth', status: 'green', detail: `claudeCli  ${result.binaryPath}` };
  }
  if (result.kind === 'apiKey') {
    return { id: 'D4', label: 'Vision auth', status: 'green', detail: 'apiKey-present: true' };
  }
  return {
    id: 'D4',
    label: 'Vision auth',
    status: 'yellow',
    detail: 'vision will be unavailable; set ANTHROPIC_API_KEY or install claude CLI',
  };
}

async function checkCamofoxVersion(browserMcpUrl: string | undefined): Promise<DoctorCheck> {
  if (browserMcpUrl === undefined) {
    return { id: 'D5', label: 'camofox version', status: 'info', detail: 'browser MCP not configured; skipping' };
  }
  return new Promise(resolve => {
    execFile('camofox', ['--version'], { timeout: 1000 }, (err, stdout) => {
      if (err !== null) {
        resolve({ id: 'D5', label: 'camofox version', status: 'yellow', detail: 'camofox not found or failed' });
        return;
      }
      resolve({ id: 'D5', label: 'camofox version', status: 'green', detail: stdout.trim() });
    });
  });
}

async function checkPlaywrightVersion(projectDir: string): Promise<DoctorCheck> {
  const candidates = [
    path.join(projectDir, 'node_modules', 'playwright', 'package.json'),
    path.join(projectDir, '..', 'node_modules', 'playwright', 'package.json'),
    path.join('/root/BugHunter', 'node_modules', 'playwright', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      const version = pkg.version ?? 'unknown';
      return { id: 'D6', label: 'Playwright version', status: 'info', detail: version };
    } catch {
      // try next
    }
  }
  return { id: 'D6', label: 'Playwright version', status: 'info', detail: 'not installed' };
}

async function checkDiskSpace(projectDir: string): Promise<DoctorCheck> {
  const GIB = 1024 * 1024 * 1024;
  const MIB = 1024 * 1024;
  const targetDir = path.join(projectDir, '.bughunter');
  const statDir = fs.existsSync(targetDir) ? targetDir : projectDir;
  try {
    const stats = fs.statfsSync(statDir);
    const freeBytes = stats.bavail * stats.bsize;
    const freeGib = freeBytes / GIB;
    const detail = `${freeGib.toFixed(0)} GiB free`;
    if (freeBytes < 100 * MIB) {
      return { id: 'D7', label: 'Disk space', status: 'red', detail: `${detail} (< 100 MiB — critical)` };
    }
    if (freeBytes < GIB) {
      return { id: 'D7', label: 'Disk space', status: 'yellow', detail: `${detail} (< 1 GiB)` };
    }
    return { id: 'D7', label: 'Disk space', status: 'green', detail };
  } catch {
    return { id: 'D7', label: 'Disk space', status: 'info', detail: 'statfs not available' };
  }
}

async function checkRunsDir(projectDir: string): Promise<DoctorCheck> {
  const runsDir = path.join(projectDir, '.bughunter', 'runs');
  try {
    const runIds = listRunIds(projectDir);
    const count = runIds.length;
    if (count > 100) {
      return {
        id: 'D8',
        label: 'Runs dir health',
        status: 'yellow',
        detail: `${count} runs (> 100; consider running 'bughunter prune')`,
      };
    }
    return { id: 'D8', label: 'Runs dir health', status: 'green', detail: `${count} runs` };
  } catch {
    return { id: 'D8', label: 'Runs dir health', status: 'red', detail: `failed to read ${runsDir}` };
  }
}

async function checkActiveHooks(config: BugHunterConfig): Promise<DoctorCheck> {
  const hooks = config.seedHooks;
  if (hooks === undefined) {
    return { id: 'D9', label: 'Active hooks', status: 'info', detail: 'seedHooks: 0' };
  }
  const counts: string[] = [];
  let total = 0;
  const hookKeys = ['beforeRun', 'afterLogin', 'perRole', 'beforeExecute', 'cleanup'] as const;
  for (const key of hookKeys) {
    const val = hooks[key];
    if (val === undefined) continue;
    const count = key === 'perRole'
      ? Object.values(val as Record<string, unknown[]>).reduce((s, arr) => s + arr.length, 0)
      : (val as unknown[]).length;
    if (count > 0) {
      counts.push(`${key}:${count}`);
      total += count;
    }
  }
  return {
    id: 'D9',
    label: 'Active hooks',
    status: 'info',
    detail: `seedHooks: ${total}${counts.length > 0 ? ` (${counts.join(', ')})` : ''}`,
  };
}

async function checkForbiddenPaths(config: BugHunterConfig): Promise<DoctorCheck> {
  const paths = effectiveForbiddenPaths(config);
  const defaultCount = paths.length - (config.forbiddenPaths?.length ?? 0);
  const customCount = config.forbiddenPaths?.length ?? 0;
  return {
    id: 'D10',
    label: 'Forbidden paths',
    status: 'info',
    detail: `${paths.length} entries (${defaultCount} default + ${customCount} custom)`,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms at ${url}`)), ms)
    ),
  ]);
}

function deriveStatus(checks: DoctorCheck[]): 'green' | 'yellow' | 'red' {
  if (checks.some(c => c.status === 'red')) return 'red';
  if (checks.some(c => c.status === 'yellow')) return 'yellow';
  return 'green';
}

function printTable(result: DoctorResult): void {
  process.stdout.write(`BugHunter doctor — ${result.projectName}\n\n`);
  for (const check of result.checks) {
    const id = check.id.padEnd(3);
    const label = check.label.padEnd(40);
    const status = check.status.padEnd(8);
    process.stdout.write(`  ${id} ${label} ${status} ${check.detail}\n`);
  }
  process.stdout.write(`\nStatus: ${result.status.toUpperCase()}.  Exit ${result.exitCode}.\n`);
}
