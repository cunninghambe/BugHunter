// bughunter doctor — environment health report.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { loadConfig, effectiveForbiddenPaths } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { makeBrowserAdapter } from '../adapters/browser-mcp.js';
import { detectVisionAuth } from '../adapters/vision-auth-detect.js';
import { listRunIds } from '../store/filesystem.js';
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

export type CleanupReport = {
  killed: Array<{ pid: number; name: string; signal: 'SIGTERM' | 'SIGKILL' }>;
  ports: number[];
};

export async function doctorCommand(
  projectDir: string,
  opts: { format?: 'table' | 'json'; cleanup?: boolean },
): Promise<void> {
  if (opts.cleanup === true) {
    const report = cleanupFixtures();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const format = opts.format ?? 'table';
  const result = await runAllChecks(projectDir);

  process.exitCode = result.exitCode;

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printTable(result);
}

const FIXTURE_PATTERN = /bh-e2e-fixture|bughunter-fixture-/;
const FIXTURE_PORTS = [9994, 4090, 5780, 5781, 5782, 4091, 5790, 5791];

export function cleanupFixtures(psOutput?: string): CleanupReport {
  const raw = psOutput ?? (() => {
    try {
      return execFileSync('ps', ['-ef'], { encoding: 'utf-8', timeout: 5000 });
    } catch {
      return '';
    }
  })();

  const killed: CleanupReport['killed'] = [];

  for (const line of raw.split('\n')) {
    if (!FIXTURE_PATTERN.test(line)) continue;
    const pid = extractPid(line);
    if (pid === null) continue;
    const name = extractProcessName(line);
    const sent = sendTermThenKill(pid);
    if (sent !== null) killed.push({ pid, name, signal: sent });
  }

  const freedPorts = killed.length > 0 ? FIXTURE_PORTS : [];

  process.stderr.write(
    killed.length === 0
      ? '[doctor --cleanup] No fixture processes found.\n'
      : `[doctor --cleanup] Killed ${killed.length} process(es). Freed ports: ${freedPorts.join(', ')}\n`,
  );

  return { killed, ports: freedPorts };
}

function extractPid(psLine: string): number | null {
  // ps -ef columns: UID  PID  PPID  ...
  const parts = psLine.trimStart().split(/\s+/);
  const pid = parseInt(parts[1] ?? '', 10);
  return Number.isFinite(pid) ? pid : null;
}

function extractProcessName(psLine: string): string {
  const parts = psLine.trimStart().split(/\s+/);
  return parts.slice(7).join(' ').slice(0, 80);
}

function sendTermThenKill(pid: number): 'SIGTERM' | 'SIGKILL' | null {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return null;
  }
  // poll for 5s then SIGKILL if still alive
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return 'SIGTERM';
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
    return 'SIGKILL';
  } catch {
    return 'SIGTERM';
  }
}

