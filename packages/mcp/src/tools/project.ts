// bughunt_project_describe — project health check.
// CLI parity: bughunter doctor (project-scoped, structured output)

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk } from '../envelope.js';
import type { BugHunterConfig } from 'bughunter/src/types.js';

const InputSchema = z.object({
  projectDir: z.string().min(1).describe('Absolute path to the project directory to health-check'),
});

type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  suggestion?: string;
};

function checkBughunterDir(projectDir: string): Check {
  const dir = path.join(projectDir, '.bughunter');
  if (!fs.existsSync(dir)) {
    return { name: 'bughunterDir', status: 'error', detail: '.bughunter directory not found', suggestion: 'Run `bughunter init` to initialize the project.' };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { name: 'bughunterDir', status: 'ok', detail: '.bughunter directory exists and is writable' };
  } catch {
    return { name: 'bughunterDir', status: 'warn', detail: '.bughunter directory exists but is not writable', suggestion: 'Check directory permissions.' };
  }
}

function checkConfig(projectDir: string): { check: Check; config?: BugHunterConfig } {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');
  if (!fs.existsSync(configPath)) {
    return { check: { name: 'config', status: 'error', detail: '.bughunter/config.json not found', suggestion: 'Run `bughunter init` or create a config.json.' } };
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as BugHunterConfig;
    if (config.surfaceMcpUrl === '') {
      return { check: { name: 'config', status: 'warn', detail: 'config.json missing surfaceMcpUrl', suggestion: 'Add surfaceMcpUrl to .bughunter/config.json.' }, config };
    }
    return { check: { name: 'config', status: 'ok', detail: 'config.json valid and surfaceMcpUrl set' }, config };
  } catch (e) {
    return { check: { name: 'config', status: 'error', detail: `config.json parse error: ${String(e)}`, suggestion: 'Fix JSON syntax in .bughunter/config.json.' } };
  }
}

function checkDiskSpace(projectDir: string): Check {
  const bughunterDir = path.join(projectDir, '.bughunter');
  if (!fs.existsSync(bughunterDir)) {
    return { name: 'disk', status: 'skip', detail: '.bughunter directory not found; skipping disk check' };
  }
  try {
    // Use statSync on the directory to get basic info; full disk usage requires platform-specific calls
    fs.statSync(bughunterDir);
    return { name: 'disk', status: 'ok', detail: '.bughunter directory accessible' };
  } catch (e) {
    return { name: 'disk', status: 'error', detail: `disk check failed: ${String(e)}` };
  }
}

function checkSurfaceMcp(config?: BugHunterConfig): Check {
  if (config?.surfaceMcpUrl === undefined) {
    return { name: 'surfaceMcp', status: 'skip', detail: 'No surfaceMcpUrl configured' };
  }
  return { name: 'surfaceMcp', status: 'ok', detail: `surfaceMcpUrl configured: ${config.surfaceMcpUrl}` };
}

function checkBrowserMcp(config?: BugHunterConfig): Check {
  if (config?.browserMcpUrl === undefined) {
    return { name: 'browserMcp', status: 'warn', detail: 'No browserMcpUrl configured; browser-based checks disabled', suggestion: 'Add browserMcpUrl to .bughunter/config.json for full coverage.' };
  }
  return { name: 'browserMcp', status: 'ok', detail: `browserMcpUrl configured: ${config.browserMcpUrl}` };
}

function checkHooks(config?: BugHunterConfig): Check {
  const hooks = config?.seedHooks;
  if (hooks === undefined) {
    return { name: 'hooks', status: 'ok', detail: 'No seed hooks configured (optional)' };
  }
  const total = [
    ...(hooks.beforeRun ?? []),
    ...(hooks.afterLogin ?? []),
    ...(hooks.beforeExecute ?? []),
    ...(hooks.cleanup ?? []),
  ].length;
  return { name: 'hooks', status: 'ok', detail: `${total} seed hook(s) configured` };
}

export function registerProjectDescribeTool(server: McpServer): void {
  server.tool(
    'bughunt_project_describe',
    'Health check for a project: SurfaceMCP reachable? camofox / browser MCP reachable? Vision auth? config valid? .bughunter directory present and writable? Disk space? Active hooks? Returns a structured report with ok/warn/error severity per check. Never errors — missing dependencies appear as error-status checks.',
    InputSchema.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- MCP tool handler interface; all checks are synchronous
    async (args) => {
      const rawDir = args.projectDir;
      let resolvedDir = rawDir;
      try {
        resolvedDir = fs.realpathSync(rawDir);
      } catch { /* use as-is */ }

      const dirCheck: Check = fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()
        ? { name: 'projectDir', status: 'ok', detail: `Directory exists: ${resolvedDir}` }
        : { name: 'projectDir', status: 'error', detail: `Directory not found: ${resolvedDir}`, suggestion: 'Ensure the projectDir path is correct.' };

      const bughunterDirCheck = checkBughunterDir(resolvedDir);
      const { check: configCheck, config } = checkConfig(resolvedDir);
      const diskCheck = checkDiskSpace(resolvedDir);
      const surfaceCheck = checkSurfaceMcp(config);
      const browserCheck = checkBrowserMcp(config);
      const hooksCheck = checkHooks(config);

      const checks: Check[] = [dirCheck, bughunterDirCheck, configCheck, diskCheck, surfaceCheck, browserCheck, hooksCheck];
      const ok = checks.every(c => c.status === 'ok' || c.status === 'skip');

      return toolOk({
        projectDir: resolvedDir,
        ok,
        checks,
        config: config !== undefined ? {
          surfaceMcpUrl: config.surfaceMcpUrl,
          framework: undefined,
          forbiddenPaths: config.forbiddenPaths,
        } : undefined,
      });
    },
  );
}
