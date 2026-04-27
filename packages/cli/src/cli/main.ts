#!/usr/bin/env node
// BugHunter CLI entry point.

import * as path from 'node:path';
import { initCommand } from './init.js';
import type { InitOptions } from './init.js';
import { runCommand } from './run.js';
import { replayCommand } from './replay.js';
import { inspectCommand } from './inspect.js';
import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { pruneCommand } from './prune.js';
import { paletteCommand } from './palette.js';
import { forbiddenPathGateCommand } from './forbidden-path-gate.js';
import { retestCommand } from './retest-cmd.js';
import { fixSummaryCommand } from './fix-summary.js';
import { log } from '../log.js';

const USAGE = `
BugHunter v0.1 — exhaustive UI + API bug hunting for local dev apps

Usage:
  bughunter init [--no-interactive] [--project-name <name>] [--surface-mcp-url <url>]
                 [--browser-mcp-url <url>] [--reset-command <cmd>] [--reset-policy <policy>]
  bughunter run [options]
  bughunter replay <occurrenceId>
  bughunter inspect <occurrenceId|clusterId>
  bughunter list
  bughunter status <runId>
  bughunter palette
  bughunter prune
  bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]
  bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]
  bughunter fix-summary <runId>

Run options:
  --route <pattern>      Limit to routes matching glob
  --role <name>          Limit to a single role
  --max-bugs <n>         Stop-and-emit at N clusters (default 200)
  --max-runtime <ms>     Run-level timeout (default 86400000 = 24h)
  --budget <ms>          Time-box the run
  --concurrency <n>      Browser concurrency (default 4)
  --api-concurrency <n>  API concurrency (default 16)
  --reset                Run resetCommand before discovery
  --resume <runId>       Continue from saved state
  --force-resume         Resume even if SurfaceMCP revision differs
  --a11y                 Enable accessibility_critical checks
  --include-external     Allow external side-effect API calls
`;

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const [, , command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { command, args, flags };
}

async function main(): Promise<void> {
  // Pass-through --help / -h before any other validation so init and other
  // commands that open stdin don't block on the readline prompt.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return;
  }

  const { command, args, flags } = parseArgs(process.argv);
  const projectDir = process.cwd();

  try {
    switch (command) {
      case 'init': {
        const initOpts: InitOptions = {
          noInteractive: flags['no-interactive'] === true,
          projectName: typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined,
          surfaceMcpUrl: typeof flags['surface-mcp-url'] === 'string' ? flags['surface-mcp-url'] : undefined,
          browserMcpUrl: typeof flags['browser-mcp-url'] === 'string' ? flags['browser-mcp-url'] : undefined,
          resetCommand: typeof flags['reset-command'] === 'string' ? flags['reset-command'] : undefined,
          resetPolicy: typeof flags['reset-policy'] === 'string'
            ? (flags['reset-policy'] as InitOptions['resetPolicy'])
            : undefined,
        };
        await initCommand(projectDir, initOpts);
        break;
      }

      case 'run': {
        if (flags['auto-fix'] === true) {
          process.stdout.write(
            'Auto-fix is now invoked from a Claude Code session via the /bughunt fix skill. See SPEC § 3.9.\n',
          );
          return;
        }
        await runCommand({
          projectDir,
          route: typeof flags['route'] === 'string' ? flags['route'] : undefined,
          role: typeof flags['role'] === 'string' ? flags['role'] : undefined,
          maxBugs: typeof flags['max-bugs'] === 'string' ? parseInt(flags['max-bugs'], 10) : undefined,
          maxRuntime: typeof flags['max-runtime'] === 'string' ? parseInt(flags['max-runtime'], 10) : undefined,
          budget: typeof flags['budget'] === 'string' ? parseInt(flags['budget'], 10) : undefined,
          concurrency: typeof flags['concurrency'] === 'string' ? parseInt(flags['concurrency'], 10) : undefined,
          apiConcurrency: typeof flags['api-concurrency'] === 'string' ? parseInt(flags['api-concurrency'], 10) : undefined,
          reset: flags['reset'] === true,
          resume: typeof flags['resume'] === 'string' ? flags['resume'] : undefined,
          forceResume: flags['force-resume'] === true,
          a11y: flags['a11y'] === true,
          includeExternal: flags['include-external'] === true,
          strict: flags['strict'] === true,
        });
        break;
      }

      case 'replay':
        if (!args[0]) throw new Error('Usage: bughunter replay <occurrenceId>');
        await replayCommand(projectDir, args[0]);
        break;

      case 'inspect':
        if (!args[0]) throw new Error('Usage: bughunter inspect <occurrenceId|clusterId>');
        inspectCommand(projectDir, args[0]);
        break;

      case 'list':
        listCommand(projectDir);
        break;

      case 'status':
        if (!args[0]) throw new Error('Usage: bughunter status <runId>');
        statusCommand(projectDir, args[0]);
        break;

      case 'palette':
        paletteCommand(projectDir);
        break;

      case 'prune':
        pruneCommand(projectDir);
        break;

      case 'forbidden-path-gate': {
        const branch = args[0];
        if (!branch) throw new Error('Usage: bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : 'main';
        const reset = flags['reset'] === true;
        forbiddenPathGateCommand(projectDir, branch, baseBranch, reset);
        break;
      }

      case 'retest': {
        const [runId, clusterId] = args;
        if (!runId || !clusterId) throw new Error('Usage: bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : undefined;
        const fixBranch = typeof flags['branch'] === 'string' ? flags['branch'] : undefined;
        await retestCommand(projectDir, runId, clusterId, baseBranch, fixBranch);
        break;
      }

      case 'fix-summary': {
        const runId = args[0];
        if (!runId) throw new Error('Usage: bughunter fix-summary <runId>');
        fixSummaryCommand(projectDir, runId);
        break;
      }

      default:
        process.stdout.write(USAGE + '\n');
        break;
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main().catch(err => {
  log.error('Unexpected error', err);
  process.exit(1);
});
