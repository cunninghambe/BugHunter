#!/usr/bin/env node
// BugHunter CLI entry point.

import * as path from 'node:path';
import { initCommand } from './init.js';
import { runCommand } from './run.js';
import { replayCommand } from './replay.js';
import { inspectCommand } from './inspect.js';
import { fixCommand } from './fix.js';
import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { pruneCommand } from './prune.js';
import { paletteCommand } from './palette.js';
import { log } from '../log.js';

const USAGE = `
BugHunter v0.1 — exhaustive UI + API bug hunting for local dev apps

Usage:
  bughunter init
  bughunter run [options]
  bughunter replay <occurrenceId>
  bughunter inspect <occurrenceId|clusterId>
  bughunter fix
  bughunter list
  bughunter status <runId>
  bughunter palette
  bughunter prune

Run options:
  --auto-fix             Dispatch per-cluster fixes via ClaudeMCP after run
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
      case 'init':
        await initCommand(projectDir);
        break;

      case 'run':
        await runCommand({
          projectDir,
          autoFix: flags['auto-fix'] === true,
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

      case 'replay':
        if (!args[0]) throw new Error('Usage: bughunter replay <occurrenceId>');
        await replayCommand(projectDir, args[0]);
        break;

      case 'inspect':
        if (!args[0]) throw new Error('Usage: bughunter inspect <occurrenceId|clusterId>');
        inspectCommand(projectDir, args[0]);
        break;

      case 'fix':
        await fixCommand(projectDir);
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
