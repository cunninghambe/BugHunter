// bughunter init — walks project, writes .bughunter/config.json template.

import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveConfig } from '../config.js';
import type { BugHunterConfig } from '../types.js';
import { log } from '../log.js';

export async function initCommand(projectDir: string): Promise<void> {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');
  if (fs.existsSync(configPath)) {
    log.warn(`.bughunter/config.json already exists at ${configPath}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const projectName = await rl.question('Project name: ');
  const surfaceMcpUrl = await rl.question('SurfaceMCP URL [http://127.0.0.1:3102/mcp]: ') || 'http://127.0.0.1:3102/mcp';
  const browserMcpUrl = await rl.question('Browser MCP URL [http://127.0.0.1:3100/mcp]: ') || 'http://127.0.0.1:3100/mcp';
  const claudeMcpUrl = await rl.question('ClaudeMCP URL (optional, for --auto-fix) [http://127.0.0.1:3101/mcp]: ') || 'http://127.0.0.1:3101/mcp';
  const resetCommand = await rl.question('Reset command (e.g. npm run db:seed): ');
  const resetPolicy = await rl.question('Reset policy [per-page]: ') || 'per-page';

  rl.close();

  const config: BugHunterConfig = {
    projectName,
    surfaceMcpUrl,
    browserMcpUrl: browserMcpUrl || undefined,
    claudeMcpUrl: claudeMcpUrl || undefined,
    resetCommand: resetCommand || undefined,
    resetPolicy: (resetPolicy as BugHunterConfig['resetPolicy']) || 'per-page',
    maxBugs: 200,
    discoveryFixtures: {},
    domainHints: {},
    forbiddenPaths: [],
  };

  saveConfig(projectDir, config);
  log.info(`Config written to ${configPath}`);
  process.stdout.write(`\nConfig written to ${configPath}\n`);
  process.stdout.write(`\nNext steps:\n  bughunter run\n  bughunter run --auto-fix\n`);
}
