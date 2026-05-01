#!/usr/bin/env node
// BugHunter CLI entry point.

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
import { diffCommand } from './diff.js';
import { historyCommand } from './history.js';
import { ingestCommand } from './ingest.js';
import { agingCommand } from './aging.js';
import type { BugKind } from '../types.js';
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
  bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind=k|severity=s>]
  bughunter history [--kind <bugkind>] [--bug-identity <id>] [--limit <n>] [--format table|json]
  bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]
  bughunter aging [--threshold <days>] [--min-runs <n>]
  bughunter prune [--rebuild-identity] [--force]

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
  --a11y-strict          Enable a11y baseline + keyboard-trap + focus-lost (implies --a11y)
  --seo                  Enable SEO hygiene cluster
  --keyboard-trap-max=N  Max Tab presses during keyboard trap probe (default 20)
  --no-seo-duplicate-titles  Suppress seo_title_duplicate_across_routes detections
  --include-external              Allow external side-effect API calls
  --form-reachability-timeout <ms>  Max wait for form to appear in probe/execute (default: asyncMaxWaitMs from config)
`;

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const [, , command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = i + 1 < rest.length ? rest[i + 1] : undefined;
      if (next !== undefined && !next.startsWith('--')) {
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
    process.stdout.write(`${USAGE  }\n`);
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
        const enableAll = flags['enable-all-v06'] === true;
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
          enablePerf: flags['enable-perf'] === true || enableAll,
          enableBundleProbe: flags['enable-bundle-probe'] === true || enableAll,
          enableMemoryProfile: flags['enable-memory-profile'] === true || enableAll,
          lcpThreshold: typeof flags['lcp-threshold'] === 'string' ? parseInt(flags['lcp-threshold'], 10) : undefined,
          inpThreshold: typeof flags['inp-threshold'] === 'string' ? parseInt(flags['inp-threshold'], 10) : undefined,
          clsThreshold: typeof flags['cls-threshold'] === 'string' ? parseFloat(flags['cls-threshold']) : undefined,
          nPlusOneThreshold: typeof flags['n-plus-one-threshold'] === 'string' ? parseInt(flags['n-plus-one-threshold'], 10) : undefined,
          bundleJsBudgetKb: typeof flags['bundle-js-budget'] === 'string' ? parseInt(flags['bundle-js-budget'], 10) : undefined,
          bundleCssBudgetKb: typeof flags['bundle-css-budget'] === 'string' ? parseInt(flags['bundle-css-budget'], 10) : undefined,
          a11yStrict: flags['a11y-strict'] === true,
          seoEnabled: flags['seo'] === true,
          keyboardTrapMax: typeof flags['keyboard-trap-max'] === 'string' ? parseInt(flags['keyboard-trap-max'], 10) : undefined,
          formReachabilityTimeout: typeof flags['form-reachability-timeout'] === 'string' ? parseInt(flags['form-reachability-timeout'], 10) : undefined,
          enableHeapAttribution: flags['enable-heap-attribution'] === true,
          noHeapAttribution: flags['no-heap-attribution'] === true,
          heapSnapshotFrequency: typeof flags['heap-snapshot-frequency'] === 'string'
            ? (flags['heap-snapshot-frequency'] === 'auto' ? 'auto' : parseInt(flags['heap-snapshot-frequency'], 10))
            : undefined,
          heapDiffMinInstances: typeof flags['heap-diff-min-instances'] === 'string' ? parseInt(flags['heap-diff-min-instances'], 10) : undefined,
          heapDiffMinBytes: typeof flags['heap-diff-min-bytes'] === 'string' ? parseInt(flags['heap-diff-min-bytes'], 10) : undefined,
        });
        break;
      }

      case 'replay': {
        const replayId = args[0] ?? '';
        if (replayId === '') throw new Error('Usage: bughunter replay <occurrenceId>');
        await replayCommand(projectDir, replayId);
        break;
      }

      case 'inspect': {
        const inspectId = args[0] ?? '';
        if (inspectId === '') throw new Error('Usage: bughunter inspect <occurrenceId|clusterId>');
        inspectCommand(projectDir, inspectId);
        break;
      }

      case 'list':
        listCommand(projectDir);
        break;

      case 'status': {
        const statusRunId = args[0] ?? '';
        if (statusRunId === '') throw new Error('Usage: bughunter status <runId>');
        statusCommand(projectDir, statusRunId);
        break;
      }

      case 'palette':
        paletteCommand(projectDir);
        break;

      case 'prune':
        pruneCommand(projectDir, {
          rebuildIdentity: flags['rebuild-identity'] === true,
          force: flags['force'] === true,
        });
        break;

      case 'forbidden-path-gate': {
        const branch = args[0] ?? '';
        if (branch === '') throw new Error('Usage: bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : 'main';
        const reset = flags['reset'] === true;
        forbiddenPathGateCommand(projectDir, branch, baseBranch, reset);
        break;
      }

      case 'retest': {
        const runId = args[0] ?? '';
        const clusterId = args[1] ?? '';
        if (runId === '' || clusterId === '') throw new Error('Usage: bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : undefined;
        const fixBranch = typeof flags['branch'] === 'string' ? flags['branch'] : undefined;
        await retestCommand(projectDir, runId, clusterId, baseBranch, fixBranch);
        break;
      }

      case 'fix-summary': {
        const runId = args[0] ?? '';
        if (runId === '') throw new Error('Usage: bughunter fix-summary <runId>');
        fixSummaryCommand(projectDir, runId);
        break;
      }

      case 'diff': {
        const runIdOld = args[0] ?? '';
        const runIdNew = args[1] ?? '';
        if (runIdOld === '' || runIdNew === '') {
          throw new Error('Usage: bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind=k>]');
        }
        const diffFormat = typeof flags['format'] === 'string'
          ? (flags['format'] as 'table' | 'json' | 'sarif')
          : undefined;
        const filterRaw = typeof flags['filter'] === 'string' ? flags['filter'] : undefined;
        const filterKind = filterRaw?.startsWith('kind=') === true ? (filterRaw.slice(5) as BugKind) : undefined;
        diffCommand(projectDir, {
          runIdOld,
          runIdNew,
          format: diffFormat,
          filter: filterKind !== undefined ? { kind: filterKind } : undefined,
        });
        break;
      }

      case 'history': {
        const historyFormat = typeof flags['format'] === 'string'
          ? (flags['format'] as 'table' | 'json')
          : undefined;
        historyCommand(projectDir, {
          kind: typeof flags['kind'] === 'string' ? (flags['kind'] as BugKind) : undefined,
          limit: typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : undefined,
          bugIdentity: typeof flags['bug-identity'] === 'string' ? flags['bug-identity'] : undefined,
          format: historyFormat,
        });
        break;
      }

      case 'ingest': {
        const ingestPath = args[0] ?? '';
        if (ingestPath === '') {
          throw new Error('Usage: bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]');
        }
        ingestCommand(projectDir, {
          filePath: ingestPath,
          runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
          projectName: typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined,
        });
        break;
      }

      case 'aging': {
        agingCommand(projectDir, {
          thresholdDays: typeof flags['threshold'] === 'string' ? parseInt(flags['threshold'], 10) : undefined,
          minRuns: typeof flags['min-runs'] === 'string' ? parseInt(flags['min-runs'], 10) : undefined,
        });
        break;
      }

      default:
        process.stdout.write(`${USAGE  }\n`);
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
