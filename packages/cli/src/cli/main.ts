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
  --route <pattern>           Limit to routes matching glob
  --role <name>               Limit to a single role
  --max-bugs <n>              Stop-and-emit at N clusters (default 200)
  --max-runtime <ms>          Run-level timeout (default 86400000 = 24h)
  --budget <ms>               Time-box the run
  --concurrency <n>           Browser concurrency (default 4)
  --api-concurrency <n>       API concurrency (default 16)
  --reset                     Run resetCommand before discovery
  --resume <runId>            Continue from saved state
  --force-resume              Resume even if SurfaceMCP revision differs
  --include-external          Allow external side-effect API calls

Accessibility / SEO:
  --a11y                      Enable accessibility_critical checks
  --a11y-strict               Enable a11y baseline + keyboard-trap + focus-lost (implies --a11y)
  --seo                       Enable SEO hygiene cluster
  --no-seo-duplicate-titles   Suppress seo_title_duplicate_across_routes detections
  --keyboard-trap-max <n>     Max Tab presses during keyboard trap probe (default 20)
  --form-reachability-timeout <ms>  Max wait for form to appear in probe/execute (default from config)

Performance / heap:
  --enable-perf               Enable web vitals + long task + heap sampling
  --enable-bundle-probe       Enable bundle size probe
  --enable-memory-profile     Enable heap-sample collection (subset of --enable-perf)
  --enable-all-v06            Shortcut for --enable-perf + --enable-bundle-probe + --enable-memory-profile
  --lcp-threshold <ms>        LCP slow threshold (default 2500)
  --inp-threshold <ms>        INP slow threshold (default 200)
  --cls-threshold <n>         CLS threshold (default 0.1)
  --n-plus-one-threshold <n>  N+1 request threshold (default 8)
  --bundle-js-budget <KB>     Initial JS budget gzipped (default 500)
  --bundle-css-budget <KB>    Initial CSS budget gzipped (default 200)
  --enable-heap-attribution   Enable heap diff retainer attribution (implies --enable-memory-profile)
  --no-heap-attribution       Disable heap attribution even if config has it on
  --heap-snapshot-frequency <auto|n>  Snapshot frequency (default 'auto')
  --heap-diff-min-instances <n>  Min instances for diff (default 10)
  --heap-diff-min-bytes <n>   Min bytes for diff (default 5000000)
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
          noSeoDuplicateTitles: flags['no-seo-duplicate-titles'] === true,
          keyboardTrapMax: typeof flags['keyboard-trap-max'] === 'string' ? parseInt(flags['keyboard-trap-max'], 10) : undefined,
          formReachabilityTimeout: typeof flags['form-reachability-timeout'] === 'string' ? parseInt(flags['form-reachability-timeout'], 10) : undefined,
          enableHeapAttribution: flags['enable-heap-attribution'] === true,
          noHeapAttribution: flags['no-heap-attribution'] === true,
          heapSnapshotFrequency: typeof flags['heap-snapshot-frequency'] === 'string'
            ? (flags['heap-snapshot-frequency'] === 'auto' ? 'auto' : parseInt(flags['heap-snapshot-frequency'], 10))
            : undefined,
          heapDiffMinInstances: typeof flags['heap-diff-min-instances'] === 'string' ? parseInt(flags['heap-diff-min-instances'], 10) : undefined,
          heapDiffMinBytes: typeof flags['heap-diff-min-bytes'] === 'string' ? parseInt(flags['heap-diff-min-bytes'], 10) : undefined,
          // v0.19 race-condition flags
          raceConditions: flags['race-conditions'] === true,
          noRaceConditions: flags['no-race-conditions'] === true,
          raceVariants: typeof flags['race-variants'] === 'string' ? flags['race-variants'] : undefined,
          raceCrossTab: flags['race-cross-tab'] === true,
          raceStrict: flags['race-strict'] === true,
          enableNavState: flags['enable-nav-state'] === true,
          navStateRefreshRace: flags['nav-state-refresh-race'] === true,
          enableHistoryCorruption: flags['enable-history-corruption'] === true,
          navStateSkipRoute: typeof flags['nav-state-skip-route'] === 'string' ? flags['nav-state-skip-route'] : undefined,
          navStateDeepLinkMaxDepth: typeof flags['nav-state-deep-link-max-depth'] === 'string' ? parseInt(flags['nav-state-deep-link-max-depth'], 10) : undefined,
          idor: flags['idor'] === true,
          noIdor: flags['no-idor'] === true,
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
        pruneCommand(projectDir);
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