async function runAllChecks(projectDir: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // D1: Config present + valid Zod
  const d1 = checkConfig(projectDir);
  checks.push(d1);

  const config = d1.status !== 'red' ? loadConfigQuiet(projectDir) : undefined;
  const projectName = config?.projectName ?? path.basename(projectDir);

  if (config === undefined) {
    checks.push(
      { id: 'D2', label: 'SurfaceMCP reachable', status: 'skipped', detail: 'config-missing' },
      { id: 'D3', label: 'Browser MCP reachable', status: 'skipped', detail: 'config-missing' },
      { id: 'D4', label: 'Vision auth', status: 'skipped', detail: 'config-missing' },
      { id: 'D5', label: 'camofox version', status: 'skipped', detail: 'config-missing' },
      { id: 'D6', label: 'Playwright version', status: 'skipped', detail: 'config-missing' },
      { id: 'D7', label: 'Disk space', status: 'skipped', detail: 'config-missing' },
      { id: 'D8', label: 'Runs dir health', status: 'skipped', detail: 'config-missing' },
      { id: 'D9', label: 'Active hooks', status: 'skipped', detail: 'config-missing' },
      { id: 'D10', label: 'Forbidden paths', status: 'skipped', detail: 'config-missing' },
    );
    return { projectName, status: 'red', exitCode: 2, checks };
  }

  const [d2, d3, d4, d5, d6, d7, d8, d9, d10] = await Promise.allSettled([
    checkSurfaceMcp(config.surfaceMcpUrl),
    checkBrowserMcp(config),
    checkVisionAuth(),
    checkCamofoxVersion(config.browserMcpUrl),
    Promise.resolve(checkPlaywrightVersion(projectDir)),
    Promise.resolve(checkDiskSpace(projectDir)),
    Promise.resolve(checkRunsDir(projectDir)),
    Promise.resolve(checkActiveHooks(config)),
    Promise.resolve(checkForbiddenPaths(config)),
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

function checkConfig(projectDir: string): DoctorCheck {
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
    const result = await withTimeout(adapter.surface_describe_self(), 5000);
    const detail = `${url}  rev=${result.toolRevision} stack=${result.stack}`;
    return { id: 'D2', label: 'SurfaceMCP reachable', status: 'green', detail };
  } catch (err) {
    const detail = String(err).includes('ECONNREFUSED')
      ? `ECONNREFUSED at ${url}`
      : `timeout after 5000ms`;
    return { id: 'D2', label: 'SurfaceMCP reachable', status: 'red', detail };
  }
}

async function checkBrowserMcp(config: BugHunterConfig): Promise<DoctorCheck> {
  const url = config.browserMcpUrl;
  const transport = config.browserTransport ?? 'mcp-http';
  if (transport === 'mcp-stdio') {
    const cmd = config.browserMcpStdio?.command ?? '(not set)';
    return { id: 'D3', label: 'Browser MCP reachable', status: 'info', detail: `transport: mcp-stdio (SDK Client)  cmd=${cmd}` };
  }
  if (url === undefined) {
    return { id: 'D3', label: 'Browser MCP reachable', status: 'info', detail: 'not configured (optional)' };
  }
  const adapter = makeBrowserAdapter(config);
  if (adapter === undefined) {
    return { id: 'D3', label: 'Browser MCP reachable', status: 'info', detail: 'not configured (optional)' };
  }
  try {
    const result = await withTimeout(adapter.listTabs(), 5000);
    const transportLabel = transport === 'http-legacy' ? 'http-legacy (deprecated)' : `${transport} (SDK Client)`;
    return {
      id: 'D3',
      label: 'Browser MCP reachable',
      status: 'green',
      detail: `${url}  tabs=${result.tabs.length}  transport: ${transportLabel}`,
    };
  } catch {
    return { id: 'D3', label: 'Browser MCP reachable', status: 'yellow', detail: 'timeout after 5000ms' };
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

function checkCamofoxVersion(browserMcpUrl: string | undefined): Promise<DoctorCheck> {
  if (browserMcpUrl === undefined) {
    return Promise.resolve({ id: 'D5', label: 'camofox version', status: 'info', detail: 'browser MCP not configured; skipping' });
  }
  return new Promise<DoctorCheck>(resolve => {
    execFile('camofox', ['--version'], { timeout: 1000 }, (err, stdout) => {
      if (err !== null) {
        resolve({ id: 'D5', label: 'camofox version', status: 'yellow', detail: 'camofox not found or failed' });
      } else {
        resolve({ id: 'D5', label: 'camofox version', status: 'green', detail: stdout.trim() });
      }
    });
  });
}

function checkPlaywrightVersion(projectDir: string): DoctorCheck {
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
      // try next candidate
    }
  }
  return { id: 'D6', label: 'Playwright version', status: 'info', detail: 'not installed' };
}

function checkDiskSpace(projectDir: string): DoctorCheck {
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

function checkRunsDir(projectDir: string): DoctorCheck {
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

function checkActiveHooks(config: BugHunterConfig): DoctorCheck {
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

function checkForbiddenPaths(config: BugHunterConfig): DoctorCheck {
  const allPaths = effectiveForbiddenPaths(config);
  const defaultCount = allPaths.length - (config.forbiddenPaths?.length ?? 0);
  const customCount = config.forbiddenPaths?.length ?? 0;
  return {
    id: 'D10',
    label: 'Forbidden paths',
    status: 'info',
    detail: `${allPaths.length} entries (${defaultCount} default + ${customCount} custom)`,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => { reject(new Error(`timeout after ${ms}ms`)); }, ms);
    }),
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
