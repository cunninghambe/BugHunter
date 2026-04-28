// bughunter init — walks project, writes .bughunter/config.json template.

import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveConfig, ConfigSchema } from '../config.js';
import type { BugHunterConfig } from '../types.js';
import { log } from '../log.js';

export type InitOptions = {
  noInteractive?: boolean;
  projectName?: string;
  surfaceMcpUrl?: string;
  browserMcpUrl?: string;
  resetCommand?: string;
  resetPolicy?: 'transactional' | 'per-test' | 'per-page' | 'per-run';
};

export async function initCommand(projectDir: string, opts?: InitOptions): Promise<void> {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');
  if (fs.existsSync(configPath)) {
    log.warn(`.bughunter/config.json already exists at ${configPath}`);
    return;
  }

  const config = opts?.noInteractive === true
    ? resolveNonInteractive(projectDir, opts)
    : await resolveInteractive(projectDir);

  saveConfig(projectDir, config);
  log.info(`Config written to ${configPath}`);
  process.stdout.write(`\nConfig written to ${configPath}\n`);
  process.stdout.write(`\nNext steps:\n  bughunter run\n  # For auto-fix, open a Claude Code session and invoke /bughunt fix\n`);
}

async function resolveInteractive(_projectDir: string): Promise<BugHunterConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const projectName = await rl.question('Project name: ');
  const surfaceMcpUrlRaw = await rl.question('SurfaceMCP URL [http://127.0.0.1:3102]: ');
  const surfaceMcpUrl = surfaceMcpUrlRaw !== '' ? surfaceMcpUrlRaw : 'http://127.0.0.1:3102';
  // browserMcpUrl is optional — blank input leaves it unset, matching non-interactive default.
  const browserMcpUrlRaw = await rl.question('Browser MCP URL (blank to skip): ');
  const resetCommand = await rl.question('Reset command (e.g. npm run db:seed): ');
  const resetPolicyRaw = await rl.question('Reset policy [per-page]: ');
  const resetPolicy = resetPolicyRaw !== '' ? resetPolicyRaw : 'per-page';

  rl.close();

  return {
    projectName,
    surfaceMcpUrl,
    browserMcpUrl: browserMcpUrlRaw !== '' ? browserMcpUrlRaw : undefined,
    resetCommand: resetCommand !== '' ? resetCommand : undefined,
    resetPolicy: resetPolicy as BugHunterConfig['resetPolicy'],
    maxBugs: 200,
    discoveryFixtures: {},
    domainHints: {},
    forbiddenPaths: [],
  };
}

function resolveNonInteractive(projectDir: string, opts: InitOptions): BugHunterConfig {
  const env = process.env;
  const projectName =
    opts.projectName ??
    env['BUGHUNTER_PROJECT_NAME'] ??
    path.basename(projectDir);

  const surfaceMcpUrl =
    opts.surfaceMcpUrl ??
    env['BUGHUNTER_SURFACE_MCP_URL'] ??
    'http://127.0.0.1:3102';

  const browserMcpUrl =
    opts.browserMcpUrl ??
    env['BUGHUNTER_BROWSER_MCP_URL'] ??
    undefined;

  const resetCommand =
    opts.resetCommand ??
    env['BUGHUNTER_RESET_COMMAND'] ??
    undefined;

  const resetPolicy =
    opts.resetPolicy ??
    (env['BUGHUNTER_RESET_POLICY'] as InitOptions['resetPolicy']) ??
    'per-page';

  const candidate = { projectName, surfaceMcpUrl, browserMcpUrl, resetCommand, resetPolicy };
  const result = ConfigSchema.pick({
    projectName: true,
    surfaceMcpUrl: true,
    browserMcpUrl: true,
    resetCommand: true,
    resetPolicy: true,
  }).safeParse(candidate);

  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid .bughunter/config.json: ${issues}`);
  }

  return {
    projectName,
    surfaceMcpUrl,
    browserMcpUrl,
    resetCommand,
    resetPolicy,
    maxBugs: 200,
    discoveryFixtures: {},
    domainHints: {},
    forbiddenPaths: [],
  };
}
